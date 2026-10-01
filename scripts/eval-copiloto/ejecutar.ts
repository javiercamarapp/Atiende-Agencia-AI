// Orquestacion del arnes: plan (fase, modelos, casos, K, tope), proyeccion de costo, mundos (Postgres sembrado o repeticion
// congelada), ejecucion y reportes. El CLI (cli.ts) solo parsea argumentos; las pruebas usan estas funciones directamente.
import { readFileSync } from "node:fs";
import { scriptedCompletion, type ScriptStep } from "@atiende/agent-core/data-chat";
import {
  CANDIDATOS,
  PresupuestoDuro,
  candidatoPorId,
  candidatosDeFase,
  construirReporte,
  correrEval,
  crearFabricaOpenRouter,
  crearJuezGuionado,
  crearJuezOpenRouter,
  proyectarCostoUsd,
  reporteMarkdown,
  seleccionarPiloto,
  type ArchivoCongelado,
  type CasoEval,
  type FabricaCompletion,
  type FaseCorrida,
  type JuezEspanol,
  type ModeloCandidato,
  type MundoVertical,
  type ReporteCorrida,
  type ResultadoCorrida,
} from "@atiende/agent-core/data-chat/evals";
import { VERTICALES_EVAL, abrirMotor, mundoPostgres, mundoRepeticion, type VerticalEval } from "./mundos.ts";
import { leerCongelado } from "./congelado.ts";

/** Tope total del piloto + barrido (saldo de OpenRouter ~$59.68 el 1-oct-2026; decision: no pasar de ~$45). */
export const TOPE_TOTAL_USD = 45;
export const TOPE_HUMO_USD = 0.5;

export interface PlanCorrida {
  readonly fase: FaseCorrida;
  readonly modo: "ci" | "real";
  readonly modelos: readonly ModeloCandidato[];
  readonly casos: readonly CasoEval[];
  readonly k: number;
  readonly maxUsd: number;
}

export function cargarCasos(verticales: readonly VerticalEval[] = VERTICALES_EVAL): { casos: CasoEval[]; congelados: Map<VerticalEval, ArchivoCongelado> } {
  const congelados = new Map<VerticalEval, ArchivoCongelado>();
  const casos: CasoEval[] = [];
  for (const v of verticales) {
    const c = leerCongelado(v);
    congelados.set(v, c);
    casos.push(...c.casos);
  }
  return { casos, congelados };
}

export function parsearArgs(argv: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of argv) {
    if (a === "--") continue;
    if (!a.startsWith("--")) throw new Error(`argumento no reconocido: ${a}`);
    const i = a.indexOf("=");
    m.set(i < 0 ? a.slice(2) : a.slice(2, i), i < 0 ? "1" : a.slice(i + 1));
  }
  return m;
}

function numero(args: Map<string, string>, k: string, def: number, min: number, max: number): number {
  const v = args.get(k);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${k} debe ser un numero entre ${min} y ${max}`);
  return n;
}

/** Finalistas del barrido: los mejores N de un reporte de piloto (sin calibracion, con fase barrido). */
export function finalistasDe(rutaReporte: string, top: number): ModeloCandidato[] {
  const j = JSON.parse(readFileSync(rutaReporte, "utf8")) as { reporte?: ReporteCorrida };
  const rep = j.reporte;
  if (!rep) throw new Error("el archivo no trae un reporte (se esperaba la salida JSON de una corrida)");
  const elegibles = rep.resumenes.filter((r) => {
    const c = candidatoPorId(r.modelo);
    return c && c.fases.includes("barrido") && !c.roles.includes("calibracion") && r.evaluados > 0;
  });
  return elegibles.slice(0, top).map((r) => candidatoPorId(r.modelo)!);
}

export function construirPlan(args: Map<string, string>, todos: readonly CasoEval[]): PlanCorrida {
  const fase = (args.get("fase") ?? "humo") as FaseCorrida;
  if (!["humo", "piloto", "barrido", "cfo", "ci"].includes(fase)) throw new Error("--fase debe ser humo, piloto, barrido o cfo");
  const modo = (args.get("modo") ?? "ci") as "ci" | "real";
  if (modo !== "ci" && modo !== "real") throw new Error("--modo debe ser ci o real");

  const verticales = args.get("verticales")?.split(",").map((s) => s.trim()).filter(Boolean);
  let casos = verticales ? todos.filter((c) => verticales.includes(c.vertical)) : [...todos];
  if (casos.length === 0) throw new Error("ningun caso con esos filtros");

  let modelos: ModeloCandidato[];
  const ids = args.get("modelos")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids) {
    modelos = ids.map((id) => {
      const c = candidatoPorId(id);
      if (!c) throw new Error(`modelo fuera de la lista de candidatos: ${id} (ver candidatos.ts)`);
      return c;
    });
  } else if (fase === "barrido") {
    const de = args.get("finalistas-de");
    if (!de) throw new Error("el barrido necesita --finalistas-de=<reporte del piloto .json> (y opcional --top=N) o --modelos=...");
    modelos = finalistasDe(de, numero(args, "top", 4, 1, 12));
  } else if (fase === "humo") modelos = [candidatoPorId("openai/gpt-6-luna")!];
  else if (fase === "cfo") modelos = candidatosDeFase("cfo") as ModeloCandidato[];
  else modelos = candidatosDeFase("piloto") as ModeloCandidato[];
  if (modelos.length === 0) throw new Error("sin modelos para correr");

  let k = numero(args, "k", fase === "barrido" ? 3 : 1, 1, 5);
  if (fase === "humo") {
    casos = seleccionarPiloto(casos, numero(args, "casos-por-vertical", 2, 1, 10));
    k = 1;
  } else if (fase === "piloto") casos = seleccionarPiloto(casos, numero(args, "casos-por-vertical", 30, 1, 150));
  else if (fase === "cfo") {
    casos = casos.filter((c) => c.vertical === "superadmin");
    if (casos.length === 0) throw new Error("fase cfo: no hay casos CFO/superadmin (en main no existe un catalogo de datos de superadmin; ver docs/EVAL-COPILOTO.md)");
  }

  const tope = fase === "humo" ? TOPE_HUMO_USD : fase === "piloto" ? 8 : TOPE_TOTAL_USD;
  const maxUsd = numero(args, "max-usd", tope, 0.01, TOPE_TOTAL_USD);
  if (fase === "humo" && maxUsd > TOPE_HUMO_USD) throw new Error(`el humo no puede pasar de ${TOPE_HUMO_USD} USD`);
  return { fase, modo, modelos, casos, k, maxUsd };
}

export function proyeccion(plan: Pick<PlanCorrida, "modelos" | "casos" | "k">): { porModelo: { modelo: string; usd: number }[]; totalUsd: number } {
  const porModelo = plan.modelos.map((m) => ({ modelo: m.id, usd: proyectarCostoUsd(m, plan.casos.length, plan.k) }));
  return { porModelo, totalUsd: Math.round(porModelo.reduce((a, x) => a + x.usd, 0) * 1000) / 1000 };
}

/** Guion "oro" del modo CI: el modelo perfecto emite exactamente las llamadas de referencia y narra con el resumen
 *  determinista de la herramienta (todas sus cifras estan respaldadas). Valida graders y fixtures sin gastar. */
export function guionOro(caso: CasoEval, congelado: ArchivoCongelado): ScriptStep[] {
  const llamadas = caso.esperado.llamadas;
  if (llamadas.length > 0) {
    const refs = congelado.referencias[caso.id] ?? [];
    const texto = refs
      .map((r) => r.result.summary ?? "")
      .filter(Boolean)
      .join(" ")
      .slice(0, 650);
    return [{ toolCalls: llamadas.map((l) => ({ name: l.tool, argumentsJson: JSON.stringify(l.args) })) }, { text: texto }];
  }
  return [{ text: caso.esperado.status === "clarify" ? "¿De qué periodo quieres saberlo?" : "Esa consulta no está cubierta por las herramientas que tengo disponibles." }];
}

export function leerLlave(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const directa = env["OPENROUTER_API_KEY"];
  if (directa) return directa.trim();
  const archivo = env["OPENROUTER_API_KEY_FILE"];
  if (archivo) return readFileSync(archivo, "utf8").trim();
  throw new Error("falta la llave: define OPENROUTER_API_KEY u OPENROUTER_API_KEY_FILE (nunca se imprime)");
}

export interface SalidaEjecucion {
  readonly resultado: ResultadoCorrida;
  readonly reporte: ReporteCorrida;
  readonly markdown: string;
}

export async function ejecutarPlan(
  plan: PlanCorrida,
  congelados: ReadonlyMap<VerticalEval, ArchivoCongelado>,
  opts: { readonly urlBase?: string; readonly llave?: string; readonly fabrica?: FabricaCompletion; readonly juez?: JuezEspanol; readonly concurrencia?: number; readonly alProgreso?: Parameters<typeof correrEval>[0]["alProgreso"] } = {},
): Promise<SalidaEjecucion> {
  const presupuesto = new PresupuestoDuro(plan.maxUsd);
  const verticales = [...new Set(plan.casos.map((c) => c.vertical))] as VerticalEval[];
  let motor: ReturnType<typeof abrirMotor> | null = null;
  const mundos: Record<string, MundoVertical> = {};
  try {
    for (const v of verticales) {
      if (opts.urlBase) {
        motor ??= abrirMotor(opts.urlBase);
        mundos[v] = mundoPostgres(v, motor);
      } else mundos[v] = mundoRepeticion(v, congelados.get(v)!);
    }
    const porId = new Map(plan.casos.map((c) => [c.id, c]));
    const fabrica: FabricaCompletion =
      opts.fabrica ??
      (plan.modo === "real"
        ? crearFabricaOpenRouter(opts.llave ?? leerLlave())
        : (_m, caso) => scriptedCompletion(guionOro(porId.get(caso.id)!, congelados.get(caso.vertical as VerticalEval)!)).complete);
    const juez = opts.juez ?? (plan.modo === "real" ? crearJuezOpenRouter({ apiKey: opts.llave ?? leerLlave(), presupuesto }) : crearJuezGuionado());
    const resultado = await correrEval({ fase: plan.fase, modelos: plan.modelos, casos: plan.casos, mundos, k: plan.k, presupuesto, fabrica, juez, concurrencia: opts.concurrencia ?? 4, alProgreso: opts.alProgreso });
    const expectativas = new Map(plan.casos.map((c) => [c.id, { llamadas: c.esperado.llamadas.length }]));
    const reporte = construirReporte(resultado, expectativas, CANDIDATOS);
    return { resultado, reporte, markdown: reporteMarkdown(reporte) };
  } finally {
    await motor?.stop();
  }
}
