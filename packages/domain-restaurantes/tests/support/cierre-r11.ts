// Soporte de las pruebas del cierre como maquina de estados (R11): sesion de herramientas con historial de WhatsApp y manejador con un LLM GUIONADO (sin red, sin gasto).
import { vi } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { executeAgentToolSafely, invokeAgentTool } from "../../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../../src/agent-tools/order-flow.ts";
import { CIERRE_MAQUINA_ENV } from "../../src/agent-tools/cierre-maquina.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

export type Msg = { role: "user" | "assistant"; content: string };
export const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");

/** Reloj y bandera. `maquina: false` deja la bandera sin definir (camino de main). */
export function prepararEntorno(maquina: boolean): void {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
  vi.stubEnv(CIERRE_MAQUINA_ENV, maquina ? "1" : "");
}
export function limpiarEntorno(): void {
  vi.useRealTimers();
  vi.unstubAllEnvs();
}

export interface OpcionesSetup {
  readonly canal?: "whatsapp" | "voz";
  readonly hist?: Msg[];
  /** Propina solo con tarjeta (por omision) u otra politica de la sucursal. */
  readonly propinaPolitica?: "solo_tarjeta" | "siempre" | "nunca";
}

export function setup(opts: OpcionesSetup = {}) {
  const canal = opts.canal ?? "whatsapp";
  const hist: Msg[] = opts.hist ?? [];
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }], propinaPolitica: opts.propinaPolitica ?? "solo_tarjeta" });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 0;
  const conHistorial = canal === "whatsapp";
  const ctx = (key = "k:wa") => ({
    organizationId: f.organizationId,
    channel: canal,
    phone: "9991234567",
    flow: { key, turn: canal === "voz" ? null : String(turn), now: () => Date.now() },
    ...(conHistorial ? { conversacionReciente: hist.slice(-30) } : {}),
  });
  const items = (qty = 2) => [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: qty }];
  const base = (qty = 2) => ({ branch_slug: "fco-montejo", items: items(qty), canal: "recoger" });
  const call = (tool: string, extra: Record<string, unknown> = {}, qty = 2) => invokeAgentTool(f.repo, ctx(), tool, { ...base(qty), ...extra });
  const snap = () => f.repo.readOrderFlow(f.organizationId, "k:wa");
  const s = {
    f,
    hist,
    ctx,
    quote: (extra: Record<string, unknown> = {}, qty = 2) => call("cotizar_pedido", { payment_method: "efectivo", efectivo_con: 500, ...extra }, qty),
    confirm: () => call("confirmar_resumen"),
    create: (extra: Record<string, unknown> = {}, qty = 2) => call("crear_pedido", { customer_name: "Nora", payment_method: "efectivo", efectivo_con: 500, ...extra }, qty),
    createSafe: (extra: Record<string, unknown> = {}) => executeAgentToolSafely(f.repo, ctx(), "crear_pedido", { ...base(), customer_name: "Nora", payment_method: "efectivo", efectivo_con: 500, ...extra }),
    confirmSafe: () => executeAgentToolSafely(f.repo, ctx(), "confirmar_resumen", { ...base() }),
    total: async () => (await snap())?.context?.quotedTotal as number,
    canonico: async () => (await snap())?.context?.resumenCanonico as string,
    cliente: (t: string) => {
      turn += 1;
      hist.push({ role: "user", content: t });
    },
    asistente: (t: string) => void hist.push({ role: "assistant", content: t }),
    snap,
    muestraResumen: async () => s.asistente(await s.canonico()),
  };
  return s;
}
export type Sesion = ReturnType<typeof setup>;

// ---------------------------------------------------------------------------------------------------------------------
// Manejador de WhatsApp con LLM guionado
// ---------------------------------------------------------------------------------------------------------------------
export const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
export const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
export const PHONE = "+5219990001111";
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };

export type Fixture = ReturnType<typeof buildRestaurantFixture>;

export async function mundo(guion: (paso: number, f: Fixture, req: LlmCompletionRequest) => LlmCompletionResult, cliente: { isNew: true } | { isNew: false; [k: string]: unknown } = { isNew: true }) {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }], propinaPolitica: "solo_tarjeta" });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let paso = 0;
  const provider = new FakeLlmProvider({ id: "guion", script: (request: LlmCompletionRequest) => guion((paso += 1), f, request) });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "escalado-sin-uso" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  const turno = (messages: Msg[]) => handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages, customer: cliente as never, propertyId: null });
  return { f, turno, pasos: () => paso };
}
