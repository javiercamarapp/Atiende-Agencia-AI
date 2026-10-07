// El turno de WhatsApp aplica el modelo y la temperatura que eligio la organizacion (ajustes del agente): modelo preferido solo para el rol por defecto,
// temperatura solo si la lectura la entrega, y un fallo de lectura NUNCA tumba el turno (sigue con lo de siempre).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionRequest } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { InMemoryRestaurantesRepository } from "../../src/in-memory-repository.ts";
import type { CustomerLookupResult } from "../../src/types.ts";

const NUEVO: CustomerLookupResult = { isNew: true };

function montar() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "org-test", name: "Org Test" });
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  const peticiones: LlmCompletionRequest[] = [];
  const guion = (id: string, model: string) =>
    new FakeLlmProvider({
      id,
      model,
      script: (req) => {
        peticiones.push(req);
        return { text: `responde ${id}`, model, tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    });
  gateway.registerLadder("default", [guion("luna", "openai/gpt-6-luna")]);
  gateway.registerAlternatives("default", [guion("flash", "google/gemini-2.5-flash-lite")]);
  gateway.registerLadder("escalated", [guion("escalado", "openai/gpt-6-luna")]);
  return { repo, organizationId, gateway, peticiones };
}

const turno = (h: ReturnType<typeof createLlmWhatsAppTurnHandler>, organizationId: string) =>
  h.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }], customer: NUEVO });

describe("ajustes del agente en el turno de WhatsApp", () => {
  it("sin ajustes el turno es el de siempre: escalera del rol y temperatura 0", async () => {
    const { repo, organizationId, gateway, peticiones } = montar();
    const h = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    expect((await turno(h, organizationId)).reply).toMatch(/^responde luna\b/);
    expect(peticiones[0]!.temperature).toBe(0);
  });

  it("con modelo y temperatura elegidos: el modelo pasa al frente y la temperatura llega al gateway", async () => {
    const { repo, organizationId, gateway, peticiones } = montar();
    const h = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerAjustes: async () => ({ modelo: "google/gemini-2.5-flash-lite", temperatura: 0.4 }) });
    expect((await turno(h, organizationId)).reply).toMatch(/^responde flash\b/);
    expect(peticiones[0]!.temperature).toBe(0.4);
  });

  it("un modelo elegido que el rol no tiene registrado se ignora: responde la escalera del rol", async () => {
    const { repo, organizationId, gateway } = montar();
    const h = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerAjustes: async () => ({ modelo: "otro/no-registrado", temperatura: 0 }) });
    expect((await turno(h, organizationId)).reply).toMatch(/^responde luna\b/);
  });

  it("si leer los ajustes falla (rechaza) el turno NO se cae: sigue con el modelo y la temperatura de siempre", async () => {
    const { repo, organizationId, gateway, peticiones } = montar();
    const h = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerAjustes: () => Promise.reject(new Error("db caida")) });
    expect((await turno(h, organizationId)).reply).toMatch(/^responde luna\b/);
    expect(peticiones[0]!.temperature).toBe(0);
  });

  it("lee los ajustes de LA organizacion del mensaje (no de otra)", async () => {
    const { repo, organizationId, gateway } = montar();
    const leidas: string[] = [];
    const h = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerAjustes: async (org) => (leidas.push(org), null) });
    await turno(h, organizationId);
    expect(leidas).toEqual([organizationId]);
  });
});
