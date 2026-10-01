// CLI del arnes de evaluacion del Copiloto.
//   MODO CI (sin costo, sin red): modelo guionado "oro" sobre la repeticion congelada; valida graders y fixtures.
//     npx vite-node scripts/eval-copiloto/cli.ts -- --fase=piloto
//   MODO REAL (MANUAL, cuesta dinero; nunca corre en CI): exige COPILOTO_EVAL_REAL=1, la llave en OPENROUTER_API_KEY u
//   OPENROUTER_API_KEY_FILE (nunca se imprime), un tope --max-usd y, de preferencia, el mundo Postgres sembrado (run.sh):
//     COPILOTO_EVAL_REAL=1 OPENROUTER_API_KEY_FILE=~/.atiende-secrets/OPENROUTER_API_KEY.txt \
//       scripts/eval-copiloto/run.sh npx vite-node scripts/eval-copiloto/cli.ts -- --modo=real --fase=humo
// Fases: humo (<= $0.50, 1 modelo, pocos casos), piloto (30 casos por vertical x K=1 con los candidatos), barrido (todos los
// casos x K=3 con --finalistas-de=<salida del piloto>), cfo (subconjunto CFO/superadmin; hoy sin casos). --dry-run solo
// imprime el plan y la proyeccion de costo.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cargarCasos, construirPlan, ejecutarPlan, parsearArgs, proyeccion } from "./ejecutar.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = parsearArgs(process.argv.slice(2));
  const { casos, congelados } = cargarCasos();
  const plan = construirPlan(args, casos);
  const p = proyeccion(plan);
  console.log(`fase=${plan.fase} modo=${plan.modo} casos=${plan.casos.length} k=${plan.k} modelos=${plan.modelos.length} tope=${plan.maxUsd} USD`);
  console.log(`proyeccion de gasto (8k tokens de entrada y 900 de salida por turno): ${p.totalUsd} USD`);
  for (const m of p.porModelo) console.log(`  ${m.modelo}: ${m.usd} USD`);
  if (args.has("dry-run")) return;

  if (plan.modo === "real") {
    if (process.env["COPILOTO_EVAL_REAL"] !== "1") throw new Error("modo real apagado: define COPILOTO_EVAL_REAL=1 (cuesta dinero; nunca corre en CI)");
    if (!args.has("max-usd") && plan.fase !== "humo") throw new Error("en modo real el tope es explicito: pasa --max-usd=<USD>");
  }
  const urlBase = process.env["COPILOTO_EVAL_DATABASE_URL"];
  if (plan.modo === "real" && !urlBase) console.warn("AVISO: sin COPILOTO_EVAL_DATABASE_URL se usa la repeticion congelada: un modelo que pida argumentos distintos de los de referencia recibe 'sin referencia'. Para el eval real corre con scripts/eval-copiloto/run.sh.");

  const salida = await ejecutarPlan(plan, congelados, {
    ...(plan.modo === "real" && urlBase ? { urlBase } : {}),
    alProgreso: (e) => {
      if (e.hechos % 25 === 0 || e.hechos === e.total) console.error(`  ${e.hechos}/${e.total} turnos; gasto ${e.gastoUsd.toFixed(4)} USD`);
    },
  });
  const dir = path.join(AQUI, "salida");
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${plan.fase}-${plan.modo}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  writeFileSync(`${base}.json`, JSON.stringify({ plan: { fase: plan.fase, modo: plan.modo, k: plan.k, maxUsd: plan.maxUsd, modelos: plan.modelos.map((m) => m.id), casos: plan.casos.map((c) => c.id) }, reporte: salida.reporte, resultado: salida.resultado }, null, 1));
  writeFileSync(`${base}.md`, salida.markdown + "\n");
  console.log(`\n${salida.markdown}\n`);
  console.log(`salida: ${path.relative(process.cwd(), base)}.json y .md`);
  process.exit(salida.resultado.abortada ? 2 : 0);
}

await main();
