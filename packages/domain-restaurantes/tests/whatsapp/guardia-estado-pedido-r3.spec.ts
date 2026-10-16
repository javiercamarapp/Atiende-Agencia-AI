// Revision de #508 (ronda 2): la guardia de honestidad NO borra respuestas VERDADERAS de «¿ya salio mi pedido?» cuando el telefono tiene un pedido activo reciente
// (por voz, de hace mas de 2 h, de otro flujo) y SI quita las falsas cuando no hay ninguno o esta cancelado / retenido.
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { lookupCustomerConPedidoReciente } from "../../src/customers.ts";
import { afirmaPedidoRegistrado } from "../../src/whatsapp/guards.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { createOrder } from "../../src/orders.ts";

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id: "c1", name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };
const PHONE = "+5219990007777";

async function turno(mensaje: string, respuestas: LlmCompletionResult[], opts: { status?: string | null; horasAtras?: number;  }) {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  if (opts.status) {
    await createOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Nora", customerPhone: PHONE, canal: "recoger", paymentMethod: "efectivo", source: "whatsapp", items: [{ productId: f.products.cocaCola, requestedQuantity: 1 }] });
    const orders = (f.repo as unknown as { orders: Array<{ status: string; createdAt?: string }> }).orders;
    for (const ord of orders) {
      ord.status = opts.status;
      ord.createdAt = new Date(Date.now() - (opts.horasAtras ?? 0.2) * 3_600_000).toISOString();
    }
  }
  const cola = [...respuestas];
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script: () => cola.shift() ?? texto("ok") })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  const customer = await lookupCustomerConPedidoReciente(f.repo, f.organizationId, PHONE);
  const t = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: mensaje }], customer, propertyId: null });
  return { t, f, customer };
}

const VERDADERAS = [
  "Permítame verificarlo… su pedido va en preparación, confirmado a las 13:05; el tiempo estimado es de 20 minutos.",
  "Su pedido ya está en camino; lo confirmamos a las 12:40.",
  "Su pedido quedó registrado a las 12:40 y va en preparación.",
];

describe("«¿ya salio mi pedido?» con un pedido activo reciente", () => {
  it.each(VERDADERAS)("la respuesta verdadera pasa intacta: %s", async (resp) => {
    const { t, customer } = await turno("¿ya salió mi pedido?", [texto(resp)], { status: "preparando" });
    expect(customer.isNew).toBe(false);
    expect(t.reply.startsWith(resp)).toBe(true);
  });
  it("pedido de hace mas de 2 h (el flujo ya vencio) tambien pasa", async () => {
    const { t } = await turno("¿ya salió mi pedido?", [texto(VERDADERAS[1]!)], { status: "en_camino", horasAtras: 3 });
    expect(t.reply.startsWith(VERDADERAS[1]!)).toBe(true);
  });
  it("sin NINGUN pedido: la afirmacion falsa se quita (no hay nada que respaldar)", async () => {
    const { t } = await turno("¿ya salió mi pedido?", [texto(VERDADERAS[1]!)], { status: null });
    expect(t.reply).not.toMatch(/en camino/);
  });
  it("pedido cancelado: la guardia SI quita «va en camino»", async () => {
    const { t } = await turno("¿ya salió mi pedido?", [texto(VERDADERAS[1]!)], { status: "cancelado" });
    expect(t.reply).not.toMatch(/en camino/);
  });
});

describe("segundo pedido en curso con uno anterior activo", () => {
  it("se quita «ya quedo registrado» del segundo (no existe) pero se conserva la frase de ESTADO del primero", async () => {
    const f0 = await turno("y quiero otro pedido: 2 cocas", [
      llamada("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: "x", product_name: "Coca-Cola", requested_quantity: 2 }] }),
      texto("Su primer pedido ya está en camino. Agregué sus 2 Coca-Cola. Su pedido ya quedó registrado."),
    ], { status: "en_camino" });
    expect(f0.t.reply).toContain("ya está en camino");
    expect(f0.t.reply).not.toMatch(/ya qued[oó] registrado/);
  });
});

describe("afirmaPedidoRegistrado: falsos negativos del revisor", () => {
  it.each([
    "Su pedido ya entró a cocina.",
    "Su comanda ya llegó a cocina.",
    "¡Listo! Su pedido ya va para allá.",
    "Su pedido ya salió a reparto.",
    "Su pedido ya se está cocinando.",
    "Ya quedó registrado, lo esperamos en 20 minutos.",
    "Le confirmo que ya tenemos su pedido.",
    "Su pedido está listo para recoger.",
    "Su orden ya fue aceptada.",
    "Ya dimos de alta su pedido.",
    "Su pedido quedó en el sistema.",
  ])("%s", (f) => expect(afirmaPedidoRegistrado(f)).toBe(true));
  it.each(["Su nombre quedó registrado.", "Su dirección ya quedó registrada.", "Ya quedó anotado su nombre.", "¿Ya salió su pedido?", "Su pago ya quedó registrado."])("no: %s", (f) => expect(afirmaPedidoRegistrado(f)).toBe(false));
});
