// QA-PM-R4 whatsapp-02 y reglas-01: la promesa de aviso en infinitivo ("permitame avisar al gerente") y "el aviso quedo registrado" solo se dicen si el aviso existe.
// (Cabecera heredada de R2) guardia de "hablar con una persona" sin falsos positivos (voz-02, whatsapp-06), "ya avise al gerente" solo si el aviso existe
// (whatsapp-04), escalar_a_humano con nombre vacio registra el aviso (whatsapp-03) y una escalacion informativa no congela el pedido (whatsapp-05).
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { afirmaHaberAvisado } from "../src/whatsapp/guards.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

type Script = (request: LlmCompletionRequest) => LlmCompletionResult;
const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
function handlerGuionado(repo: InMemoryRestaurantesRepository, script: Script) {
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "guion", script })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "esc", script })]);
  return createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
}
const PHONE = "+5219990001111";
const entrada = (organizationId: string, contenido: string) => ({ organizationId, phone: PHONE, messages: [{ role: "user" as const, content: contenido }], customer: { isNew: true as const }, propertyId: null });

describe("afirmaHaberAvisado: promesas en infinitivo (QA-PM-R4-whatsapp-02)", () => {
  it("detecta 'permitame avisar', 'voy a avisar' y 'el aviso quedo registrado'", () => {
    for (const t of ["Permítame avisarle al gerente.", "Permítame avisar al equipo para que le orienten.", "Listo, el aviso quedó registrado.", "Ya avisé a la sucursal.", "Ya le avisé al gerente.", "Ya quedó avisado el equipo.", "El aviso ya quedó registrado y le responden pronto."]) expect(afirmaHaberAvisado(t), t).toBe(true);
  });
  it("no confunde futuro, condicional, negacion ni avisos de preparacion", () => {
    for (const t of ["Le voy a avisar a la sucursal que usted pasa a las 8.", "Voy a avisar a la sucursal para que preparen su pedido a las 7.", "Debo avisar al gerente si cambia algo.", "No tengo que avisar a la sucursal.", "Para que le avise a la sucursal necesito su nombre.", "No le avisé al gerente.", "Avisaré a la sucursal.", "Voy a avisar a la sucursal para que tenga listo su pedido.", "No puedo avisar a nadie desde aquí.", "¿Quiere que le avise cuando salga?"]) expect(afirmaHaberAvisado(t), t).toBe(false);
  });
});

describe("el aviso prometido existe en la base", () => {
  it("'Permitame avisar al gerente' sin herramienta deja el aviso de verdad", async () => {
    const f = buildRestaurantFixture();
    const handler = handlerGuionado(f.repo, () => texto("Permítame avisar al gerente para que le confirmen el descuento por el grupo."));
    const out = await handler.handleInboundMessage(entrada(f.organizationId, "me pueden dar un descuento por el grupo?"));
    expect(out.escalacion?.motivo).toBe("otro");
    const avisos = await f.repo.listCallbackRequests(f.organizationId);
    expect(avisos.some((a) => (a.reason ?? "").startsWith("escalada:otro"))).toBe(true);
  });
  it("'el aviso quedo registrado' sin herramienta tambien deja el aviso", async () => {
    const f = buildRestaurantFixture();
    const handler = handlerGuionado(f.repo, () => texto("Listo, el aviso quedó registrado y el equipo le responde."));
    const out = await handler.handleInboundMessage(entrada(f.organizationId, "necesito factura con RFC"));
    expect(out.escalacion?.motivo).toBe("otro");
    expect((await f.repo.listCallbackRequests(f.organizationId)).length).toBe(1);
  });
});
