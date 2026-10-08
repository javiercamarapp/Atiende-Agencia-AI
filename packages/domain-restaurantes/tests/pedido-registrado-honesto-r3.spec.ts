// QA-PM-R3 T7-040 (P0): tras el "si, esta correcto" y un "agregame pina" el agente dijo "el pedido ya quedo confirmado" sin pedido en la base (afirmacion falsa de registro).
// Guardia del servidor: esa afirmacion solo sale si el pedido existe.
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { afirmaPedidoRegistrado, quitarAfirmacionDePedidoRegistrado } from "../src/whatsapp/guards.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { seedConfirmedOrderFlow } from "./support/order-flow-seed.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

describe("afirmaPedidoRegistrado", () => {
  it.each(["El pedido ya quedó confirmado.", "Su pedido quedó registrado", "Ya registré su pedido.", "Ya lo confirmamos.", "Su pedido ya está en cocina.", "Listo, su pedido fue registrado."])("afirma: %s", (t) => {
    expect(afirmaPedidoRegistrado(t)).toBe(true);
  });
  it.each(["¿Me confirma para que quede registrado su pedido?", "Cuando confirme, queda registrado.", "Todavía no queda registrado su pedido.", "Si dice que sí, lo registro.", "Aún no está confirmado.", "El total es de $168."])("no afirma: %s", (t) => {
    expect(afirmaPedidoRegistrado(t)).toBe(false);
  });
  it("quita solo la frase falsa; si no queda nada, pide el si al resumen", () => {
    expect(quitarAfirmacionDePedidoRegistrado("Agregué la piña. El pedido ya quedó confirmado. ¿Algo más?")).toBe("Agregué la piña. ¿Algo más?");
    expect(quitarAfirmacionDePedidoRegistrado("El pedido ya quedó confirmado.")).toMatch(/Todavía no queda registrado su pedido\. ¿Me confirma con un «sí»/);
    expect(quitarAfirmacionDePedidoRegistrado("Son $168.")).toBe("Son $168.");
  });
});

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PHONE = "+5219990001111";
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };

async function turnoConRespuesta(respuesta: string, opts: { perfilPm: boolean; flowCreado?: boolean }) {
  const f = buildRestaurantFixture();
  if (opts.perfilPm) await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script: () => texto(respuesta) })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  if (opts.flowCreado) {
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] });
    const snap = await f.repo.readOrderFlow(f.organizationId, `wa:${PHONE}`);
    await f.repo.writeOrderFlow(f.organizationId, `wa:${PHONE}`, snap!.version, { state: "creado", context: { ...snap!.context!, orderId: "00000000-0000-4000-8000-000000000001" } }, 3600);
  }
  return handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: "si, esta correcto, agregame una piña" }], customer: { isNew: true as const }, propertyId: null });
}

describe("el turno no afirma un pedido que no existe", () => {
  it("PM sin pedido: la afirmacion falsa se quita y se pide el si", async () => {
    const t = await turnoConRespuesta("El pedido ya quedó confirmado.", { perfilPm: true });
    expect(t.reply).not.toMatch(/qued[oó] confirmado/);
    expect(t.reply).toMatch(/^¿/); // queda la pregunta del paso pendiente que anexa el servidor, sin la mentira
    expect(t.orderId).toBeNull();
  });
  it("PM con un pedido ya creado en la conversacion: puede decirlo", async () => {
    const t = await turnoConRespuesta("Su pedido ya quedó registrado.", { perfilPm: true, flowCreado: true });
    expect(t.reply).toContain("Su pedido ya quedó registrado.");
  });
  it("perfil generico: el texto no se toca", async () => {
    const t = await turnoConRespuesta("El pedido ya quedó confirmado.", { perfilPm: false });
    expect(t.reply).toContain("quedó confirmado");
  });
});
