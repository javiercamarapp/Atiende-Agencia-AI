// check-bundle-budget.ts (R-37) — presupuesto de bundle por ruta.
// Lee apps/web/bundle-manifest.json (vite `build.manifest`, fuera de dist para que no se publique), calcula para cada ruta del presupuesto el JS que el
// navegador descarga antes de pintarla (chunk de la ruta + cierre transitivo de `imports` estaticos, sin los
// `dynamicImports`, que son otras rutas) en bytes gzip, y falla si alguna supera su tope. No modifica nada.
//
// Uso: node --experimental-strip-types scripts/verify-bundle-budget/check-bundle-budget.ts [distDir] [budget.json]
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ManifestEntry = { file: string; imports?: string[]; dynamicImports?: string[]; isEntry?: boolean };
export type Manifest = Record<string, ManifestEntry>;
export type RutaPresupuesto = { clave: string; nombre: string; maxGzipBytes: number };
export type Presupuesto = { rutas: RutaPresupuesto[] };
export type ResultadoRuta = { clave: string; nombre: string; gzipBytes: number; maxGzipBytes: number; chunks: number; ok: boolean };

/** Chunks JS descargados por una ruta: ella misma + sus imports estaticos transitivos (sin duplicados). */
export function chunksDeRuta(manifest: Manifest, clave: string): string[] {
  if (!manifest[clave]) throw new Error(`la ruta "${clave}" no esta en el manifiesto de Vite (¿cambio de nombre o ruta eliminada?)`);
  const vistos = new Set<string>();
  const pila = [clave];
  while (pila.length > 0) {
    const k = pila.pop() as string;
    if (vistos.has(k)) continue;
    const e = manifest[k];
    if (!e) throw new Error(`el manifiesto referencia "${k}" que no existe`);
    vistos.add(k);
    for (const i of e.imports ?? []) pila.push(i);
  }
  return [...vistos].filter((k) => manifest[k]!.file.endsWith(".js")).map((k) => manifest[k]!.file);
}

export function evaluarPresupuesto(
  manifest: Manifest,
  presupuesto: Presupuesto,
  tamanoGzip: (archivo: string) => number,
): ResultadoRuta[] {
  return presupuesto.rutas.map((r) => {
    const chunks = chunksDeRuta(manifest, r.clave);
    const gzipBytes = chunks.reduce((s, f) => s + tamanoGzip(f), 0);
    return { clave: r.clave, nombre: r.nombre, gzipBytes, maxGzipBytes: r.maxGzipBytes, chunks: chunks.length, ok: gzipBytes <= r.maxGzipBytes };
  });
}

function main(): number {
  const aqui = dirname(fileURLToPath(import.meta.url));
  const dist = resolve(process.argv[2] ?? join(aqui, "../../apps/web/dist"));
  const presupuestoPath = resolve(process.argv[3] ?? join(aqui, "budget.json"));
  const manifestPath = resolve(process.argv[4] ?? join(dist, "..", "bundle-manifest.json"));
  if (!existsSync(manifestPath)) {
    console.error(`FALLA: no existe ${manifestPath}. Corre antes: npm run build --workspace apps/web`);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const presupuesto = JSON.parse(readFileSync(presupuestoPath, "utf8")) as Presupuesto;
  const res = evaluarPresupuesto(manifest, presupuesto, (f) => gzipSync(readFileSync(join(dist, f)), { level: 6 }).length);
  for (const r of res) {
    const kb = (n: number) => (n / 1024).toFixed(1);
    console.log(`${r.ok ? "OK    " : "EXCEDE"} ${r.nombre}: ${kb(r.gzipBytes)} KiB gzip / tope ${kb(r.maxGzipBytes)} KiB (${r.chunks} chunks)`);
  }
  const malas = res.filter((r) => !r.ok);
  if (malas.length > 0) {
    console.error(`FALLA: ${malas.length} ruta(s) exceden el presupuesto de bundle (scripts/verify-bundle-budget/budget.json).`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
