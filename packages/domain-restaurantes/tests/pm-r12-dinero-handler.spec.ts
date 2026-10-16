// R12 revision #576: la respuesta fija de reembolso SI llega al cliente por el handler completo (no solo por classifyHighRiskIntent), incluso cuando la queja no trae detalle.
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { QUEJA_PREGUNTA_DETALLE } from "../src/whatsapp/guards.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const texto = (text: string) => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
function armar(modelo: string) {
  const f = buildRestaurantFixture();
  const provider = new FakeLlmProvider({ id: "guion", script: () => texto(modelo) });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  return { f, handler };
}
const turno = (organizationId: string, contenido: string) => ({ organizationId, phone: "+5219990001111", messages: [{ role: "user" as const, content: contenido }], customer: { isNew: true as const }, propertyId: null });

describe("R12 reembolso por el handler completo", () => {
  it.each(["Quiero un reembolso de mi pedido", "Devuélvanme mi dinero", "Quiero que me devuelvan mi dinero ahorita"])("sin detalle: %s -> pregunta del detalle Y politica sin devoluciones", async (frase) => {
    const { f, handler } = armar("Con gusto le devolvemos su dinero");
    const t = await handler.handleInboundMessage(turno(f.organizationId, frase));
    expect(t.reply).toContain(QUEJA_PREGUNTA_DETALLE);
    expect(t.reply).toMatch(/no hacemos devoluciones de dinero/);
    expect(t.reply).not.toMatch(/le devolvemos su dinero/i);
  });
  it("una queja sin dinero sigue con el texto fijo de siempre", async () => {
    const { f, handler } = armar("x");
    const t = await handler.handleInboundMessage(turno(f.organizationId, "Quiero poner una queja"));
    expect(t.reply).toBe(QUEJA_PREGUNTA_DETALLE);
  });
});
