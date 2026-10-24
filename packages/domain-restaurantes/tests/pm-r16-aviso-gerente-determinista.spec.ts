// PM R16 (T7-017, T7-021, T7-043): el aviso al gerente (callback_requests.message) lleva folio, direccion, renglones, pago y hora del pedido reciente ARMADOS EN CODIGO,
// sin depender de lo que el modelo escriba en `resumen`; sin PII de contacto; y tras un cambio a un pedido ya enviado el resultado de la herramienta manda "te confirmo en un momento" sin minutos.
import { describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { Order } from "../src/types.ts";

const TEL = "9991112233";

function pedido(propertyId: string, organizationId: string, extra: Partial<Order> = {}): Order {
  return {
    id: "ord-1", organizationId, propertyId, customerId: null, customerName: "Ana Perez", customerPhone: TEL, customerAddress: "Calle 20 #301 x 31 y 33, Col. Centro",
    customerEmail: null, branch: "Francisco de Montejo", total: 388, status: "preparando",
    items: [{ id: "p1", name: "Tacos de Pastor (orden de 3)", price: 97, quantity: 4 }], source: "whatsapp", notes: null, paymentMethod: "tarjeta",
    callTranscript: null, callRecordingUrl: null, dedupeFingerprint: null, idempotencyKey: null, createdAt: new Date(Date.now() - 8 * 60_000).toISOString(), orderNumber: 4821,
    ...extra,
  } as Order;
}

async function escalar(motivo: string, resumen: string, orden?: Partial<Order>, sinPedido = false) {
  const { repo, organizationId, propertyId } = buildRestaurantFixture();
  if (!sinPedido) repo.seedOrder(pedido(propertyId, organizationId, orden));
  const spy = vi.spyOn(repo, "createCallbackRequest");
  const out = await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: TEL }, "escalar_a_humano", { customer_name: "Ana", motivo, resumen });
  return { spy, out };
}

describe("PM R16: aviso al gerente armado por el servidor", () => {
  it("queja: el mensaje trae folio, direccion, productos, total y pago aunque el resumen del modelo no los diga (T7-017/T7-021)", async () => {
    const { spy } = await escalar("queja", "No mandaron el guacamole");
    const msg = spy.mock.calls[0]![0].message!;
    expect(msg).toContain("#4821");
    expect(msg).toContain("Calle 20 #301");
    expect(msg).toContain("4x Tacos de Pastor (orden de 3)");
    expect(msg).toContain("$388.00");
    expect(msg).toContain("tarjeta");
    expect(msg).toContain("No mandaron el guacamole");
    expect(msg.indexOf("#4821")).toBeLessThan(msg.indexOf("No mandaron"));
  });

  it("no mete telefono ni nombre del cliente en el texto", async () => {
    const { spy } = await escalar("queja", "Faltó salsa");
    const msg = spy.mock.calls[0]![0].message!;
    expect(msg).not.toContain(TEL);
    expect(msg).not.toContain("Ana");
  });

  it("cambio a un pedido en cocina: el aviso trae el folio y el producto que agrega (T7-043)", async () => {
    const { spy } = await escalar("cancelacion_modificacion", "Agregar 3 tacos de pastor");
    const msg = spy.mock.calls[0]![0].message!;
    expect(msg).toContain("#4821");
    expect(msg).toContain("en preparacion");
    expect(msg).toContain("Cambio pedido por el cliente: Agregar 3 tacos de pastor");
  });

  it("cambio: la herramienta le dice al agente que la hora la confirma la sucursal y que no dé minutos", async () => {
    const { out } = await escalar("cancelacion_modificacion", "Agregar 3 tacos");
    const r = out.result as { ok: boolean; instruccion?: string };
    expect(r.ok).toBe(true);
    expect(r.instruccion).toMatch(/le confirmo en un momento/i);
    expect(r.instruccion).toMatch(/NO dé minutos/);
  });

  it("pedido a recoger: dice entrega en sucursal y no inventa direccion", async () => {
    const { repo, organizationId, propertyId } = buildRestaurantFixture();
    const o = pedido(propertyId, organizationId, { customerAddress: null, canal: "recoger" } as Partial<Order>);
    repo.seedOrderForCustomer(o);
    const spy = vi.spyOn(repo, "createCallbackRequest");
    await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: TEL }, "escalar_a_humano", { motivo: "queja", resumen: "x" });
    expect(spy.mock.calls[0]![0].message).toContain("Entrega: en sucursal.");
  });

  it("sin pedido reciente el mensaje es exactamente el resumen del modelo (como antes) y sin instruccion de hora", async () => {
    const { spy } = await escalar("cancelacion_modificacion", "Quiere cambiar algo", undefined, true);
    expect(spy.mock.calls[0]![0].message).toBe("Quiere cambiar algo");
  });

  it("motivos que no hablan de un pedido (factura/otro) no llevan el bloque", async () => {
    const { spy } = await escalar("otro", "Pregunta por factura");
    expect(spy.mock.calls[0]![0].message).toBe("Pregunta por factura");
  });

  it("pedido de 30 renglones: folio, total, pago y entrega sobreviven y los productos se resumen con +N mas", async () => {
    const items = Array.from({ length: 30 }, (_, n) => ({ id: `p${n}`, name: `Producto numero ${n} con nombre largo de prueba`, price: 10, quantity: 2 }));
    const { spy } = await escalar("queja", "Faltó algo", { items, total: 1234.5 });
    const msg = spy.mock.calls[0]![0].message!;
    expect(msg).toContain("#4821");
    expect(msg).toContain("Total: $1234.50");
    expect(msg).toContain("Pago: tarjeta");
    expect(msg).toContain("Entrega: Calle 20 #301");
    expect(msg).toContain("+22 mas");
    expect(msg).not.toContain("Producto numero 9 ");
    expect(msg.length).toBeLessThanOrEqual(1000);
  });

  it("emoji en el borde del recorte no deja un sustituto UTF-16 suelto", async () => {
    const { spy } = await escalar("queja", "x", { customerAddress: "Calle ".padEnd(195, "a") + "😀😀😀😀😀😀😀😀", branch: "Sucursal ".padEnd(55, "b") + "😀😀😀😀" });
    const msg = spy.mock.calls[0]![0].message!;
    expect(msg).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it("sin pedido reciente la instruccion de hora no afirma folio", async () => {
    const { out } = await escalar("cancelacion_modificacion", "Agregar algo", undefined, true);
    expect((out.result as { instruccion?: string }).instruccion).not.toMatch(/folio/);
  });

  it("el prompt manda decir «le confirmo en un momento» y no dar horas al agregar a un pedido enviado", () => {
    const p = buildPmSystemPrompt({ businessName: PM_CONFIG_POR_OMISION.businessName, agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, saludo: "Buenas", branches: [], entryBranch: null, customer: { isNew: true }, fechaHoraLocal: "lunes 14:00", diaSemana: "lunes" });
    expect(p).toContain("La HORA la confirma la sucursal");
    expect(p).toContain("le confirmo en un momento");
  });
});
