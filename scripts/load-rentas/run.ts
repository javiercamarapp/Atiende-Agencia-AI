// Orquestador de la carga de rentas (Rn-P3-14): corre A, B y C contra el Postgres de LOAD_RENTAS_DATABASE_URL y escribe un reporte JSON y
// Markdown en scripts/load-rentas/salida/. Fuera de CI (manual o nocturno). Sin SLO publicado: sale con codigo 1 SOLO si un invariante se rompe.
//   npm run load:rentas              -> N reducido (apto para esta Mac de 24 GB)
//   npm run load:rentas -- --completo -> N completo (A 50 x 3 con concurrencia 30, B 30 x 5 rondas, C 50 x 10 al 10 %)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { infoHardware, type ResultadoEscenario } from "./comun.ts";
import { escenarioA } from "./escenario-a-importacion.ts";
import { escenarioB } from "./escenario-b-rafaga.ts";
import { escenarioC } from "./escenario-c-reconciliacion.ts";

const completo = process.argv.includes("--completo");
const P = completo
  ? { aUnidades: 50, aCanales: 3, aConc: 30, bConc: 30, bRondas: 5, cUnidades: 50, cReservas: 10, cDrift: 0.1 }
  : { aUnidades: 10, aCanales: 3, aConc: 10, bConc: 20, bRondas: 3, cUnidades: 10, cReservas: 10, cDrift: 0.1 };

const resultados: ResultadoEscenario[] = [];
for (const [nombre, fn] of [
  ["A", () => escenarioA(P.aUnidades, P.aCanales, P.aConc)],
  ["B", () => escenarioB(P.bConc, P.bRondas)],
  ["C", () => escenarioC(P.cUnidades, P.cReservas, P.cDrift)],
] as const) {
  console.log(`==> escenario ${nombre}`);
  const r = await fn();
  resultados.push(r);
  for (const inv of r.invariantes) console.log(`   [${inv.ok ? "OK" : "FALLA"}] ${inv.nombre} (${inv.detalle})`);
  for (const [k, l] of Object.entries(r.latencias)) console.log(`   ${k}: n=${l.n} p50=${l.p50Ms}ms p95=${l.p95Ms}ms p99=${l.p99Ms}ms max=${l.maxMs}ms`);
}

const hw = infoHardware();
const fallas = resultados.flatMap((r) => r.invariantes.filter((i) => !i.ok).map((i) => `${r.escenario}: ${i.nombre} (${i.detalle})`));
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "salida");
mkdirSync(dir, { recursive: true });
const base = path.join(dir, `carga-rentas-${completo ? "completo" : "reducido"}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
writeFileSync(`${base}.json`, JSON.stringify({ modo: completo ? "completo" : "reducido", hardware: hw, resultados, fallas }, null, 1));
const md = [
  `# Carga de rentas (${completo ? "N completo" : "N reducido"})`,
  "",
  `Hardware: ${Object.entries(hw).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  "",
  ...resultados.flatMap((r) => [
    `## ${r.escenario}`,
    `Parametros: ${Object.entries(r.parametros).map(([k, v]) => `${k}=${v}`).join(", ")}; duracion total ${r.duracionTotalMs} ms`,
    "",
    "| medicion | n | p50 ms | p95 ms | p99 ms | max ms |",
    "|---|---|---|---|---|---|",
    ...Object.entries(r.latencias).map(([k, l]) => `| ${k} | ${l.n} | ${l.p50Ms} | ${l.p95Ms} | ${l.p99Ms} | ${l.maxMs} |`),
    "",
    ...r.invariantes.map((i) => `- ${i.ok ? "OK" : "FALLA"}: ${i.nombre} (${i.detalle})`),
    "",
  ]),
  "Sin SLO publicado: estas cifras se reportan, no se prometen. El reporte solo falla si se rompe un invariante.",
].join("\n");
writeFileSync(`${base}.md`, md + "\n");
console.log(`\nreporte: ${path.relative(process.cwd(), base)}.json y .md`);
if (fallas.length > 0) {
  console.error(`\nINVARIANTES ROTOS:\n${fallas.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nverificado: todos los invariantes se sostienen.");
