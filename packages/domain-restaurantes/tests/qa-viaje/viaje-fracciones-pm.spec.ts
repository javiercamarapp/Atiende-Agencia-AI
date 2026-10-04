// QA R1 lente VIAJE -- cantidades raras que un modelo (o un cliente en el storefront) puede mandar sobre los productos por kilo de PM:
// medio "kilo" como 0.5 del producto de 1 kg, cantidades negativas, cero, gigantes o como texto. El servidor nunca debe inventar un
// precio ni aceptar una cantidad que la cocina no puede servir.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool, type AgentToolContext } from "../../src/agent-tools/registry.ts";
import { MARTES_14H, nuevoViaje, type Viaje } from "./arnes-viaje.ts";

const ctx = (v: Viaje, canal: "whatsapp" | "web"): AgentToolContext => ({ organizationId: v.world.organizationId, channel: canal, phone: canal === "whatsapp" ? "+5219995550111" : null });
const kilo = (v: Viaje, q: unknown) => ({ branch_slug: "garcia-lavin", canal: "recoger", items: [{ product_id: v.producto("Pastor — 1 kg"), product_name: "Pastor — 1 kg", requested_quantity: q }] });

describe("viaje PM: cantidades de productos por kilo", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MARTES_14H));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["medio kilo como 0.5 del producto de 1 kg", 0.5],
    ["cero", 0],
    ["negativo", -2],
    ["NaN", Number.NaN],
  ])("%s: la cotizacion se rechaza (el renglon correcto es 'Pastor — 500 g')", async (_n, q) => {
    const v = await nuevoViaje();
    for (const canal of ["whatsapp", "web"] as const) {
      await expect(invokeAgentTool(v.world.repo, ctx(v, canal), "cotizar_pedido", kilo(v, q))).rejects.toThrow();
    }
  });

  // WhatsApp (modo `lenient` de toRequestedItems): una cantidad que no es numero ("medio", "dos", "12 tacos", "0") se convierte
  // EN SILENCIO a 1 (`Number(x) || 1`). "Medio" kilo de pastor sobre el producto de 1 kg se cotiza como 1 kg ($900) en vez de
  // devolverle al modelo un error para que use el renglon de 500 g; "dos" ordenes se cotizan como una.
  it.fails("QA-restaurantes-R1-viaje-12: por WhatsApp una cantidad no numerica ('medio', 'dos', '0') se rechaza en vez de cotizarse como 1", async () => {
    const v = await nuevoViaje();
    for (const q of ["medio", "dos", "0"]) {
      await expect(invokeAgentTool(v.world.repo, ctx(v, "whatsapp"), "cotizar_pedido", kilo(v, q)), String(q)).rejects.toThrow();
    }
  });

  it("2 kg x 3 (6 kg) se cotiza al precio proporcional exacto: $5,400", async () => {
    const v = await nuevoViaje();
    const q = await invokeAgentTool(v.world.repo, ctx(v, "web"), "cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items: [{ product_id: v.producto("Pastor — 2 kg"), product_name: "Pastor — 2 kg", requested_quantity: 3 }] });
    expect((q.raw as { total: number }).total).toBe(5400);
  });

  it("una cantidad absurda (10,000 kilos) se rechaza en vez de cotizar $9,000,000", async () => {
    const v = await nuevoViaje();
    await expect(invokeAgentTool(v.world.repo, ctx(v, "web"), "cotizar_pedido", kilo(v, 10000))).rejects.toThrow();
  });
});
