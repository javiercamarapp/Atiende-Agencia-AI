// PM PR-9 -- minimizacion: el prompt del agente de WhatsApp (y el resultado de la herramienta
// buscar_cliente que ve el modelo) NO llevan el texto de la direccion del cliente.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionRequest } from "@atiende/agent-core";
import { PRIVACY_AND_AI_RULES, createLlmWhatsAppTurnHandler, customerContextBlock } from "../src/whatsapp/llm-turn-handler.ts";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import type { CustomerLookupResult } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

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

describe("customerContextBlock -- sin direccion en claro", () => {
  it("no incluye el texto de ninguna direccion guardada, pero si que hay direcciones y su etiqueta", () => {
    const block = customerContextBlock(KNOWN);
    expect(block).not.toContain(DIRECCION);
    expect(block).not.toContain(OTRA);
    expect(block).not.toContain("Calle");
    expect(block).toContain("2 direcciones guardadas");
    expect(block).toContain("Casa");
    expect(block).toContain("pídele la dirección completa");
  });

  it("sin direcciones guardadas pide la direccion", () => {
    expect(customerContextBlock({ ...KNOWN, addresses: [] })).toContain("No tiene dirección guardada todavía");
  });

  it("cliente nuevo: pide nombre y direccion (sin cambios)", () => {
    expect(customerContextBlock({ isNew: true })).toContain("Cliente nuevo");
  });
});

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

  it("NO inyecta la direccion completa del cliente (ni la predeterminada ni las otras)", async () => {
    const system = await capturedSystem(KNOWN);
    expect(system).not.toContain(DIRECCION);
    expect(system).not.toContain(OTRA);
    expect(system).not.toContain("Calle 21");
  });

  it("incluye las reglas de asistente virtual / privacidad y el paso de direccion actualizado", async () => {
    const system = await capturedSystem(KNOWN);
    expect(system).toContain(PRIVACY_AND_AI_RULES);
    expect(system).toContain("asistente virtual");
    expect(system).toContain("mis datos personales");
    expect(system).toContain("no la tienes a la vista");
    expect(system).not.toContain("recuérdasela");
  });
});

describe("herramienta buscar_cliente -- lo que ve el modelo", () => {
  it("el result del modelo no lleva el texto de la direccion; raw conserva el resultado completo para el codigo", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const customer = await repo.upsertCustomer(organizationId, "9991111111", "Ana");
    await repo.addCustomerAddressIfNew(customer.id, DIRECCION);
    const outcome = await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: "9991111111" }, "buscar_cliente", {});
    const seenByModel = JSON.stringify(outcome.result);
    expect(seenByModel).not.toContain("Calle 21");
    expect(seenByModel).not.toContain("addresses");
    expect(outcome.result).toMatchObject({ name: "Ana", tiene_direccion_guardada: true, direcciones_guardadas: [{ etiqueta: null, predeterminada: true }] });
    expect(JSON.stringify(outcome.raw)).toContain("Calle 21");
  });

  it("cliente nuevo: resultado sin cambios", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const outcome = await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: "9990000000" }, "buscar_cliente", {});
    expect(outcome.result).toEqual({ isNew: true });
  });
});
