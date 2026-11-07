// Cerebro v2 en el turno de WhatsApp: la bandera por organizacion pide ZDR estricto (Luna -> Haiku), y con el perfil PM las reglas del suelto
// deciden antes del modelo. Sin bandera el turno es el de siempre.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { InMemoryRestaurantesRepository } from "../../src/in-memory-repository.ts";
import { TRANSFERENCIA_REALIZADA_REPLY } from "../../src/whatsapp/cerebro-v2/pago.ts";
import { SALUD_REACCION_REPLY } from "../../src/whatsapp/cerebro-v2/salud.ts";
import type { CustomerLookupResult } from "../../src/types.ts";

const NUEVO: CustomerLookupResult = { isNew: true };

async function montar(opts: { pm?: boolean } = {}) {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "org-test", name: "Org Test" });
  if (opts.pm) await repo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  const llamados: string[] = [];
  const guion = (id: string, model: string, falla = false) =>
    new FakeLlmProvider({
      id,
      model,
      script: () => {
        llamados.push(id);
        if (falla) throw Object.assign(new Error("OpenRouter 502"), { status: 502 });
        return { text: `responde ${id}`, model, tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    });
  gateway.registerLadder("default", [guion("luna", "openai/gpt-6-luna"), guion("muse-sin-zdr", "meta/muse-spark-1.3")]);
  gateway.registerLadder("escalated", [guion("escalado", "openai/gpt-6-luna")]);
  return { repo, organizationId, gateway, llamados, guion };
}

const turno = (h: ReturnType<typeof createLlmWhatsAppTurnHandler>, organizationId: string, texto = "hola") =>
  h.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: texto }], customer: NUEVO });

describe("cerebro v2 en el turno de WhatsApp", () => {
  it("sin bandera: escalera de siempre", async () => {
    const { repo, organizationId, gateway, guion } = await montar();
    gateway.registerZdrLadder("default", [guion("luna-zdr", "openai/gpt-6-luna")]);
    const h = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerCerebroV2: async () => false });
    expect((await turno(h, organizationId)).reply).toMatch(/^responde luna\b/);
  });

  it("con bandera: solo la escalera ZDR (Luna -> Haiku); nunca un proveedor sin ZDR", async () => {
    const { repo, organizationId, gateway, guion, llamados } = await montar();
    gateway.registerZdrLadder("default", [guion("luna-zdr", "openai/gpt-6-luna", true), guion("haiku-zdr", "anthropic/claude-haiku-5.5")]);
    const h = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerCerebroV2: async () => true });
    expect((await turno(h, organizationId)).reply).toMatch(/responde haiku-zdr/);
    expect(llamados).not.toContain("muse-sin-zdr");
    expect(llamados).not.toContain("luna");
  });

  it("si leer la bandera falla, el turno sigue con el agente de siempre", async () => {
    const { repo, organizationId, gateway } = await montar();
    const h = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerCerebroV2: () => Promise.reject(new Error("db caida")) });
    expect((await turno(h, organizationId)).reply).toMatch(/^responde luna\b/);
  });

  it("PM con bandera: «ya transferí» se pasa a una persona sin llamar al modelo", async () => {
    const { repo, organizationId, gateway, guion, llamados } = await montar({ pm: true });
    gateway.registerZdrLadder("default", [guion("luna-zdr", "openai/gpt-6-luna")]);
    const h = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerCerebroV2: async () => true });
    const r = await turno(h, organizationId, "ya te transferí, te mando el comprobante");
    expect(r.reply).toBe(TRANSFERENCIA_REALIZADA_REPLY);
    expect(llamados).toHaveLength(0);
  });

  it("PM con bandera: emergencia de salud = respuesta fija y aviso; sin bandera sigue el clasificador de siempre", async () => {
    const { repo, organizationId, gateway, guion } = await montar({ pm: true });
    gateway.registerZdrLadder("default", [guion("luna-zdr", "openai/gpt-6-luna")]);
    const v2 = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerCerebroV2: async () => true });
    const r = await turno(v2, organizationId, "auxilio, se me está cerrando la garganta, el taco tenía cacahuate");
    expect(r.reply).toBe(SALUD_REACCION_REPLY);
    expect((r as { escalacion?: { motivo: string } }).escalacion?.motivo).toBe("alergia_salud");
  });
});
