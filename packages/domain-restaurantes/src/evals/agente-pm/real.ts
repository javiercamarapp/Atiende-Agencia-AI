// MODO LLM REAL del arnes (manual; NUNCA corre en CI ni en `npm test`). Un LLM hace de agente con el prompt de PM
// y las herramientas del registro sobre el mundo simulado; otro LLM hace de cliente (`simulador_cliente`). Se
// aplican los mismos graders deterministas. Protecciones:
//   * exige PM_EVALS_REAL=1, OPENROUTER_API_KEY y PM_EVALS_MODEL (id de OpenRouter, p.ej. openai/gpt-6-luna;
//     sin ellas, lanza antes de cualquier red). Pasa por el MISMO OpenRouterProvider que produccion
//     (tool calling real, costo real del usage accounting, privacidad data_collection=deny), asi que los
//     evals ejercitan herramientas de verdad y se puede barrer cualquier modelo con una sola llave;
//   * tope de gasto PM_EVALS_MAX_USD (default 2): se acumula el costo de cada llamada y la corrida se corta
//     al alcanzarlo, reportando los casos no corridos;
//   * k repeticiones por caso (PM_EVALS_K, default 1); el caso pasa solo si pasa las k;
//   * tope de 30 turnos por caso (bucle = fallo).
// Uso: PM_EVALS_REAL=1 OPENROUTER_API_KEY=... PM_EVALS_MODEL=... npm run evals:pm:real -w @atiende/domain-restaurantes
import { randomUUID } from "node:crypto";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, OpenRouterProvider, isBudgetExceededError } from "@atiende/agent-core";
import type { LlmMessage, LlmToolDefinition, OpenRouterModelParams } from "@atiende/agent-core";
import { AGENT_TOOL_DEFINITIONS } from "../../agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION } from "../../whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt, saludoPorHora } from "../../whatsapp/perfil-pm.ts";
import { evaluarCaso } from "./graders.ts";
import { CONTRATO_OBJETIVO, Mundo, cargarMenu, cargarSuite } from "./mundo.ts";
import type { CasoEval, ResultadoCaso } from "./tipos.ts";

export interface OpcionesReal {
  readonly apiKey: string;
  readonly model: string;
  readonly maxUsd: number;
  readonly k: number;
  readonly casos?: readonly string[];
  /** Parametros del modelo evaluado (PM_EVALS_TEMPERATURE / PM_EVALS_REASONING). Por omision NO se manda
   *  temperature: GPT-6, Claude 5.x y Gemini Flash-Lite la rechazan o no la soportan. */
  readonly params?: OpenRouterModelParams;
  /** PM_EVALS_TRAZA=1: el CLI imprime la conversacion y las herramientas de los casos que fallan (diagnostico). */
  readonly traza?: boolean;
  /** URL de chat/completions (solo pruebas con un servidor falso). */
  readonly baseUrl?: string;
}

export function opcionesRealDesdeEntorno(env: Readonly<Record<string, string | undefined>> = process.env): OpcionesReal {
  if (env.PM_EVALS_REAL !== "1") throw new Error("Modo LLM real apagado: define PM_EVALS_REAL=1 (cuesta dinero; nunca corre en CI).");
  if (!env.OPENROUTER_API_KEY) throw new Error("Falta OPENROUTER_API_KEY.");
  if (!env.PM_EVALS_MODEL) throw new Error("Falta PM_EVALS_MODEL (modelo explicito; no se elige uno por omision).");
  const maxUsd = Number(env.PM_EVALS_MAX_USD ?? "2");
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("PM_EVALS_MAX_USD debe ser un numero positivo.");
  const k = Number(env.PM_EVALS_K ?? "1");
  if (!Number.isInteger(k) || k < 1 || k > 5) throw new Error("PM_EVALS_K debe ser un entero de 1 a 5.");
  const temperature = env.PM_EVALS_TEMPERATURE === undefined || env.PM_EVALS_TEMPERATURE === "" ? undefined : Number(env.PM_EVALS_TEMPERATURE);
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error("PM_EVALS_TEMPERATURE debe ser un numero entre 0 y 2.");
  const effort = env.PM_EVALS_REASONING;
  if (effort && !["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort)) throw new Error("PM_EVALS_REASONING invalido (none|minimal|low|medium|high|xhigh).");
  const params: OpenRouterModelParams = {
    temperature: temperature ?? "omit",
    ...(effort ? { reasoningEffort: effort as OpenRouterModelParams["reasoningEffort"] } : {}),
    minMaxTokens: 1500,
  };
  return { apiKey: env.OPENROUTER_API_KEY, model: env.PM_EVALS_MODEL, maxUsd, k, params, casos: env.PM_EVALS_CASOS?.split(",").map((s) => s.trim()).filter(Boolean), traza: env.PM_EVALS_TRAZA === "1" };
}

export interface ResultadoReal {
  readonly resultados: readonly (ResultadoCaso & { readonly repeticiones: number })[];
  readonly gastoUsd: number;
  readonly noCorridos: readonly string[];
  readonly cortadoPorTope: boolean;
}

const MAX_TURNOS = 30;

export async function ejecutarSuiteReal(opts: OpcionesReal): Promise<ResultadoReal> {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: opts.maxUsd, maxTenantDailyUsd: opts.maxUsd },
  });
  gateway.registerLadder("pm-evals", [
    new OpenRouterProvider({ id: `openrouter:${opts.model}`, apiKey: opts.apiKey, model: opts.model, params: opts.params ?? { temperature: "omit", minMaxTokens: 1500 }, appName: "Atiende evals", ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) }),
  ]);
  let gasto = 0;
  const llamar = async (system: string, messages: LlmMessage[], tools?: LlmToolDefinition[]) => {
    if (gasto >= opts.maxUsd) throw new TopeDeGasto();
    let r;
    try {
      r = await gateway.complete({ tenantId: "pm-evals", runId: randomUUID(), lane: "interactive", role: "pm-evals", request: { system, messages, tools, temperature: 0, maxOutputTokens: 800 } });
    } catch (err) {
      // Si el presupuesto del gateway se agota antes que `gasto >= maxUsd` (la reserva previa se estima con
      // el tope de tokens), se trata igual que el tope propio: corte limpio con casos no corridos, no un
      // fallo de la corrida. Carril 'interactive': el carril batch solo dejaba gastar ~60% del tope.
      if (isBudgetExceededError(err)) throw new TopeDeGasto();
      throw err;
    }
    gasto += r.costUsd ?? 0;
    return r;
  };
  const suite = cargarSuite();
  const menu = cargarMenu();
  const herramientas: LlmToolDefinition[] = AGENT_TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as unknown as LlmToolDefinition["parameters"] }));
  const seleccion = suite.casos.filter((c) => !opts.casos || opts.casos.includes(c.id));
  const resultados: (ResultadoCaso & { repeticiones: number })[] = [];
  const noCorridos: string[] = [];
  let cortado = false;

  for (const caso of seleccion) {
    if (cortado) {
      noCorridos.push(caso.id);
      continue;
    }
    let ok = true;
    let ultimo: ResultadoCaso | null = null;
    try {
      for (let i = 0; i < opts.k && ok; i++) {
        ultimo = await correrCaso(caso, new Mundo(caso, suite, menu, CONTRATO_OBJETIVO), llamar, herramientas);
        ok = ultimo.ok;
      }
    } catch (err) {
      if (!(err instanceof TopeDeGasto)) throw err;
      cortado = true;
      noCorridos.push(caso.id);
      continue;
    }
    resultados.push({ ...(ultimo as ResultadoCaso), ok, repeticiones: opts.k });
  }
  return { resultados, gastoUsd: gasto, noCorridos, cortadoPorTope: cortado };
}

class TopeDeGasto extends Error {}

type Llamador = (system: string, messages: LlmMessage[], tools?: LlmToolDefinition[]) => Promise<{ text: string; toolCalls?: { id: string; name: string; argumentsJson: string }[] }>;

async function correrCaso(caso: CasoEval, mundo: Mundo, llamar: Llamador, herramientas: LlmToolDefinition[]): Promise<ResultadoCaso> {
  const branches = Object.entries(cargarSuite().fixtures.sucursales).map(([t, s]) => ({ propertyId: t, slug: t.toLowerCase(), name: s.nombre, address: null }));
  const sistema = buildPmSystemPrompt({
    businessName: PM_CONFIG_POR_OMISION.businessName,
    agentName: PM_CONFIG_POR_OMISION.agentName ?? "el asistente virtual",
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: saludoPorHora(caso.contexto.hora_local),
    branches: branches as never,
    entryBranch: { name: mundo.sucursalNombre(caso.contexto.sucursal_contexto), slug: caso.contexto.sucursal_contexto.toLowerCase() },
    customer: { isNew: true },
    fechaHoraLocal: `${caso.contexto.dia} ${caso.contexto.hora_local}`,
    diaSemana: caso.contexto.dia,
  });
  const sistemaCliente = `Usted simula a un cliente de una taqueria que escribe por WhatsApp. Diga solo lo que dicta este guion, de forma natural y breve, y responda con sus datos solo cuando el agente los pregunte.\nApertura: ${caso.simulador_cliente.apertura}\nDatos: ${JSON.stringify(caso.simulador_cliente.datos)}\nGiros en orden: ${caso.simulador_cliente.giros.join(" | ")}\nConteste SIEMPRE lo que el agente le pregunte (con sus datos del guion, "no, gracias" o "no tengo", segun corresponda); si el agente le repite su pedido y le pregunta si es correcto y coincide con lo que usted pidio, responda "Si, es correcto." (o corrijalo si no coincide). Solo cuando el agente le diga que su pedido YA QUEDO REGISTRADO, o que lo pasa con una persona, responda exactamente: FIN. Nunca diga FIN mientras el agente espere una respuesta suya.`;
  const agente: LlmMessage[] = [];
  const cliente: LlmMessage[] = [{ role: "user", content: "Empiece la conversacion." }];
  let siguienteCliente = caso.simulador_cliente.apertura;
  for (let turno = 0; turno < MAX_TURNOS; turno++) {
    mundo.cliente(siguienteCliente);
    agente.push({ role: "user", content: siguienteCliente });
    cliente.push({ role: "assistant", content: siguienteCliente });
    for (let paso = 0; paso < 8; paso++) {
      const r = await llamar(sistema, agente, herramientas);
      const llamadas = r.toolCalls ?? [];
      if (r.text) mundo.agente(r.text);
      if (llamadas.length === 0) {
        agente.push({ role: "assistant", content: r.text });
        break;
      }
      agente.push({ role: "assistant", content: r.text ?? "", toolCalls: llamadas });
      for (const c of llamadas) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.argumentsJson || "{}") as Record<string, unknown>;
        } catch {
          /* argumentos invalidos: la herramienta responde error */
        }
        agente.push({ role: "tool", toolCallId: c.id, content: JSON.stringify(mundo.ejecutar(c.name, args)) });
      }
    }
    const ultimoAgente = [...agente].reverse().find((m) => m.role === "assistant");
    cliente.push({ role: "user", content: ultimoAgente && ultimoAgente.role === "assistant" ? ultimoAgente.content : "" });
    let r = await llamar(sistemaCliente, cliente);
    // Defecto conocido del cliente simulado: a veces corta con FIN dejando sin respuesta la pregunta del agente (p. ej. "¿es correcto?"),
    // y el caso se mide como "no cierra" cuando el agente si estaba cerrando. Si aun no hay pedido ni escalacion y el agente pregunto algo,
    // se le pide una sola vez que conteste, igual que lo haria un cliente real.
    if (/^\s*FIN\b/.test(r.text) && mundo.comandas.length === 0 && mundo.escalaciones.length === 0 && /\?\s*$/.test(ultimoTextoAgente(agente))) {
      cliente.push({ role: "assistant", content: "FIN" });
      cliente.push({ role: "user", content: `El agente sigue esperando su respuesta y el pedido aun no queda registrado. Conteste a su ultimo mensaje segun el guion (no diga FIN todavia): ${ultimoTextoAgente(agente)}` });
      r = await llamar(sistemaCliente, cliente);
    }
    if (/^\s*FIN\b/.test(r.text)) break;
    siguienteCliente = r.text;
  }
  return { ...evaluarCaso(caso, mundo), eventos: mundo.eventos };
}

function ultimoTextoAgente(agente: readonly LlmMessage[]): string {
  const m = [...agente].reverse().find((x) => x.role === "assistant" && x.content.trim() !== "");
  return m && m.role === "assistant" ? m.content : "";
}
