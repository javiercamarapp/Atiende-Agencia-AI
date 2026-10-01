// CLI del BAKE-OFF de reportes PDF / visuales (40 tareas x 4 brazos). Mismo contrato de seguridad que cli.ts:
//   CI (sin costo): modelo guionado "oro":   npx vite-node scripts/eval-copiloto/bakeoff-cli.ts -- --tareas=40
//   REAL (manual):  COPILOTO_EVAL_REAL=1 OPENROUTER_API_KEY_FILE=... npx vite-node scripts/eval-copiloto/bakeoff-cli.ts -- --modo=real --max-usd=8
// Humo del runner: --tareas=1 --max-usd=0.4 (--sinteticos mide a Qwen 3.7 Flash sin ZDR, solo con datos sinteticos). --dry-run imprime el plan y la proyeccion. El tope de gasto es duro y nunca pasa de 45 USD.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRAZOS_BAKEOFF,
  PresupuestoDuro,
  bakeoffMarkdown,
  correrBakeoff,
  crearFabricaOpenRouter,
  crearJuezGuionado,
  crearJuezOpenRouter,
  juezAnalisisDesde,
  RUBRICA_ANALISIS,
  type FabricaModelo,
} from "@atiende/agent-core/data-chat/evals";
import { TOPE_TOTAL_USD, cargarCasos, leerLlave, parsearArgs } from "./ejecutar.ts";
import { fabricaOroBakeoff, proyectarBakeoffUsd, seleccionarTareas } from "./bakeoff.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = parsearArgs(process.argv.slice(2));
  const modo = (args.get("modo") ?? "ci") as "ci" | "real";
  if (modo !== "ci" && modo !== "real") throw new Error("--modo debe ser ci o real");
  const { congelados } = cargarCasos();
  let tareas = seleccionarTareas(congelados);
  const n = Number(args.get("tareas") ?? tareas.length);
  if (!Number.isInteger(n) || n < 1 || n > tareas.length) throw new Error(`--tareas debe ser un entero entre 1 y ${tareas.length}`);
  tareas = tareas.slice(0, n);
  const ids = args.get("brazos")?.split(",");
  const brazos = ids ? BRAZOS_BAKEOFF.filter((b) => ids.includes(b.id)) : BRAZOS_BAKEOFF;
  if (brazos.length === 0) throw new Error("--brazos sin coincidencias");
  const maxUsd = Number(args.get("max-usd") ?? (modo === "real" ? NaN : 1));
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > TOPE_TOTAL_USD) throw new Error(`en modo real pasa --max-usd=<USD> (maximo ${TOPE_TOTAL_USD})`);

  console.log(`bake-off modo=${modo} tareas=${tareas.length} brazos=${brazos.map((b) => b.id).join(",")} tope=${maxUsd} USD`);
  console.log(`proyeccion de gasto: ${proyectarBakeoffUsd(tareas.length, brazos)} USD`);
  if (args.has("dry-run")) return;
  if (modo === "real" && process.env["COPILOTO_EVAL_REAL"] !== "1") throw new Error("modo real apagado: define COPILOTO_EVAL_REAL=1 (cuesta dinero; nunca corre en CI)");

  const presupuesto = new PresupuestoDuro(maxUsd, 0.06);
  let fabrica: FabricaModelo;
  let juez;
  if (modo === "real") {
    const llave = leerLlave();
    const f = crearFabricaOpenRouter(llave);
    const sinteticos = args.has("sinteticos");
    // --sinteticos: un modelo SIN host de EE.UU. (hoy Qwen 3.7 Flash) se enruta sin ZDR, solo para medir su calidad potencial con
    // las tablas SINTETICAS del eval. Nunca es una autorizacion de uso en produccion.
    fabrica = (m) => f(sinteticos && !m.hostEeuu ? { ...m, routing: { dataCollection: "deny", requireParameters: true, allowFallbacks: false } } : m, undefined as never, 1);
    juez = args.has("sin-juez") ? undefined : juezAnalisisDesde(crearJuezOpenRouter({ apiKey: llave, presupuesto, rubrica: RUBRICA_ANALISIS }));
  } else {
    fabrica = fabricaOroBakeoff();
    juez = juezAnalisisDesde(crearJuezGuionado(() => 5));
  }
  const res = await correrBakeoff({ tareas, brazos, presupuesto, fabrica, ...(juez ? { juez } : {}) });
  const md = bakeoffMarkdown(res);
  const dir = path.join(AQUI, "salida");
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `bakeoff-${modo}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  writeFileSync(`${base}.json`, JSON.stringify(res, null, 1));
  writeFileSync(`${base}.md`, md + "\n");
  console.log(`\n${md}\n\nsalida: ${path.relative(process.cwd(), base)}.json y .md`);
  process.exit(res.abortada ? 2 : 0);
}

await main();
