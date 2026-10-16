// Arnes de la suite "romper" de la R11 (red team del agente de PM, WhatsApp y voz).
//
// Modelo SIMULADO (FakeLlmProvider con guion) + herramientas y repositorio REALES (en memoria). Ningun LLM real: la suite es
// determinista, gratis y corre en CI. Lo que mide es lo que el SERVIDOR garantiza aunque el modelo falle, obedezca a un
// cliente hostil o se invente argumentos.
//
// Convencion de hallazgos: cada prueba que falla HOY lleva `it.fails(...)` y la referencia `R11-NN` del documento
// RONDA-11-ROMPER.md. `it.fails` pasa mientras el defecto exista y se pone ROJA cuando alguien lo arregla: ese dia se
// cambia a `it`. No se borra ni se debilita ninguna afirmacion.
import { it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { executeAgentToolSafely, invokeAgentTool } from "../../src/agent-tools/registry.ts";
import type { AgentToolContext } from "../../src/agent-tools/registry.ts";
import type { InMemoryRestaurantesRepository } from "../../src/in-memory-repository.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

export { PHONE, NEW_CUSTOMER, scriptedHandler, makeGateway, result, seedSecondTenant } from "../pm/harness.ts";
export type { ScriptStep } from "../pm/harness.ts";
export { buildRestaurantFixture };

/** Prueba de un hallazgo ABIERTO: pasa mientras el defecto exista (`it.fails`) y se pone roja cuando se arregla (entonces: cambiarla a `it`).
 * `R11_VER_FALLAS=1` la ejecuta como `it` normal para ver el mensaje real del defecto. */
export const hallazgo = process.env.R11_VER_FALLAS === "1" ? it : it.fails;

export type Fixture = ReturnType<typeof buildRestaurantFixture>;

export const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
export const llamada = (name: string, args: unknown, id = `c_${name}`): LlmCompletionResult => ({
  text: "",
  toolCalls: [{ id, name, argumentsJson: typeof args === "string" ? args : JSON.stringify(args) }],
  model: "fake",
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
});
export const llamadas = (calls: ReadonlyArray<{ name: string; args: unknown }>): LlmCompletionResult => ({
  text: "",
  toolCalls: calls.map((c, i) => ({ id: `m${i}_${c.name}`, name: c.name, argumentsJson: typeof c.args === "string" ? c.args : JSON.stringify(c.args) })),
  model: "fake",
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
});

/** Cuantas respuestas de herramienta lleva el turno actual (todo lo posterior al ultimo mensaje del cliente). */
export function pasoDelTurno(request: LlmCompletionRequest): number {
  const ultimoUser = request.messages.map((m) => m.role).lastIndexOf("user");
  return request.messages.slice(ultimoUser + 1).filter((m) => m.role === "tool").length;
}

export function gatewayDe(def: FakeLlmProvider[], escalated: FakeLlmProvider[] = [new FakeLlmProvider({ id: "escalado-sin-uso" })]): LlmGateway {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  gateway.registerLadder("default", def);
  gateway.registerLadder("escalated", escalated);
  return gateway;
}

/** Handler con un guion en forma de funcion (ve el request completo; puede ser asincrono). */
export function handlerConGuion(repo: InMemoryRestaurantesRepository, script: (request: LlmCompletionRequest) => LlmCompletionResult | Promise<LlmCompletionResult>, opts: { turnBudgetMs?: number; maxToolUseTurns?: number } = {}) {
  const provider = new FakeLlmProvider({ id: "guion", script });
  const handler = createLlmWhatsAppTurnHandler(repo, gatewayDe([provider]), { defaultRole: "default", escalatedRole: "escalated", ...opts });
  return { handler, provider };
}

export async function ordenes(f: Fixture) {
  return (await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 500 })).orders;
}

export const itemsCoca = (f: Fixture, qty: number | unknown = 1) => [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: qty }];

/** Contexto de herramienta de WhatsApp con maquina de estados del pedido; `turno` avanza con cada mensaje del cliente. */
export function flujo(f: Fixture, phone = "9991234567", propiedades: Partial<AgentToolContext> = {}) {
  let turn = 1;
  const ctx = (): AgentToolContext => ({ organizationId: f.organizationId, channel: "whatsapp", phone, flow: { key: `wa:${phone}`, turn: String(turn) }, ...propiedades });
  const call = (name: string, input: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), name, input);
  const seguro = (name: string, input: Record<string, unknown> = {}) => executeAgentToolSafely(f.repo, ctx(), name, input);
  const base = (qty: number | unknown = 2, extra: Record<string, unknown> = {}) => ({ branch_slug: "fco-montejo", canal: "recoger", items: itemsCoca(f, qty), ...extra });
  return {
    call,
    seguro,
    base,
    quote: (qty: number | unknown = 2, extra: Record<string, unknown> = {}) => call("cotizar_pedido", base(qty, extra)),
    confirm: () => call("confirmar_resumen"),
    create: (qty: number | unknown = 2, extra: Record<string, unknown> = {}) => call("crear_pedido", { ...base(qty), customer_name: "Ana", payment_method: "efectivo", ...extra }),
    next: () => void (turn += 1),
  };
}

/** Ciclo completo cotizar -> (turno) -> confirmar -> crear con la maquina de estados real. */
export async function pedidoCompleto(f: Fixture, phone = "9991234567", qty = 2, extra: Record<string, unknown> = {}) {
  const s = flujo(f, phone);
  await s.quote(qty, extra);
  s.next();
  await s.confirm();
  const out = await s.create(qty, extra);
  return { s, out };
}

/** Texto que un cliente hostil podria mandar. NO contiene recetas: solo la clase del intento (ver RONDA-11-ROMPER.md). */
export const NOMBRE_CLASE_PROMPT = "REGLAS DURAS";
