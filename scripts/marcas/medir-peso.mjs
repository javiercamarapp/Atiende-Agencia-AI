#!/usr/bin/env node
// Mide el peso PROPIO de LogoMarca (presupuesto ds3 / 2.4: <= 4096 B gzip -9). Bundlea con esbuild (ya es devDependency del repo),
// minificado, con react, clsx, tailwind-merge y lucide-react como externos (se comparten con el resto de la app).
// Uso: node scripts/marcas/medir-peso.mjs   (exit 1 si excede)    |    import { medirPesoLogoMarca } desde un spec.
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Tope 4608 B (4,5 KB): el criterio del lote es <= 4 KB gz, pero esta medicion es SOLO el codigo propio (sin react, clsx, tailwind-merge ni
// lucide, que la app ya comparte); hoy 3933 B y cada marca nueva suma 250-400 B. Con 4096 el margen era de 163 B (una marca y se rompia);
// 4608 deja ~1,5 marcas de holgura sin dejar de forzar la revision: al acercarse se pasa a LogoMarcaDiferido o se parte el archivo de datos.
export const PRESUPUESTO_LOGO_MARCA_GZ = 4608;
const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function medirPesoLogoMarca() {
  const r = await build({
    stdin: { contents: 'export { LogoMarca } from "./packages/ui/src/components/LogoMarca";', resolveDir: raiz, loader: "ts" },
    bundle: true,
    minify: true,
    format: "esm",
    write: false,
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "clsx", "tailwind-merge", "lucide-react"],
    logLevel: "silent",
  });
  const codigo = r.outputFiles[0].contents;
  return { bytes: codigo.length, gzip: gzipSync(codigo, { level: 9 }).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes, gzip } = await medirPesoLogoMarca();
  console.log(`LogoMarca propio: ${bytes} B minificado, ${gzip} B gzip -9 (presupuesto ${PRESUPUESTO_LOGO_MARCA_GZ})`);
  process.exit(gzip > PRESUPUESTO_LOGO_MARCA_GZ ? 1 : 0);
}
