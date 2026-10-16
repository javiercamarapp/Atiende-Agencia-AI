// Pedido de CLIENTE REINCIDENTE retenido: el servidor no crea el pedido y deja un aviso para la sucursal, pero ANTES devolvia solo `mensaje` (instruccion para el
// modelo) sin `mensaje_al_cliente`. Si el turno agotaba vueltas, el proveedor caia o el modelo contestaba vacio, el cliente recibia el texto generico de fallo
// ("Se me complico..."/"problema tecnico") o nada util, y el equipo un segundo aviso `falla_sistema`/`no_puedo_resolver`. Ahora el turno recorre el modelo guionado
// completo y afirma el EFECTO: el cliente lee el mensaje del servidor, hay UN solo aviso (aprobacion_pedido_cliente) y no se crea ningun pedido.
// Reloj fijo, sin tocar la zona del proceso.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { invokeAgentTool, MENSAJE_PEDIDO_REINCIDENTE_RETENIDO } from "../src/agent-tools/registry.ts";
import { createOrder } from "../src/orders.ts";
import type { Order } from "../src/types.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// Martes 2026-10-06 13:00 en Merida (UTC-6).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

const PHONE = "9991234567";
const PHONE_WA = "+5219991234567";
const FALLO = /Se me complic[óo]|Ya avis[ée] al equipo|problema t[ée]cnico|¿Me puede repetir/i;
const NO_ACUSAR = /falso|fraude|no recogi|historial|reincid/i;
const NO_REGISTRADO = /ya qued[óo] registrado|se mand[óo] a cocina|¡listo!/i;

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id: `c_${name}_${Math.random()}`, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
function pasoDelTurno(request: LlmCompletionRequest): number {
  const ultimoUser = request.messages.map((m) => m.role).lastIndexOf("user");
  return request.messages.slice(ultimoUser + 1).filter((m) => m.role === "tool").length;
}

/** Fixture con un cliente que ya tiene `noRecogidos` pedidos no recogidos recientes (umbral por omision: 2 en 90 dias). */
async function mundoConReincidente(noRecogidos: number) {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "23:00" }] });
  const base = await createOrder(f.repo, { notes: "base", organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Ana", customerPhone: PHONE, customerAddress: "Calle 50 #200, Col. Centro", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp", paymentMethod: "efectivo" });
  // (el pedido base es de 2 piezas para que el de 1 pieza de la prueba no cuente como duplicado de "hace 0 minutos")
  for (let i = 0; i < noRecogidos; i += 1) {
    f.repo.seedOrderForCustomer({
      id: randomUUID(), organizationId: f.organizationId, propertyId: f.propertyId, customerId: base.customerId!, customerName: "Ana", customerPhone: PHONE, customerAddress: null, customerEmail: null,
      branch: "Francisco de Montejo", total: 45, status: "no_recogido", items: [], source: "whatsapp", notes: null, paymentMethod: "efectivo", callTranscript: null, callRecordingUrl: null, dedupeFingerprint: null,
      idempotencyKey: null, createdAt: new Date(Date.now() - (10 + i * 20) * 86_400_000).toISOString(), assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null,
    } as Order);
  }
  return f;
}

type TrasCrear = "texto_vacio" | "proveedor_falla" | "sigue_con_herramientas" | "modelo_redacta";

async function turnoDeConfirmacion(f: Awaited<ReturnType<typeof mundoConReincidente>>, trasCrear: TrasCrear) {
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
  let caido = false;
  const script = (request: LlmCompletionRequest): LlmCompletionResult => {
    if (caido) throw new Error("proveedor caido");
    const paso = pasoDelTurno(request);
    const ultimo = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (/quiero/i.test(ultimo) && !/confirmo/i.test(ultimo)) return paso === 0 ? llamada("cotizar_pedido", base) : texto("Es 1 Coca-Cola, el total es $45. ¿Confirma y cómo paga?");
    if (paso === 0) return llamada("confirmar_resumen", {});
    if (paso === 1) return llamada("crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo" });
    if (trasCrear === "modelo_redacta") return texto("Listo, la sucursal confirmará su pedido en un momento.");
    if (trasCrear === "texto_vacio") return texto("");
    if (trasCrear === "proveedor_falla") {
      caido = true;
      throw new Error("proveedor caido");
    }
    return llamada("buscar_cliente", { phone: PHONE });
  };
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "guion", script })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "esc", script })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", now: () => new Date() });
  const comun = { organizationId: f.organizationId, phone: PHONE_WA, customer: { isNew: true as const }, propertyId: null };
  const pedido1 = "Hola, quiero 1 coca cola para recoger";
  const t1 = await handler.handleInboundMessage({ ...comun, messages: [{ role: "user", content: pedido1 }] });
  return handler.handleInboundMessage({ ...comun, messages: [{ role: "user", content: pedido1 }, { role: "assistant", content: t1.reply }, { role: "user", content: "Sí confirmo, pago en efectivo" }] });
}

describe("crear_pedido de un reincidente: el resultado lleva el mensaje para el cliente", () => {
  it("devuelve mensaje_al_cliente (sin motivos ni historial ni hora) y marca pedidoRetenido; no crea pedido", async () => {
    const f = await mundoConReincidente(2);
    const out = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: PHONE }, "crear_pedido", {
      branch_slug: "fco-montejo", customer_name: "Ana", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }], payment_method: "efectivo", canal: "recoger",
    });
    const result = out.result as { pedido_retenido?: boolean; mensaje_al_cliente?: unknown };
    expect(result.pedido_retenido).toBe(true);
    expect(result.mensaje_al_cliente).toBe(MENSAJE_PEDIDO_REINCIDENTE_RETENIDO);
    expect(MENSAJE_PEDIDO_REINCIDENTE_RETENIDO).toMatch(/la sucursal confirma su pedido/i);
    expect(MENSAJE_PEDIDO_REINCIDENTE_RETENIDO).not.toMatch(NO_ACUSAR);
    expect(MENSAJE_PEDIDO_REINCIDENTE_RETENIDO).not.toMatch(/\d{1,2}:\d{2}|minutos|hora/i);
    expect(out.pedidoRetenido).toBe(true);
    expect(out.orderId).toBeNull();
  });

  it("control: un cliente SIN reincidencia no recibe el mensaje de retenido y su pedido se crea", async () => {
    const f = await mundoConReincidente(1);
    const out = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: PHONE }, "crear_pedido", {
      branch_slug: "fco-montejo", customer_name: "Ana", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }], payment_method: "efectivo", canal: "recoger", notes: "otro",
    });
    expect(out.orderId).not.toBeNull();
    expect(out.pedidoRetenido).toBeUndefined();
    expect((out.result as { mensaje_al_cliente?: unknown }).mensaje_al_cliente).toBeUndefined();
  });
});

describe("turno completo con reincidente retenido: el cliente lee el mensaje del servidor", () => {
  it.each(["texto_vacio", "proveedor_falla", "sigue_con_herramientas"] as const)("tras retenerlo el modelo: %s", async (trasCrear) => {
    const f = await mundoConReincidente(2);
    const t2 = await turnoDeConfirmacion(f, trasCrear);
    expect(t2.reply).toContain(MENSAJE_PEDIDO_REINCIDENTE_RETENIDO);
    expect(t2.reply).not.toMatch(FALLO);
    expect(t2.reply).not.toMatch(NO_REGISTRADO);
    expect(t2.reply).not.toMatch(NO_ACUSAR);
    // Un solo aviso (el de la reincidencia): ni falla_sistema ni no_puedo_resolver, y ningun pedido nuevo.
    expect(f.repo.listCallbackRequests(f.organizationId).map((a) => a.reason)).toEqual(["aprobacion_pedido_cliente"]);
    expect(t2.orderId).toBeNull();
    expect((await f.repo.getCustomerMemory(f.organizationId, PHONE))?.orders).toHaveLength(1);
  });

  it("si el modelo SI redacta, su texto manda (el respaldo no pisa una respuesta normal)", async () => {
    const f = await mundoConReincidente(2);
    const t2 = await turnoDeConfirmacion(f, "modelo_redacta");
    expect(t2.reply).toMatch(/la sucursal confirmar/i);
    expect(t2.reply).not.toMatch(FALLO);
  });
});
