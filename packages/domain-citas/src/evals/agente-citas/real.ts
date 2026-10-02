// MODO LLM REAL del arnes de citas (manual; NUNCA corre en CI ni en `npm test`). Un LLM hace de agente con el MISMO
// prompt (`buildSystemPrompt`) y las MISMAS herramientas (`TOOLS`) que produccion, sobre el mundo simulado; los mensajes
// del cliente son los del caso (guion fijo: sin segundo LLM, para que el costo sea solo el del agente). Pasa por el
// `OpenRouterProvider` del gateway (ver docs/LLM-GATEWAY.md): tool calling real y costo real por llamada.
// Protecciones:
//   * `--max-usd` es OBLIGATORIO y tiene un techo duro (MAX_USD_PERMITIDO); sin el, o sin --model/OPENROUTER_API_KEY,
//     lanza antes de cualquier red;
//   * el gasto se acumula con el costo real de cada llamada y la corrida se corta al alcanzar el tope, listando los
//     casos sin correr;
//   * el cierre del gateway (presupuesto agotado) cuenta como corte limpio, no como fallo.
// Reporta precision de herramienta, cifras u horarios inventados y costo por conversacion (formula en README.md).
import { randomUUID } from "node:crypto";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, OpenRouterProvider, isBudgetExceededError } from "@atiende/agent-core";
import type { LlmMessage, LlmToolCall, LlmToolDefinition, OpenRouterModelParams } from "@atiende/agent-core";
import { TOOLS, buildSystemPrompt } from "../../whatsapp/llm-turn-handler.ts";
import { evaluarCaso } from "./graders.ts";
import { CATALOGO, Mundo, cargarSuite } from "./mundo.ts";
import type { CasoEval, ResultadoCaso, Traza } from "./tipos.ts";

/** Techo duro del gasto de una corrida: la ruta barata (modelos de bajo costo) no necesita mas para 48 casos. */
export const MAX_USD_PERMITIDO = 5;

export interface OpcionesReal {
  readonly apiKey: string;
  readonly model: string;
  readonly maxUsd: number;
  readonly casos?: readonly string[];
  readonly params?: OpenRouterModelParams;
  /** URL de chat/completions (solo pruebas con un servidor falso). */
  readonly baseUrl?: string;
}

function valorDe(args: readonly string[], nombre: string): string | undefined {
  const i = args.indexOf(nombre);
  if (i >= 0) return args[i + 1];
  const conIgual = args.find((a) => a.startsWith(`${nombre}=`));
  return conIgual ? conIgual.slice(nombre.length + 1) : undefined;
}

/** Lee `--model`, `--max-usd` (obligatorio, 0 < x <= MAX_USD_PERMITIDO), `--casos A01,K02` y `--reasoning`. La llave viene del entorno. */
export function opcionesRealDesdeArgs(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): OpcionesReal {
  const maxRaw = valorDe(args, "--max-usd");
  if (maxRaw === undefined) throw new Error("Falta --max-usd (obligatorio): el modo real cuesta dinero y necesita un tope explicito.");
  const maxUsd = Number(maxRaw);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("--max-usd debe ser un numero positivo.");
  if (maxUsd > MAX_USD_PERMITIDO) throw new Error(`--max-usd no puede pasar de ${MAX_USD_PERMITIDO} USD por corrida (pidio ${maxUsd}).`);
  const model = valorDe(args, "--model");
  if (!model) throw new Error("Falta --model (id de OpenRouter, explicito; no se elige uno por omision).");
  if (!env.OPENROUTER_API_KEY) throw new Error("Falta OPENROUTER_API_KEY en el entorno.");
  const effort = valorDe(args, "--reasoning");
  if (effort && !["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort)) throw new Error("--reasoning invalido (none|minimal|low|medium|high|xhigh).");
  const params: OpenRouterModelParams = { temperature: "omit", ...(effort ? { reasoningEffort: effort as OpenRouterModelParams["reasoningEffort"] } : {}), minMaxTokens: 1500 };
  return { apiKey: env.OPENROUTER_API_KEY, model, maxUsd, params, casos: valorDe(args, "--casos")?.split(",").map((s) => s.trim()).filter(Boolean) };
}

export interface RespuestaLlm {
  readonly text: string;
  readonly toolCalls?: readonly LlmToolCall[];
  readonly costUsd?: number;
}

/** Una llamada al modelo del agente. Inyectable: las pruebas usan una funcion falsa, nunca la red. */
export type Llamador = (system: string, messages: LlmMessage[], tools: LlmToolDefinition[], toolChoice: string | null) => Promise<RespuestaLlm>;

export interface ConversacionReal {
  readonly resultado: ResultadoCaso;
  readonly costoUsd: number;
  readonly llamadas: number;
}

export interface MetricasReal {
  readonly conversaciones: number;
  /** Casos con requeridas/prohibidas en los que el agente uso las herramientas correctas / total de esos casos. */
  readonly precisionHerramienta: { readonly aciertos: number; readonly total: number };
  /** Conversaciones con alguna hora o cifra que no salio de una herramienta, o una escritura con un slot que nadie ofrecio. */
  readonly inventados: { readonly horarios: number; readonly cifras: number; readonly escriturasConSlotInventado: number };
  readonly costoTotalUsd: number;
  readonly costoPorConversacionUsd: number;
}

export interface ResultadoReal {
  readonly conversaciones: readonly ConversacionReal[];
  readonly metricas: MetricasReal;
  readonly gastoUsd: number;
  readonly noCorridos: readonly string[];
  readonly cortadoPorTope: boolean;
}

const MAX_PASOS_HERRAMIENTA = 6;

class TopeDeGasto extends Error {}

export function llamadorOpenRouter(opts: OpcionesReal): { llamar: Llamador; gasto: () => number } {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: opts.maxUsd, maxTenantDailyUsd: opts.maxUsd },
  });
  gateway.registerLadder("citas-evals", [
    new OpenRouterProvider({ id: `openrouter:${opts.model}`, apiKey: opts.apiKey, model: opts.model, params: opts.params ?? { temperature: "omit", minMaxTokens: 1500 }, appName: "Atiende evals citas", ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) }),
  ]);
  let gasto = 0;
  const llamar: Llamador = async (system, messages, tools, toolChoice) => {
    if (gasto >= opts.maxUsd) throw new TopeDeGasto();
    try {
      const r = await gateway.complete({
        tenantId: "citas-evals",
        runId: randomUUID(),
        lane: "interactive",
        role: "citas-evals",
        request: { system, messages, tools, maxOutputTokens: 800, ...(toolChoice ? { toolChoice: { name: toolChoice } } : {}) },
      });
      gasto += r.costUsd ?? 0;
      return r;
    } catch (err) {
      if (isBudgetExceededError(err)) throw new TopeDeGasto();
      throw err;
    }
  };
  return { llamar, gasto: () => gasto };
}

function sistemaDelCaso(caso: CasoEval): string {
  const cat = CATALOGO[caso.negocio];
  const known = caso.cliente.nombre !== null || caso.cliente.citas.length > 0;
  return buildSystemPrompt(
    { businessName: cat.nombre, timezone: caso.tz },
    known
      ? { isNew: false, fullName: caso.cliente.nombre, upcomingAppointments: [] }
      : { isNew: true, fullName: null, upcomingAppointments: [] },
    new Date(caso.ahora),
    cat.rubro,
  );
}

/** Corre UNA conversacion: cada mensaje del caso pasa por las capas deterministas del mundo y, si siguen, por el LLM. */
export async function correrConversacion(caso: CasoEval, llamar: Llamador, mundo: Mundo = new Mundo(caso)): Promise<{ traza: Traza; costoUsd: number; llamadas: number }> {
  const system = sistemaDelCaso(caso);
  const herramientas: LlmToolDefinition[] = TOOLS.map((t) => ({ ...t }));
  const historial: LlmMessage[] = [];
  let costoUsd = 0;
  let llamadas = 0;
  for (const mensaje of caso.mensajes) {
    mundo.cliente(mensaje);
    if (mundo.guardrailRespondio) continue;
    historial.push({ role: "user", content: mensaje });
    for (let paso = 0; paso < MAX_PASOS_HERRAMIENTA; paso++) {
      const forzada = paso === 0 ? mundo.herramientaForzada : null;
      const r = await llamar(system, historial, herramientas, forzada);
      llamadas += 1;
      costoUsd += r.costUsd ?? 0;
      const tcs = r.toolCalls ?? [];
      if (r.text && tcs.length === 0) mundo.agente(r.text);
      if (tcs.length === 0) {
        historial.push({ role: "assistant", content: r.text });
        break;
      }
      historial.push({ role: "assistant", content: r.text ?? "", toolCalls: [...tcs] });
      for (const c of tcs) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.argumentsJson || "{}") as Record<string, unknown>;
        } catch {
          /* argumentos invalidos: la herramienta responde error */
        }
        historial.push({ role: "tool", toolCallId: c.id, content: JSON.stringify(mundo.ejecutar(c.name, args)) });
      }
    }
  }
  return { traza: mundo.traza(), costoUsd, llamadas };
}

/** Graders que en modo real no se aplican: dependen de frases literales o de la hora exacta dicha, que un LLM real parafrasea. */
const SOLO_REFERENCIA = new Set(["texto_esperado", "hora_local_correcta"]);

export function calcularMetricas(conversaciones: readonly ConversacionReal[], casos: readonly CasoEval[]): MetricasReal {
  const porId = new Map(casos.map((c) => [c.id, c]));
  let aciertos = 0;
  let total = 0;
  const inv = { horarios: 0, cifras: 0, escriturasConSlotInventado: 0 };
  for (const c of conversaciones) {
    const caso = porId.get(c.resultado.casoId);
    const g = (n: string) => c.resultado.graders.find((x) => x.grader === n);
    if (caso && ((caso.esperado.herramientas_requeridas?.length ?? 0) > 0 || (caso.esperado.herramientas_prohibidas?.length ?? 0) > 0)) {
      total += 1;
      if (g("precision_herramientas")?.ok) aciertos += 1;
    }
    if (g("nunca_inventa_horario") && !g("nunca_inventa_horario")!.ok) inv.horarios += 1;
    if (g("no_inventa_cifras") && !g("no_inventa_cifras")!.ok) inv.cifras += 1;
    if (g("escribe_con_slot_real") && !g("escribe_con_slot_real")!.ok) inv.escriturasConSlotInventado += 1;
  }
  const costoTotalUsd = conversaciones.reduce((s, c) => s + c.costoUsd, 0);
  return {
    conversaciones: conversaciones.length,
    precisionHerramienta: { aciertos, total },
    inventados: inv,
    costoTotalUsd,
    costoPorConversacionUsd: conversaciones.length === 0 ? 0 : costoTotalUsd / conversaciones.length,
  };
}

export async function ejecutarSuiteReal(opts: Pick<OpcionesReal, "maxUsd" | "casos">, llamar: Llamador, gasto: () => number): Promise<ResultadoReal> {
  const suite = cargarSuite();
  const seleccion = suite.casos.filter((c) => !opts.casos || opts.casos.includes(c.id));
  const conversaciones: ConversacionReal[] = [];
  const noCorridos: string[] = [];
  let cortado = false;
  for (const caso of seleccion) {
    if (cortado || gasto() >= opts.maxUsd) {
      cortado = true;
      noCorridos.push(caso.id);
      continue;
    }
    try {
      const { traza, costoUsd, llamadas } = await correrConversacion(caso, llamar);
      const base = evaluarCaso(traza);
      const graders = base.graders.filter((g) => !SOLO_REFERENCIA.has(g.grader));
      conversaciones.push({ resultado: { casoId: caso.id, ok: graders.every((g) => g.ok), graders }, costoUsd, llamadas });
    } catch (err) {
      if (!(err instanceof TopeDeGasto)) throw err;
      cortado = true;
      noCorridos.push(caso.id);
    }
  }
  return { conversaciones, metricas: calcularMetricas(conversaciones, suite.casos), gastoUsd: gasto(), noCorridos, cortadoPorTope: cortado };
}
