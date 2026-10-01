// Ejecuta un script TypeScript (seed-volumen.ts, generador de assertions del verify) que importa repositorios con "parameter properties", algo que el modo
// `--experimental-strip-types` de Node 22 NO soporta. Empaqueta el script con esbuild (ya es dependencia del repo) a
// node_modules/.cache y lo ejecuta con los mismos argumentos. `pg` se resuelve de node_modules en tiempo de ejecucion.
//
//   node scripts/seed-pm-demo/ejecutar.mjs seed-volumen [--escala=ligero] [--apply ...]
//   node scripts/seed-pm-demo/ejecutar.mjs verify-demo-volumen          (regenera scripts/verify-restaurantes-demo-volumen/assertions.sql)
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SCRIPTS = {
  "seed-volumen": path.join(HERE, "seed-volumen.ts"),
  "verify-demo-volumen": path.join(REPO_ROOT, "scripts", "verify-restaurantes-demo-volumen", "generar-assertions.ts"),
};
const PERMITIDOS = new Set(Object.keys(SCRIPTS));

const [nombre, ...resto] = process.argv.slice(2);
if (!nombre || !PERMITIDOS.has(nombre)) {
  console.error(`Uso: node scripts/seed-pm-demo/ejecutar.mjs <${[...PERMITIDOS].join("|")}> [argumentos del script]`);
  process.exit(2);
}
const cacheDir = path.join(REPO_ROOT, "node_modules", ".cache", "atiende-seed");
mkdirSync(cacheDir, { recursive: true });
const salida = path.join(cacheDir, `${nombre}.mjs`);
await build({
  entryPoints: [SCRIPTS[nombre]],
  outfile: salida,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["pg"],
  logLevel: "error",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
process.env.ATIENDE_SEED_DIR = HERE;
process.argv = [process.argv[0], salida, ...resto];
await import(salida);
