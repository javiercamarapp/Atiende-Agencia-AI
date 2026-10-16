// Genera, desde scripts/seed-pm-demo/data/pm-seed-data.json, el SQL de carga y el de verificacion de la cobertura de colonias (radio de 8 km) y el documento
// docs/restaurantes-colonias-radio-8km.md. No abre ninguna conexion. Una prueba (tests/colonias-radio-8km.spec.ts) falla si los archivos se desincronizan.
//
//   node --experimental-strip-types scripts/seed-pm-demo/generar-colonias-8km.ts [--respaldo=<carpeta>]
//
// --respaldo copia los dos SQL (colonias-8km-carga.sql y colonias-8km-verifica.sql) a esa carpeta (p. ej. ~/atiende-loop/respaldos-bd).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCargaSql, renderDocumento, renderVerificaSql } from "../../packages/domain-restaurantes/src/seed/colonias-radio-8km.ts";
import { loadSeedInputs } from "./inputs.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");
export const RUTA_CARGA = path.join(AQUI, "sql", "colonias-8km-carga.sql");
export const RUTA_VERIFICA = path.join(AQUI, "sql", "colonias-8km-verifica.sql");
export const RUTA_DOCUMENTO = path.join(RAIZ, "docs", "restaurantes-colonias-radio-8km.md");

function main(): void {
  const { data } = loadSeedInputs();
  const archivos: [string, string][] = [
    [RUTA_CARGA, renderCargaSql(data)],
    [RUTA_VERIFICA, renderVerificaSql(data)],
    [RUTA_DOCUMENTO, renderDocumento(data)],
  ];
  for (const [ruta, contenido] of archivos) {
    mkdirSync(path.dirname(ruta), { recursive: true });
    writeFileSync(ruta, contenido);
    console.log(`escrito ${path.relative(RAIZ, ruta)}`);
  }
  const respaldo = process.argv.find((a) => a.startsWith("--respaldo="))?.slice("--respaldo=".length);
  if (respaldo) {
    mkdirSync(respaldo, { recursive: true });
    writeFileSync(path.join(respaldo, "colonias-8km-carga.sql"), archivos[0]![1]);
    writeFileSync(path.join(respaldo, "colonias-8km-verifica.sql"), archivos[1]![1]);
    console.log(`copiados los dos SQL a ${respaldo}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
