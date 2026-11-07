// C3 PED-22 (cerebro v2), dos defectos:
//  (a) el pedido se creo con pago «tarjeta» aunque el cliente NUNCA dijo forma de pago (el modelo la invento): con cerebro v2 crear_pedido exige que el cliente la haya dicho.
//  (b) tras crear, «Perdón, yo pago en efectivo, no con tarjeta» se escalo como cancelacion_modificacion: con cerebro v2 un cambio SOLO de forma de pago en un pedido aun no
//      despachado actualiza el pedido (con nota para la sucursal) y se le confirma al cliente, sin escalar.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { cambioSoloDeFormaDePago } from "../src/whatsapp/cerebro-v2/pago.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { nuevoViaje, pedidosDe, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";

const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos", escalationReasonsOff: [] };

async function mundo() {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const base = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", entryPropertyId: f.propertyId };
  const pedido = { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }], customer_name: "Lucero May", payment_method: "tarjeta" };
  return { f, base, pedido };
}
const hilo = (...textos: string[]) => textos.map((content, i) => ({ role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant", content }));

describe("PED-22 (a) crear_pedido sin forma de pago dicha por el cliente", () => {
  it("con cerebro v2: se rechaza y manda preguntar efectivo o tarjeta", async () => {
    const m = await mundo();
    const conversacionReciente = hilo("Hola, dos cocas para recoger, a nombre de Lucero May", "Le cotizo: 2 Coca-Cola, total $90. ¿Es correcto?", "Sí, así está bien, gracias.");
    await expect(invokeAgentTool(m.f.repo, { ...m.base, cerebroV2: true, conversacionReciente }, "crear_pedido", m.pedido)).rejects.toThrow(/efectivo o con tarjeta/);
  });
  it("con cerebro v2: si el cliente dijo la forma de pago, se crea con esa", async () => {
    const m = await mundo();
    const conversacionReciente = hilo("Hola, dos cocas para recoger, a nombre de Lucero May. Pago con tarjeta", "Le cotizo: 2 Coca-Cola, total $90. ¿Es correcto?", "Sí");
    const r = await invokeAgentTool(m.f.repo, { ...m.base, cerebroV2: true, conversacionReciente }, "crear_pedido", m.pedido);
    expect(r.orderId).toBeTruthy();
  });
  it("con cerebro v2: el cliente dijo efectivo y el modelo manda tarjeta => se rechaza", async () => {
    const m = await mundo();
    const conversacionReciente = hilo("Dos cocas para recoger, Lucero May, pago en efectivo", "Total $90. ¿Es correcto?", "Sí");
    await expect(invokeAgentTool(m.f.repo, { ...m.base, cerebroV2: true, conversacionReciente }, "crear_pedido", m.pedido)).rejects.toThrow(/efectivo o con tarjeta/);
  });
  it("sin la bandera: se crea como siempre", async () => {
    const m = await mundo();
    const conversacionReciente = hilo("Hola, dos cocas para recoger, a nombre de Lucero May", "Total $90. ¿Es correcto?", "Sí, así está bien, gracias.");
    const r = await invokeAgentTool(m.f.repo, { ...m.base, conversacionReciente }, "crear_pedido", m.pedido);
    expect(r.orderId).toBeTruthy();
  });
});

describe("PED-22 (b) cambioSoloDeFormaDePago (pura)", () => {
  it("reconoce el cambio de pago a secas", () => {
    expect(cambioSoloDeFormaDePago("Perdón, yo pago en efectivo, no con tarjeta.")).toEqual({ pago: "efectivo" });
    expect(cambioSoloDeFormaDePago("Ok, gracias. Pago en efectivo con un billete de 600, por si me lo preguntan")).toEqual({ pago: "efectivo", efectivoCon: 600 });
    expect(cambioSoloDeFormaDePago("Mejor pago con tarjeta, no en efectivo")).toEqual({ pago: "tarjeta" });
  });
  it("no lo confunde con cancelaciones, cambios de producto, preguntas o pagos sin cambio", () => {
    expect(cambioSoloDeFormaDePago("Cancela mi pedido, pago en efectivo")).toBeNull();
    expect(cambioSoloDeFormaDePago("Pago en efectivo y agrégale una horchata")).toBeNull();
    expect(cambioSoloDeFormaDePago("¿Aceptan tarjeta?")).toBeNull();
    expect(cambioSoloDeFormaDePago("Ya les transferí")).toBeNull();
    expect(cambioSoloDeFormaDePago("Hola, buenas tardes")).toBeNull();
  });
});

describe("PED-22 (b) turno completo: cambio de forma de pago de un pedido ya creado", () => {
  const enMerida = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(enMerida("2026-10-13", "19:00"));
  });
  afterEach(() => vi.useRealTimers());

  async function conPedidoConTarjeta(v: Viaje) {
    const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Lucero May", payment_method: "tarjeta", items } }] },
      { texto: "Permítame repetirle su pedido: 4 Coca-Cola a domicilio, pago con tarjeta. Total $212.00. ¿Es correcto?" },
    ]);
    await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, Lucero May, con tarjeta");
    v.guion([{ texto: "Su pedido ya quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.paymentMethod).toBe("tarjeta");
    return pedidos[0]!;
  }

  it("con cerebro v2: actualiza el pago del pedido, deja nota para la sucursal y no escala", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    const pedido = await conPedidoConTarjeta(v);
    const avisosAntes = v.callbacks.length;
    const r = await v.escribe("Perdón, yo pago en efectivo, no con tarjeta.");
    expect(r.escalated ?? false).toBe(false);
    expect(v.callbacks.length).toBe(avisosAntes);
    expect(r.reply).toMatch(/efectivo/);
    expect(r.reply).toMatch(/con cuánto paga/i);
    let actual = await v.world.repo.findOrderById(v.world.organizationId, pedido.id);
    expect(actual!.paymentMethod).toBe("efectivo");
    expect(actual!.notes ?? "").toMatch(/forma de pago.*efectivo/i);
    const r2 = await v.escribe("Ok, gracias. Pago en efectivo con un billete de 600, por si me lo preguntan");
    expect(r2.escalated ?? false).toBe(false);
    expect(v.callbacks.length).toBe(avisosAntes);
    actual = await v.world.repo.findOrderById(v.world.organizationId, pedido.id);
    expect(actual!.paymentMethod).toBe("efectivo");
    expect(actual!.notes ?? "").toMatch(/600/);
  });

  it("sin la bandera: el camino de siempre (no se cambia el pedido)", async () => {
    const v = await nuevoViaje();
    const pedido = await conPedidoConTarjeta(v);
    await v.escribe("Perdón, yo pago en efectivo, no con tarjeta.");
    const actual = await v.world.repo.findOrderById(v.world.organizationId, pedido.id);
    expect(actual!.paymentMethod).toBe("tarjeta");
  });
});
void randomUUID;
void TEL_CLIENTE;
