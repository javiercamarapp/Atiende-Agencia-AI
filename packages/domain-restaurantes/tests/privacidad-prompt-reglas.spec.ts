// PM PR-9 -- el prompt del agente de WhatsApp no lleva la direccion completa del cliente y conserva
// a la vez las reglas de privacidad (PM) y de trato/transparencia (main).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionRequest } from "@atiende/agent-core";
import { PRIVACY_AND_AI_RULES, TRATO_Y_TRANSPARENCIA_RULES, createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import type { CustomerLookupResult } from "../src/types.ts";

const DIRECCION = "Calle 21 #310 x 36 y 38, Col. México, Mérida";
const OTRA = "Calle 60 #500 por 41, Centro";

const KNOWN: CustomerLookupResult = {
  isNew: false,
  name: "Ana",
  orderCount: 3,
  addresses: [
    { address: DIRECCION, label: "Casa", isDefault: true },
    { address: OTRA, label: null, isDefault: false },
  ],
  lastOrderItems: [{ name: "Tacos al pastor", quantity: 3 }],
  frequentItems: [],
  tier: null,
  agentNotes: [],
};

describe("el system prompt completo del turno", () => {
  async function capturedSystem(customer: CustomerLookupResult): Promise<string> {
    const repo = new InMemoryRestaurantesRepository();
    const organizationId = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "org", name: "Org" });
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    let system = "";
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: (request: LlmCompletionRequest) => {
          system = request.system;
          return { text: "hola", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    await handler.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }], customer });
    return system;
  }

  it("NO inyecta la direccion completa del cliente (convive con la referencia parcial de main)", async () => {
    const system = await capturedSystem(KNOWN);
    expect(system).not.toContain(DIRECCION);
    expect(system).not.toContain(OTRA);
    expect(system).not.toContain("Calle 21");
  });

  it("incluye las reglas de privacidad PM y las de trato/transparencia a la vez", async () => {
    const system = await capturedSystem(KNOWN);
    expect(system).toContain(PRIVACY_AND_AI_RULES);
    expect(system).toContain("asistente virtual");
    expect(system).toContain("mis datos personales");
    expect(system).toContain(TRATO_Y_TRANSPARENCIA_RULES);
  });
});
