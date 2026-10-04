// QA R1 lente VIAJE -- pedido de prueba por el STOREFRONT web (canal "web" del registro unico, mismo contexto que
// apps/api/.../storefront.ts: sin telefono de canal, maquina de estados por sesion `web:<session>`) sobre el catalogo real de T7.
// Carrito -> cotizar -> confirmar -> crear; doble clic en "Confirmar pedido"; cotizacion vencida; reglas duras del checkout web.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool, type AgentToolContext } from "../../src/agent-tools/registry.ts";
import { MARTES_14H, nuevoViaje, pedidosDe, type Viaje } from "./arnes-viaje.ts";

const ctx = (v: Viaje, sesion = "qa-sesion-0001"): AgentToolContext => ({ organizationId: v.world.organizationId, channel: "web", phone: null, flow: { key: `web:${sesion}`, turn: null } });
const carrito = (v: Viaje) => [
  { product_id: v.producto("Bistec de Res — 250 g"), product_name: "Bistec de Res — 250 g", requested_quantity: 1 },
  { product_id: v.producto("Extra Piña"), product_name: "Extra Piña", requested_quantity: 2 },
];
const checkout = (v: Viaje, extra: Record<string, unknown> = {}) => ({
  branch_slug: "garcia-lavin",
  canal: "recoger",
  items: carrito(v),
  customer_name: "Cliente Web QA",
  customer_phone: "999 555 0123",
  payment_method: "tarjeta",
  ...extra,
});

describe("viaje storefront web PM (T7)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MARTES_14H));
  });
  afterEach(() => vi.useRealTimers());

  it("1/4 de bistec + 2 extras de pina: $275 + 2 x $19 = $313; confirmar; crear; doble clic no duplica", async () => {
    const v = await nuevoViaje();
    const q = await invokeAgentTool(v.world.repo, ctx(v), "cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items: carrito(v) });
    expect((q.raw as { total: number }).total).toBe(313);
    await invokeAgentTool(v.world.repo, ctx(v), "confirmar_resumen", { quote_hash: q.quoteHash });
    const [a, b] = await Promise.allSettled([invokeAgentTool(v.world.repo, ctx(v), "crear_pedido", checkout(v)), invokeAgentTool(v.world.repo, ctx(v), "crear_pedido", checkout(v))]);
    expect([a.status, b.status].filter((s) => s === "fulfilled")).toHaveLength(1);
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatchObject({ total: 313, source: "web", paymentMethod: "tarjeta" });
    expect(pedidos[0]!.customerPhone).toMatch(/9995550123$/);
  });

  it("confirmar 21 minutos despues de cotizar: la cotizacion vencio y no se crea", async () => {
    const v = await nuevoViaje();
    await invokeAgentTool(v.world.repo, ctx(v), "cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items: carrito(v) });
    vi.setSystemTime(new Date(Date.parse(MARTES_14H) + 21 * 60_000));
    await expect(invokeAgentTool(v.world.repo, ctx(v), "confirmar_resumen", {})).rejects.toThrow(/venci/);
    await expect(invokeAgentTool(v.world.repo, ctx(v), "crear_pedido", checkout(v))).rejects.toThrow();
    expect(await pedidosDe(v)).toHaveLength(0);
  });

  it("a domicilio sin direccion, sin telefono valido o debajo del minimo de $200: el checkout lo rechaza con un mensaje claro", async () => {
    const v = await nuevoViaje();
    const dom = { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Garcia Gineres", items: carrito(v) };
    await expect(invokeAgentTool(v.world.repo, ctx(v, "s2"), "cotizar_pedido", dom)).resolves.toBeTruthy();
    await invokeAgentTool(v.world.repo, ctx(v, "s2"), "confirmar_resumen", {});
    await expect(invokeAgentTool(v.world.repo, ctx(v, "s2"), "crear_pedido", checkout(v, { canal: "domicilio", colonia_entrega: "Garcia Gineres" }))).rejects.toThrow(/dirección/);
    await expect(invokeAgentTool(v.world.repo, ctx(v, "s2"), "crear_pedido", checkout(v, { canal: "domicilio", customer_address: "Calle 1", customer_phone: "123", colonia_entrega: "Garcia Gineres" }))).rejects.toThrow(/teléfono/);
    const barato = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 1 }];
    await expect(invokeAgentTool(v.world.repo, ctx(v, "s3"), "cotizar_pedido", { ...dom, items: barato })).rejects.toThrow(/mínimo/);
    expect(await pedidosDe(v)).toHaveLength(0);
  });
});
