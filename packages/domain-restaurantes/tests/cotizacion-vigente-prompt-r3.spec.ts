// QA-PM-R3-whatsapp-01 / 10: en el turno del "si" el modelo ya no tiene que volver a buscar ni cotizar: el prompt lleva la cotizacion vigente que dejo el servidor (renglones resueltos).
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PHONE = "+5219990001111";
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };

async function mundo(perfilPm: boolean) {
  const f = buildRestaurantFixture();
  if (perfilPm) await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const sistemas: string[] = [];
  let paso = 0;
  const provider = new FakeLlmProvider({
    id: "guion",
    script: (request: LlmCompletionRequest) => {
      sistemas.push(request.system);
      paso += 1;
      if (paso === 1) return llamada("c1", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
      return texto("Son 2 Coca-Cola, $90.00. ¿Es correcto?");
    },
  });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "escalado-sin-uso" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  const turno = (messages: Array<{ role: "user" | "assistant"; content: string }>) =>
    handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages, customer: { isNew: true as const }, propertyId: null });
  return { f, sistemas, turno };
}

describe("cotizacion vigente en el prompt", () => {
  it("PM: tras cotizar, el turno siguiente lleva los renglones y el siguiente paso; el turno que cotiza no la lleva", async () => {
    const m = await mundo(true);
    await m.turno([{ role: "user", content: "dos coca para recoger" }]);
    expect(m.sistemas[0]).not.toContain("COTIZACIÓN VIGENTE");
    await m.turno([{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Son $90.00. ¿Es correcto?" }, { role: "user", content: "si" }]);
    const ultimo = m.sistemas.at(-1)!;
    expect(ultimo).toContain("COTIZACIÓN VIGENTE DE ESTA CONVERSACIÓN");
    expect(ultimo).toContain(`product_id ${m.f.products.cocaCola} | Coca-Cola | requested_quantity 2`);
    expect(ultimo).toContain("branch_slug fco-montejo, canal recoger, total a pagar $90");
  });

  it("perfil generico: el prompt no cambia", async () => {
    const m = await mundo(false);
    await m.turno([{ role: "user", content: "dos coca para recoger" }]);
    await m.turno([{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Son $90.00. ¿Es correcto?" }, { role: "user", content: "si" }]);
    expect(m.sistemas.every((s) => !s.includes("COTIZACIÓN VIGENTE"))).toBe(true);
  });
});
