# Consulta JCR por DOI

Requiere Node.js 18 o superior. No necesita acceder al repositorio cvn-cli. Instala la dependencia con `npm install` en este directorio.

```sh
npm install
export JCR_PSSID='valor_de_la_cookie_PSSID'
node jcr.js --doi 10.1016/j.softx.2026.102834
node jcr.js --doi 10.1016/j.softx.2026.102834 --year 2025 --quiet > resultado.json
```

Para obtener `JCR_PSSID`, inicia sesión en https://jcr.clarivate.com y abre las herramientas de desarrollo del navegador: **Application → Cookies → https://jcr.clarivate.com**. Copia el valor de la cookie `PSSID` y asígnalo a la variable de entorno `JCR_PSSID` como en el ejemplo. 

Desde la consola del navegador, puedes obtenerlo con:
```js
document.cookie
  .split(";")
  .find(e => e.trim().startsWith("PSSID="))
  ?.trim()
  .split("=")
  .slice(1)
````

También puedes guardar la cookie en un archivo `.env` junto a `jcr.js` (en esta demo, `/tmp/jcr/.env`):

```dotenv
JCR_PSSID='valor_de_la_cookie_PSSID'
```

Después ejecuta `node jcr.js --doi <DOI>` sin necesidad de hacer `export`. El archivo se carga automáticamente, incluso si ejecutas el script desde otro directorio. Si `JCR_PSSID` ya está definida en el entorno, tiene prioridad sobre `.env`. Para usar el valor del archivo, ejecuta antes `unset JCR_PSSID`.

Puedes copiar `.env.example` a `.env` y sustituir el valor de ejemplo. No se incluyen credenciales reales.

Devuelve JSON por stdout y progreso/errores por stderr. Incluye DOI, revista, ISSN, eISSN, año JCR, factor de impacto, categoría principal, posición, número de revistas, cuartil, percentil, dentro25 y todas las categorías. La categoría principal es la más favorable, con la misma lógica de cvn-cli.

Códigos de salida: 0 éxito, 1 error, 2 DOI o revista no encontrados (stdout: `null`). Consulta `node jcr.js --help`.

También se puede importar:

```js
import { fetchJcrData } from './jcr.js';
const data = await fetchJcrData('10.xxxx/xxxxx', { year: 2024, quiet: true });
```
