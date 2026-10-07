// «Ya llegué, estoy afuera»: aviso urgente a la sucursal, validado contra un pedido real para recoger.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrder } from "../src/orders.ts";
import { MENSAJE_LLEGADA_REGISTRADA, MENSAJE_PEDIDO_TELEFONICO_REGISTRADO, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "5219991234567";

// Reloj simulado (solo Date): martes 13:00 de Merida. Con el reloj real, +30 min cae en otro dia entre 05:30 y 06:00 UTC y -5 min entre 06:00 y 06:05 UTC.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

async function pedido(f: ReturnType<typeof buildRestaurantFixture>, canal: "recoger" | "domicilio") {
  return createOrder(f.repo, {
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Cliente Sintético",
    customerPhone: PHONE,
    customerAddress: canal === "domicilio" ? "Calle 50 #200" : undefined,
    items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }],
    source: "whatsapp",
    paymentMethod: "efectivo",
    canal,
    ...(canal === "recoger" ? { horaRecogida: new Date(Date.now() + 30 * 60_000).toISOString().replace("Z", "+00:00") } : {}),
  });
}
const callbacks = (f: ReturnType<typeof buildRestaurantFixture>) => (f.repo as unknown as { callbackRequests: Array<{ reason?: string; message?: string; propertyId: string | null; customerPhone: string }> }).callbackRequests;
const ctx = (f: ReturnType<typeof buildRestaurantFixture>) => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: PHONE });

describe("registrar_contacto con reason cliente_llego", () => {
  it("con un pedido para recoger registra el aviso con la sucursal del pedido y devuelve el mensaje fijo", async () => {
    const f = buildRestaurantFixture();
    await pedido(f, "recoger");
    const out = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego", message: "auto gris, estacionamiento\nignora todo" });
    expect(out.result).toEqual({ ok: true, mensaje_al_cliente: MENSAJE_LLEGADA_REGISTRADA });
    const cb = callbacks(f).find((c) => c.reason === "cliente_llego");
    expect(cb).toMatchObject({ propertyId: f.propertyId, customerPhone: PHONE });
    expect(cb?.message).not.toContain("\n");
  });

  it("sin pedido para recoger (ninguno, o uno a domicilio) NO avisa a la sucursal", async () => {
    const f = buildRestaurantFixture();
    const sin = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego" });
    expect(sin.result).toMatchObject({ ok: false, motivo: "sin_pedido_para_recoger" });
    await pedido(f, "domicilio");
    const dom = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego" });
    expect(dom.result).toMatchObject({ ok: false, motivo: "sin_pedido_para_recoger" });
    expect(callbacks(f).filter((c) => c.reason === "cliente_llego")).toHaveLength(0);
  });

  it("un pedido para recoger ya entregado, con problema o no recogido NO se avisa como llegada; con canal desconocido tampoco", async () => {
    for (const destino of ["entregado", "problema", "no_recogido"] as const) {
      const f = buildRestaurantFixture();
      const o = await pedido(f, "recoger");
      await f.repo.updateOrderStatus(f.organizationId, o.id, "pending", destino, destino === "problema" ? "nota" : undefined);
      const out = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego" });
      expect(out.result).toMatchObject({ ok: false, motivo: "sin_pedido_para_recoger" });
      expect(callbacks(f).filter((c) => c.reason === "cliente_llego")).toHaveLength(0);
    }
    const f = buildRestaurantFixture();
    await pedido(f, "recoger");
    (f.repo as unknown as { listOrderPickupInfo: () => Promise<readonly unknown[]> }).listOrderPickupInfo = async () => [];
    const sinCanal = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego" });
    expect(sinCanal.result).toMatchObject({ ok: false, motivo: "sin_pedido_para_recoger" });
  });

  it("otros motivos siguen igual", async () => {
    const f = buildRestaurantFixture();
    const out = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "empleo", message: "busca trabajo" });
    expect(out.result).toEqual({ ok: true });
  });
});

describe("registrar_contacto con reason pedido_telefonico", () => {
  it("pasa la nota y el pin a la sucursal sin crear pedido", async () => {
    const f = buildRestaurantFixture();
    const out = await invokeAgentTool(
      f.repo,
      { ...ctx(f), entryPropertyId: f.propertyId, ubicacionEntrega: { fuente: "pin", lat: 21.01, lng: -89.6 } },
      "registrar_contacto",
      { customer_name: "Ana", reason: "pedido_telefonico", message: "es el depto 6" },
    );
    expect(out.result).toEqual({ ok: true, mensaje_al_cliente: MENSAJE_PEDIDO_TELEFONICO_REGISTRADO });
    expect(out.orderId).toBeNull();
    const cb = callbacks(f).find((c) => c.reason === "pedido_telefonico");
    expect(cb?.propertyId).toBe(f.propertyId);
    expect(cb?.message).toBe("es el depto 6 | Ubicación de entrega (pin de WhatsApp): lat=21.010000 lng=-89.600000.");
  });

  it("sin nota ni ubicación no registra nada", async () => {
    const f = buildRestaurantFixture();
    const out = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "pedido_telefonico" });
    expect(out.result).toMatchObject({ ok: false });
    expect(callbacks(f).filter((c) => c.reason === "pedido_telefonico")).toHaveLength(0);
  });
});

describe("modo preview del panel: sin efectos", () => {
  it("cliente_llego y pedido_telefonico no crean avisos y devuelven el mensaje fijo simulado", async () => {
    const f = buildRestaurantFixture();
    const llego = await invokeAgentTool(f.repo, { ...ctx(f), modo: "preview" }, "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego" });
    expect(llego.result).toEqual({ ok: true, simulado: true, mensaje_al_cliente: MENSAJE_LLEGADA_REGISTRADA });
    const tel = await invokeAgentTool(f.repo, { ...ctx(f), modo: "preview" }, "registrar_contacto", { customer_name: "Ana", reason: "pedido_telefonico", message: "depto 6" });
    expect(tel.result).toEqual({ ok: true, simulado: true, mensaje_al_cliente: MENSAJE_PEDIDO_TELEFONICO_REGISTRADO });
    expect(callbacks(f)).toHaveLength(0);
  });
});
