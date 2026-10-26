// QA-PM-R16 (P0 de dinero): en NU-4 ($126) y T7-026 ($2,000) el modelo escalo como `pedido_grande` tras el "si" SIN llamar a crear_pedido y le dijo al cliente
// "el pedido quedo con un total de $126". Nunca se afirma que el pedido quedo sin evidencia de herramienta (crear_pedido ok); si el aviso al equipo SI existe,
// se le dice la verdad: el pedido todavia no esta registrado y la sucursal lo confirma.
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { lookupCustomerConPedidoReciente } from "../../src/customers.ts";
import { afirmaPedidoRegistrado } from "../../src/whatsapp/guards.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { seedConfirmedOrderFlow } from "../support/order-flow-seed.ts";
import { PM_COPY } from "../../src/whatsapp/perfil-pm.ts";
import { RESPUESTA_TOQUE_RETENIDO } from "../../src/whatsapp/botones-confirmacion.ts";

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id: "c1", name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };
const PHONE = "+5219990008888";

async function turno(mensaje: string, respuestas: LlmCompletionResult[]) {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const cola = [...respuestas];
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script: () => cola.shift() ?? texto("ok") })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  const customer = await lookupCustomerConPedidoReciente(f.repo, f.organizationId, PHONE);
  const t = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: mensaje }], customer, propertyId: null });
  return { t, f };
}

// R21 (T7-061): una compra de $126 ya no se escala como `pedido_grande` (lo fija el servidor); el modelo la escala por el tiempo que pide el cliente. Las aserciones de honestidad no cambian.
const ESCALA = llamada("escalar_a_humano", { customer_name: "Carlos", motivo: "tiempos_entrega", resumen: "3 tacos al pastor, $126, efectivo, recoger en 40 minutos." });

describe("afirmaPedidoRegistrado: «quedo» sin participio (NU-4)", () => {
  it.each([
    "Carlos, el pedido quedó con un total de $126.",
    "Su pedido quedó para las 7 pm, a nombre de Carlos.",
    "El pedido ya quedó por $2,000 en efectivo.",
  ])("%s", (f) => expect(afirmaPedidoRegistrado(f)).toBe(true));
  it.each(["Su pedido todavía no quedó registrado.", "Para que el pedido quede con ese total, responda sí.", "Su dirección quedó con la colonia Centro."])("no: %s", (f) => expect(afirmaPedidoRegistrado(f)).toBe(false));
});

describe("escalada sin pedido: el turno no miente (NU-4 / T7-026)", () => {
  it("«el pedido quedó con un total de $126» tras escalar sin crear_pedido: se quita y se dice que la sucursal lo confirma", async () => {
    const { t, f } = await turno("Sí, correcto. A nombre de Carlos Prueba, paso en 40 minutos.", [
      ESCALA,
      texto("Carlos, el pedido quedó con un total de $126. Ya avisé a la sucursal para que confirme el tiempo de preparación; le responderán en cuanto puedan."),
    ]);
    expect(t.reply).not.toMatch(/qued[oó] con/);
    expect(t.reply).toMatch(/todav[ií]a no (?:est[aá]|queda) (?:registrado|confirmado)/i);
    expect(t.reply).toMatch(/sucursal/i);
    expect((f.repo as unknown as { orders: unknown[] }).orders).toHaveLength(0);
  });
  it("la frase de aviso VERDADERA (hay escalar_a_humano ok) se conserva", async () => {
    const { t } = await turno("Sí, correcto.", [ESCALA, texto("Su pedido quedó registrado por $2,000. Ya avisé a la sucursal para que lo confirme.")]);
    expect(t.reply).toMatch(/Ya avisé a la sucursal/);
    expect(t.reply).not.toMatch(/qued[oó] registrado/);
  });
  it("sin escalar ni crear: «quedó con» se quita (el «ya avisé» lo respalda el aviso honesto que el servidor deja)", async () => {
    const { t } = await turno("Sí, correcto.", [texto("Listo, el pedido quedó con un total de $126. Ya avisé a la sucursal.")]);
    expect(t.reply).not.toMatch(/qued[oó] con/);
  });
});

describe("matices de la guardia (revision de #616)", () => {
  it("la respuesta era SOLO «quedó con $126» y hubo escalada: dice la verdad una vez, sin pedir otro «sí»", async () => {
    const { t } = await turno("Sí, correcto.", [ESCALA, texto("Carlos, el pedido quedó con un total de $126.")]);
    expect(t.reply).toBe(PM_COPY.pedidoSinRegistrarEscalado);
    expect(t.reply).not.toMatch(/me confirma con un/i);
  });
  async function conFlujo(estado: "creado-con-id" | "creado-sin-id", respuestas: LlmCompletionResult[]) {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
    const cola = [...respuestas];
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script: () => cola.shift() ?? texto("ok") })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] });
    const snap = await f.repo.readOrderFlow(f.organizationId, `wa:${PHONE}`);
    const ctx = snap!.context!;
    await f.repo.writeOrderFlow(f.organizationId, `wa:${PHONE}`, snap!.version, { state: "creado" as const, context: estado === "creado-con-id" ? { ...ctx, orderId: "00000000-0000-4000-8000-000000000001" } : ctx }, 3600);
    return handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: "sí, correcto" }], customer: { isNew: true as const }, propertyId: null });
  }
  it("con pedido creado (evidencia de crear_pedido), «quedó con $126» SE CONSERVA", async () => {
    const t = await conFlujo("creado-con-id", [texto("Carlos, el pedido quedó con un total de $126.")]);
    expect(t.reply).toContain("quedó con un total de $126");
    expect(t.reply).not.toContain(PM_COPY.pedidoSinRegistrarEscalado);
  });
  it("con pedido retenido vigente no se añade la frase de «no registrado» (manda el aviso de retenido)", async () => {
    const t = await conFlujo("creado-sin-id", [ESCALA, texto("Carlos, el pedido quedó con un total de $126.")]);
    expect(t.reply).toBe(RESPUESTA_TOQUE_RETENIDO);
    expect(t.reply).not.toContain(PM_COPY.pedidoSinRegistrarEscalado);
  });
});
