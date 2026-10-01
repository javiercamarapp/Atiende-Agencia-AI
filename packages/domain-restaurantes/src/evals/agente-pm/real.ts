// MODO LLM REAL del arnes (manual; NUNCA corre en CI ni en `npm test`). Un LLM hace de agente con el prompt de PM
// y las herramientas del registro sobre el mundo simulado; otro LLM hace de cliente (`simulador_cliente`). Se
// aplican los mismos graders deterministas. Protecciones:
//   * exige PM_EVALS_REAL=1, ANTHROPIC_API_KEY y PM_EVALS_MODEL (sin ellas, lanza antes de cualquier red);
//   * tope de gasto PM_EVALS_MAX_USD (default 2): se acumula el costo de cada llamada y la corrida se corta
//     al alcanzarlo, reportando los casos no corridos;
//   * k repeticiones por caso (PM_EVALS_K, default 1); el caso pasa solo si pasa las k;
//   * tope de 30 turnos por caso (bucle = fallo).
// Uso: PM_EVALS_REAL=1 ANTHROPIC_API_KEY=... PM_EVALS_MODEL=... npm run evals:pm:real -w @atiende/domain-restaurantes
import { randomUUID } from "node:crypto";
import { AnthropicProvider, CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmMessage, LlmToolDefinition } from "@atiende/agent-core";
import { AGENT_TOOL_DEFINITIONS } from "../../agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION } from "../../whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../../whatsapp/perfil-pm.ts";
import { evaluarCaso } from "./graders.ts";
import { CONTRATO_OBJETIVO, Mundo, cargarMenu, cargarSuite } from "./mundo.ts";
import type { CasoEval, ResultadoCaso } from "./tipos.ts";

export interface OpcionesReal {
  readonly apiKey: string;
  readonly model: string;
  readonly maxUsd: number;
  readonly k: number;
  readonly casos?: readonly string[];
}

export function opcionesRealDesdeEntorno(env: Readonly<Record<string, string | undefined>> = process.env): OpcionesReal {
  if (env.PM_EVALS_REAL !== "1") throw new Error("Modo LLM real apagado: define PM_EVALS_REAL=1 (cuesta dinero; nunca corre en CI).");
  if (!env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY.");
  if (!env.PM_EVALS_MODEL) throw new Error("Falta PM_EVALS_MODEL (modelo explicito; no se elige uno por omision).");
  const maxUsd = Number(env.PM_EVALS_MAX_USD ?? "2");
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("PM_EVALS_MAX_USD debe ser un numero positivo.");
  const k = Number(env.PM_EVALS_K ?? "1");
  if (!Number.isInteger(k) || k < 1 || k > 5) throw new Error("PM_EVALS_K debe ser un entero de 1 a 5.");
  return { apiKey: env.ANTHROPIC_API_KEY, model: env.PM_EVALS_MODEL, maxUsd, k, casos: env.PM_EVALS_CASOS?.split(",").map((s) => s.trim()).filter(Boolean) };
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
  gateway.registerLadder("pm-evals", [new AnthropicProvider({ apiKey: opts.apiKey, model: opts.model })]);
  let gasto = 0;
  const llamar = async (system: string, messages: LlmMessage[], tools?: LlmToolDefinition[]) => {
    if (gasto >= opts.maxUsd) throw new TopeDeGasto();
    const r = await gateway.complete({ tenantId: "pm-evals", runId: randomUUID(), lane: "batch", role: "pm-evals", request: { system, messages, tools, temperature: 0, maxOutputTokens: 800 } });
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
    saludo: "Buenas tardes",
    branches: branches as never,
    entryBranch: { name: mundo.sucursalNombre(caso.contexto.sucursal_contexto), slug: caso.contexto.sucursal_contexto.toLowerCase() },
    customer: { isNew: true },
    fechaHoraLocal: `${caso.contexto.dia} ${caso.contexto.hora_local}`,
    diaSemana: caso.contexto.dia,
  });
  const sistemaCliente = `Usted simula a un cliente de una taqueria que escribe por WhatsApp. Diga solo lo que dicta este guion, de forma natural y breve, y responda con sus datos solo cuando el agente los pregunte.\nApertura: ${caso.simulador_cliente.apertura}\nDatos: ${JSON.stringify(caso.simulador_cliente.datos)}\nGiros en orden: ${caso.simulador_cliente.giros.join(" | ")}\nCuando el pedido ya quedo resuelto (o el agente lo paso con una persona), responda exactamente: FIN`;
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
    const r = await llamar(sistemaCliente, cliente);
    if (/^\s*FIN\b/.test(r.text)) break;
    siguienteCliente = r.text;
  }
  return evaluarCaso(caso, mundo);
}
