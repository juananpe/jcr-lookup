/**
 * JCR (Journal Citation Reports, Clarivate) impact-factor lookup.
 *
 * Given a DOI, resolves its ISSN and default publication year via CrossRef,
 * then queries the Clarivate JCR API for that year. CVN update flows pass the
 * year stored in the CVN record as an explicit override: CrossRef may expose a
 * later issue/volume year for an article published online the previous year.
 *
 * The returned object feeds the CVN "Índice de impacto" sub-form of a publication
 * (section 060.010.010.000). Standalone extraction from cvn-cli.
 *
 * Authentication: the Clarivate session cookie `PSSID`
 * is sent as the `x-1p-inc-sid` request header. It comes from the `JCR_PSSID`
 * environment variable or from `~/.cvn-cli/clarivate.json`, which the companion
 * Chrome extension refreshes in the same click that captures the CVN cookies.
 *
 * @example
 *   import { fetchJcrData } from "./jcr.js";
 *   const jcr = await fetchJcrData("10.1109/MS.2024.1234567");
 *   // → { journalName, year, indiceImpacto, categoria, posicion, numRevistas,
 *   //     quartile, dentro25, categorias: [...] }
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parseArgs } from "node:util";

// Resolve relative to this script, even when invoked from another directory.
const envResult = dotenv.config({
  path: fileURLToPath(new URL(".env", import.meta.url)),
  override: false,
  quiet: true,
});
if (envResult.error && envResult.error.code !== "ENOENT") {
  throw new Error(`No se pudo leer el archivo .env: ${envResult.error.code || "error de lectura"}`);
}

function normalizePssid(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (
    trimmed.length > 1 &&
    trimmed.startsWith('"') &&
    trimmed.endsWith('"')
  ) {
    return trimmed;
  }
  return `"${trimmed.replace(/"/g, "")}"`;
}

function loadClarivateCache() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".cvn-cli", "clarivate.json"), "utf8"));
  } catch {
    return null;
  }
}

const CROSSREF_API = "https://api.crossref.org/works/";
const JCR_BASE = "https://jcr.clarivate.com/api/jcr3";
const JCR_HOME = "https://jcr.clarivate.com/jcr/home?Init=Yes&SrcApp=IC2LS";

/**
 * Default publication year to fall back to when CrossRef has no date.
 * Falls back to the latest JCR year reported by search-suggestion at runtime.
 */

// --- session / auth ---------------------------------------------------------

/**
 * Resolve the Clarivate session token (PSSID).
 *
 * Priority: explicit option → `JCR_PSSID` environment variable → the
 * `~/.cvn-cli/clarivate.json` cache written by the companion Chrome extension.
 * The value is normalized to the quoted-string form the API expects.
 *
 * @param {object} [opts]
 * @param {string} [opts.pssid] - Explicit PSSID override (also via JCR_PSSID env).
 * @returns {Promise<string>} The PSSID value (WITH surrounding quotes — sent as-is).
 * @throws {Error} If no PSSID can be found.
 */
export async function resolvePssid(opts = {}) {
  const fromEnv = opts.pssid || process.env.JCR_PSSID;
  const envPssid = fromEnv ? normalizePssid(fromEnv) : "";
  if (envPssid) return envPssid;

  const cached = loadClarivateCache();
  const cachedPssid = cached?.pssid ? normalizePssid(cached.pssid) : "";
  if (cachedPssid) return cachedPssid;

  throw new Error(
    "No Clarivate session found. Log in at https://jcr.clarivate.com and click " +
      "the CVN CLI Authentication Chrome extension (it captures the PSSID " +
      "cookie), or set the JCR_PSSID environment variable.",
  );
}

/**
 * Build the standard request headers for the JCR API.
 * @param {string} pssid - PSSID value (with quotes).
 * @returns {object} fetch headers
 */
function jcrHeaders(pssid) {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    referer: JCR_HOME,
    "x-1p-inc-sid": pssid,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };
}

// --- low-level JCR endpoints ------------------------------------------------

/**
 * Search a journal by ISSN or name.
 * @param {string} query - ISSN (e.g. "1937-4194") or journal name.
 * @param {object} headers - JCR request headers (with x-1p-inc-sid).
 * @returns {Promise<object|null>} First match: `{journalName, jcrYear, title, issn, eissn}` or null.
 */
export async function searchJournal(query, headers) {
  const url =
    `${JCR_BASE}/bwjournal/v1/search-suggestion` +
    `?query=${encodeURIComponent(query)}&isTrialUser=no`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`search-suggestion failed: HTTP ${resp.status} for "${query}"`);
  }
  const json = await resp.json();
  const journals = json?.data?.journals || [];
  return journals.length ? journals[0] : null;
}

/**
 * Fetch the Journal Impact Factor value for a journal + year.
 * @param {string} journalName - Canonical JCR journal name (from searchJournal).
 * @param {string|number} year - JCR year (publication year).
 * @param {object} headers
 * @returns {Promise<string|null>} JIF string (e.g. "3.6") or null if unavailable.
 */
export async function getJifValue(journalName, year, headers) {
  const resp = await fetch(`${JCR_BASE}/journalprofile/v1/jif-values`, {
    method: "POST",
    headers,
    body: JSON.stringify({ journal: journalName, year: String(year) }),
  });
  if (!resp.ok) {
    throw new Error(`jif-values failed: HTTP ${resp.status}`);
  }
  const json = await resp.json();
  // data[0].withSelfCites.impactCurrent is the JIF; withoutSelfCites is the JIF minus self-cites.
  const withSelf = json?.data?.[0]?.withSelfCites;
  return withSelf?.impactCurrent != null ? String(withSelf.impactCurrent) : null;
}

/**
 * Fetch per-category rank-by-JIF data for a journal.
 *
 * @param {string} journalName
 * @param {object} headers
 * @returns {Promise<object[]>} Array of category records, each:
 *   `{edition, category, categoryYear, rankByJif[], combinedRankByJif[]}`
 *   where each rank entry is `{year, rank:"40/108", quartile:"Q2", jifPercentile:"63.4"}`.
 */
export async function getRankByJif(journalName, headers) {
  const resp = await fetch(`${JCR_BASE}/journalprofile/v1/rank-byjif`, {
    method: "POST",
    headers,
    body: JSON.stringify({ journal: journalName }),
  });
  if (!resp.ok) {
    throw new Error(`rank-byjif failed: HTTP ${resp.status}`);
  }
  const json = await resp.json();
  return json?.data || [];
}

// --- helpers ----------------------------------------------------------------

/**
 * Parse a "rank/total" string like "40/108" into {posicion, numRevistas}.
 * @param {string} rank
 * @returns {{posicion:number|null, numRevistas:number|null}}
 */
function parseRank(rank) {
  if (!rank || typeof rank !== "string" || rank.toUpperCase() === "N/A") {
    return { posicion: null, numRevistas: null };
  }
  const [pos, total] = rank.split("/");
  return {
    posicion: pos && /^\d+$/.test(pos) ? Number(pos) : null,
    numRevistas: total && /^\d+$/.test(total) ? Number(total) : null,
  };
}

/**
 * Find a rank entry for `year`, checking recent (combined) then historical arrays.
 * @param {object} catRec - One category record from getRankByJif.
 * @param {string} year
 * @returns {object|null} The matching `{year, rank, quartile, jifPercentile}` or null.
 */
function findRankEntry(catRec, year) {
  const y = String(year);
  const recent = catRec.combinedRankByJif || [];
  const historical = catRec.rankByJif || [];
  return (
    recent.find((e) => String(e.year) === y) ||
    historical.find((e) => String(e.year) === y) ||
    null
  );
}

/**
 * Pick the best JCR year for a publication year: exact match if data exists,
 * otherwise fall back to the latest available JCR year (JIF may not yet exist
 * for the current calendar year).
 *
 * @param {number} pubYear - Publication year.
 * @param {string} latestJcrYear - Latest JCR year from search-suggestion.
 * @param {object[]} rankData - Output of getRankByJif (to probe available years).
 * @returns {number}
 */
function chooseJcrYear(pubYear, latestJcrYear, rankData) {
  const latest = Number(latestJcrYear) || new Date().getFullYear();
  // Cap at the latest available JCR year.
  let y = pubYear > latest ? latest : pubYear;
  const probe = new Set();
  for (const cat of rankData) {
    for (const e of cat.combinedRankByJif || []) probe.add(String(e.year));
    for (const e of cat.rankByJif || []) probe.add(String(e.year));
  }
  // If the chosen year has no rank data, walk backwards to the nearest year that does.
  let fallback = y;
  while (fallback > 1997 && !probe.has(String(fallback))) fallback--;
  return fallback;
}

/**
 * Select the most favourable category for a journal in a given JCR year.
 * Clarivate does not guarantee that categories are returned best-first, so
 * using categorias[0] can retain a Q2/Q3 row even when the journal is Q1 in
 * another category. Prefer the lowest quartile number and, within the same
 * quartile, the highest JIF percentile.
 *
 * @param {object[]} categorias
 * @returns {object|null}
 */
export function selectBestJcrCategory(categorias) {
  if (!Array.isArray(categorias) || !categorias.length) return null;

  const quartileOrder = (quartile) => {
    const match = String(quartile || "")
      .toUpperCase()
      .match(/^Q([1-4])$/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };
  const percentile = (value) => {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : Number.NEGATIVE_INFINITY;
  };

  return categorias.reduce((best, candidate) => {
    if (!best) return candidate;
    const quartileDiff =
      quartileOrder(candidate.quartile) - quartileOrder(best.quartile);
    if (quartileDiff < 0) return candidate;
    if (quartileDiff > 0) return best;

    const percentileDiff =
      percentile(candidate.jifPercentile) - percentile(best.jifPercentile);
    if (percentileDiff > 0) return candidate;
    if (percentileDiff < 0) return best;

    // Stable final tie-breaker for responses without a percentile.
    const candidateRatio =
      Number(candidate.posicion) / Number(candidate.numRevistas);
    const bestRatio = Number(best.posicion) / Number(best.numRevistas);
    if (Number.isFinite(candidateRatio) && candidateRatio < bestRatio) {
      return candidate;
    }
    return best;
  }, null);
}

// --- CrossRef (DOI → ISSN + year) ------------------------------------------

/**
 * Minimal CrossRef lookup: extract ISSN list + publication year for a DOI.
 *
 * @param {string} doi
 * @returns {Promise<{issn:string[], year:number, title:string, container:string}|null>}
 */
export async function getDoiIssnAndYear(doi) {
  const cleanDoi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
  const resp = await fetch(`${CROSSREF_API}${encodeURIComponent(cleanDoi)}`, {
    headers: {
      "User-Agent": "cvn-cli/0.1.0 (mailto:cvn-cli@example.com)",
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(`CrossRef lookup failed: HTTP ${resp.status} for ${cleanDoi}`);
  }
  const json = await resp.json();
  const msg = json?.message;
  if (!msg) return null;

  const dateParts =
    msg["published-print"]?.["date-parts"]?.[0] ||
    msg["published-online"]?.["date-parts"]?.[0] ||
    msg.created?.["date-parts"]?.[0] ||
    [];
  const year = dateParts[0] ? Number(dateParts[0]) : null;

  // CrossRef stores ISSNs without dashes sometimes; keep them as-is.
  const issn = Array.isArray(msg.ISSN) ? msg.ISSN.slice() : [];

  return {
    issn,
    year,
    title: msg.title?.[0] || "",
    container: msg["container-title"]?.[0] || "",
    doi: cleanDoi,
  };
}

// --- main entry point -------------------------------------------------------

/**
 * Fetch JCR impact-factor data for a publication identified by its DOI.
 *
 * @param {string} doi - The publication DOI (URL prefix optional).
 * @param {object} [opts]
 * @param {string} [opts.pssid] - Explicit PSSID (otherwise JCR_PSSID env).
 * @param {number} [opts.year]  - Override the JCR year (defaults to the publication year).
 * @param {boolean} [opts.quiet] - Suppress progress logging.
 * @returns {Promise<object|null>} JCR data object, or null if not found.
 *   Shape:
 *   {
 *     doi, journalName, issn, eissn, year,
 *     indiceImpacto: "3.6",            // JIF string (field 060.010.010.180)
 *     categoria: "COMPUTER SCIENCE, SOFTWARE ENGINEERING",  // primary (field .240)
 *     posicion: 40, numRevistas: 108,  // rank split (fields .250, .260)
 *     quartile: "Q2", jifPercentile: "63.4",
 *     dentro25: false,                // Q1 == top 25% == SÍ (field .330)
 *     categorias: [ {categoria, posicion, numRevistas, quartile, jifPercentile, dentro25}, ... ]
 *   }
 */
export async function fetchJcrData(doi, opts = {}) {
  const log = opts.quiet
    ? () => {}
    : (m) => console.error(`  ${m}`);

  // 1. DOI → ISSN + publication year (CrossRef).
  log(`🔍 CrossRef lookup: ${doi}`);
  const cr = await getDoiIssnAndYear(doi);
  if (!cr) {
    log("❌ DOI not found in CrossRef");
    return null;
  }
  if (!cr.issn.length) {
    log(`❌ No ISSN in CrossRef metadata for "${(cr.title || "").slice(0, 60)}"`);
    return null;
  }
  log(`   → "${(cr.title || cr.container).slice(0, 70)}"`);
  log(`   → ISSN: ${cr.issn.join(", ")} | year: ${cr.year ?? "?"}`);

  // 2. Resolve JCR session.
  const pssid = await resolvePssid(opts);
  const headers = jcrHeaders(pssid);

  // 3. Find the journal in JCR by ISSN (fall back to container name).
  let journal = null;
  for (const issn of cr.issn) {
    journal = await searchJournal(issn, headers);
    if (journal) break;
  }
  if (!journal && cr.container) {
    journal = await searchJournal(cr.container, headers);
  }
  if (!journal) {
    log(`❌ Journal not found in JCR (tried: ${cr.issn.join(", ") || cr.container})`);
    return null;
  }
  log(`   → JCR journal: "${journal.journalName}" (${journal.jcrYear})`);

  // 4. Pick the JCR year: the publication year (or an explicit override), capped
  //    to the latest published JCR edition. A publication dated in the current
  //    calendar year has no JCR edition yet, so fall back to the most recent
  //    edition that actually has ranking data.
  const rankData = await getRankByJif(journal.journalName, headers);
  const pubYear = opts.year
    ? Number(opts.year)
    : cr.year || Number(journal.jcrYear);
  const jcrYear = chooseJcrYear(pubYear, journal.jcrYear, rankData);
  log(
    `   → JCR year: ${jcrYear}` +
      (pubYear && pubYear !== jcrYear
        ? ` (no JCR data for ${pubYear}; using latest available)`
        : ""),
  );

  // 5. JIF value for the year.
  const indiceImpacto = await getJifValue(journal.journalName, jcrYear, headers);
  if (indiceImpacto) log(`   → JIF ${jcrYear}: ${indiceImpacto}`);

  // 6. Build per-category rows for the year (skip defunct categories with no
  //    ranking for this year — they report quartile "N/A" and no rank).
  const categorias = [];
  for (const catRec of rankData) {
    const entry = findRankEntry(catRec, jcrYear);
    if (!entry) continue; // category has no ranking for this year
    const { posicion, numRevistas } = parseRank(entry.rank);
    const isNa =
      (entry.quartile || "").toUpperCase() === "N/A" || posicion == null;
    if (isNa) continue; // category existed historically but not in this year
    const dentro25 = entry.quartile === "Q1";
    categorias.push({
      categoria: catRec.category,
      posicion,
      numRevistas,
      quartile: entry.quartile,
      jifPercentile: entry.jifPercentile,
      dentro25,
    });
  }

  if (!categorias.length) {
    log(`⚠️  No category ranking found for ${jcrYear}; data may be incomplete`);
  }

  // Clarivate's response order is not a quality ranking. Use the journal's
  // strongest category (Q1 before Q2, etc.; best percentile as tie-breaker).
  const primary = selectBestJcrCategory(categorias) || {
    categoria: null,
    posicion: null,
    numRevistas: null,
    quartile: null,
    jifPercentile: null,
    dentro25: null,
  };

  return {
    doi: cr.doi,
    journalName: journal.journalName,
    issn: journal.issn || cr.issn[0] || null,
    eissn: journal.eissn || null,
    year: jcrYear,
    indiceImpacto,
    categoria: primary.categoria,
    posicion: primary.posicion,
    numRevistas: primary.numRevistas,
    quartile: primary.quartile,
    jifPercentile: primary.jifPercentile,
    dentro25: primary.dentro25,
    categorias,
  };
}


// Run as a CLI, while keeping the lookup functions importable.
async function main() {
  const { values } = parseArgs({
    options: {
      doi: { type: "string" },
      year: { type: "string" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Uso: node jcr.js --doi <DOI> [--year <año>] [--quiet]

Devuelve los datos JCR en JSON por stdout; progreso y errores por stderr.
Autenticación: JCR_PSSID en el entorno o en el .env junto a jcr.js.
El entorno tiene prioridad sobre .env.
--year permite usar el año registrado en CVN en lugar del de CrossRef.
Si no hay datos para ese año, se busca un año anterior disponible.
Códigos de salida: 0 éxito; 1 error; 2 DOI o revista no encontrados.`);
    return;
  }
  if (!values.doi?.trim()) {
    throw new Error("Falta --doi <DOI>. Consulta node jcr.js --help.");
  }
  if (values.year !== undefined && !/^[1-9][0-9]{3}$/.test(values.year)) {
    throw new Error("--year debe ser un año de cuatro cifras.");
  }
  const data = await fetchJcrData(values.doi.trim(), {
    year: values.year ? Number(values.year) : undefined,
    quiet: values.quiet,
  });
  console.log(JSON.stringify(data, null, 2));
  if (data === null) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
