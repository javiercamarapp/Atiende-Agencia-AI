// Ejecuta verify-go-live.ts empaquetado con esbuild (ya es dependencia del repo): importa los repositorios de @atiende/db, que usan "parameter
// properties", algo que `--experimental-strip-types` de Node 22 NO soporta (mismo motivo y mismo patron que scripts/seed-pm-demo/ejecutar.mjs).
// `pg` se resuelve de node_modules en tiempo de ejecucion.
//
//   GO_LIVE_DATABASE_URL=postgresql://... npm run verify:go-live -- --org <slug> --superadmin <uuid> [--env-file <ruta>]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const cacheDir = path.join(REPO_ROOT, "node_modules", ".cache", "atiende-go-live");
mkdirSync(cacheDir, { recursive: true });
const salida = path.join(cacheDir, "verify-go-live.mjs");
await build({
  entryPoints: [path.join(HERE, "verify-go-live.ts")],
  outfile: salida,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["pg"],
  logLevel: "error",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
process.argv = [process.argv[0], salida, ...process.argv.slice(2)];
await import(salida);
