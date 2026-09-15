// Empaqueta `apps/api/src/vercel.ts` (entrypoint real de la función serverless) en un
// único archivo JS plano (`api/index.js`) con esbuild, en vez de dejar que Vercel
// intente ejecutar/rastrear el `.ts` directamente en runtime.
//
// Por qué hace falta esto (encontrado real en producción, no un supuesto): la función
// serverless de Node.js de Vercel usa el soporte NATIVO de "type stripping" de
// Node.js (quitar anotaciones de tipo por sintaxis, sin transformación semántica real)
// para ejecutar `.ts` directamente -- ese modo NO soporta "parameter properties" de
// TypeScript (`constructor(private readonly db: X) {}`), un patrón usado en varios
// repositorios de dominio de este monorepo (ver p.ej. packages/db/src/
// postgres-core-repository.ts). El primer intento de deploy real falló en runtime con
// `ERR_MODULE_NOT_FOUND`/`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` -- Vercel no pudo incluir
// ni ejecutar el árbol de imports `.ts` real del monorepo tal cual.
//
// La solución: compilar TODO el árbol de imports (paquetes del workspace incluidos, no
// solo node_modules externos) a un solo `.js` de antemano, en build time -- así en
// runtime Node solo ejecuta JavaScript plano, sin ninguna sintaxis de TypeScript que
// stripping nativo pueda rechazar.
//
// `api/index.js` SÍ está versionado en git (ver el comentario de cabecera de ese
// mismo archivo y de `.gitignore`) -- Vercel valida `vercel.json::functions` contra
// el árbol de archivos tal como lo clona de git, ANTES de correr este script; sin un
// archivo ya presente en esa ruta, ningún deploy real llega siquiera a ejecutar este
// build (hallazgo real de infraestructura, 2026-09-15 -- todo deploy de la sesión
// anterior falló exactamente así). Este script SIEMPRE sobreescribe ese placeholder
// con el bundle real.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("api", { recursive: true });

await build({
  entryPoints: ["apps/api/src/vercel.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "api/index.js",
  // Todo se empaqueta -- incluidos los paquetes del workspace (@atiende/*), que de
  // otro modo esbuild trataría como "externos" por resolverse vía node_modules
  // (symlinks de npm workspaces) y dejaría sin compilar, reintroduciendo el mismo
  // problema. Las dependencias reales de npm (pg, hono, jose, etc.) quedan también
  // incluidas -- es un bundle 100% autocontenido, sin ambigüedad posible sobre qué
  // se resolvió en runtime.
  logLevel: "info",
  // `pg` (y probablemente otras deps de npm empaquetadas) son CommonJS y usan
  // `require(...)` internamente para built-ins de Node (p.ej. "events") -- un bundle
  // ESM real no tiene `require` disponible de forma nativa, así que esbuild deja una
  // llamada a `require` que revienta en runtime con "Dynamic require ... is not
  // supported" (error real encontrado en el primer intento de este fix). Fix estándar
  // y documentado de esbuild para este caso exacto: inyectar un `require` real vía
  // `createRequire` al inicio del bundle.
  banner: {
    js: "import { createRequire as __atiendeCreateRequire } from 'node:module'; const require = __atiendeCreateRequire(import.meta.url);",
  },
});
