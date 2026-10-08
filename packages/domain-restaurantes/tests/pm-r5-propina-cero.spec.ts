// QA-PM-R5-reglas-01 (P0) y QA-PM-R5-whatsapp-01/02: el modelo real manda propina_porcentaje:0 y propina:0 cuando NO hay propina (rellena los
// opcionales), y crear_pedido lo rechazaba ("debe ser un numero entre 1 y 30"): 0 pedidos de WhatsApp en la medida de R5. Contrato con los argumentos
// reales del modelo + casos negativos (valores que SI deben seguir rechazandose). Tambien: propina:0 junto con propina_porcentaje:15 pierde el porcentaje.
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

function setup(channel: "whatsapp" | "voz" = "whatsapp") {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { propinaPolitica: "solo_tarjeta" });
  const ctx = { organizationId: f.organizationId, channel, phone: "9991234567" };
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const crear = (extra: Record<string, unknown>) => invokeAgentTool(f.repo, ctx, "crear_pedido", { branch_slug: "fco-montejo", items, canal: "recoger", customer_name: "Nora", payment_method: "efectivo", ...extra });
  const propinaGuardada = (orderId: string | null | undefined) => (f.repo as unknown as { orderPickupInfo: Map<string, { propina: number | null }> }).orderPickupInfo.get(String(orderId))?.propina ?? null;
  return { f, crear, propinaGuardada };
}

describe.each(["whatsapp", "voz"] as const)("%s: 0 / vacio / null = sin propina (contrato con los argumentos reales del modelo)", (channel) => {
  it.each([
    ["efectivo, los dos en 0 (lo que manda gpt-6-luna)", { payment_method: "efectivo", propina_porcentaje: 0, propina: 0 }],
    ["tarjeta, los dos en 0", { payment_method: "tarjeta", propina_porcentaje: 0, propina: 0 }],
    ["solo porcentaje 0", { payment_method: "tarjeta", propina_porcentaje: 0 }],
    ["porcentaje '0'", { payment_method: "tarjeta", propina_porcentaje: "0" }],
    ["porcentaje '0%'", { payment_method: "tarjeta", propina_porcentaje: "0%" }],
    ["porcentaje null y propina null", { payment_method: "tarjeta", propina_porcentaje: null, propina: null }],
    ["porcentaje vacio", { payment_method: "tarjeta", propina_porcentaje: "", propina: "" }],
  ])("%s crea el pedido sin propina", async (_n, extra) => {
    const s = setup(channel);
    const r = await s.crear(extra);
    expect(r.orderId).not.toBeNull();
    expect(s.propinaGuardada(r.orderId)).toBeNull();
  });
});

describe("propina en porcentaje con propina:0 de relleno (QA-PM-R5-whatsapp-01)", () => {
  it("propina_porcentaje 15 + propina 0 guarda la propina en pesos (15 % del total), no NULL", async () => {
    const s = setup("whatsapp");
    const sin = await s.crear({ payment_method: "tarjeta", propina_porcentaje: 0, propina: 0 });
    const total = Number((sin as unknown as { total?: number }).total ?? NaN);
    const r = await s.crear({ payment_method: "tarjeta", propina_porcentaje: 15, propina: 0 });
    expect(r.orderId).not.toBeNull();
    const guardada = s.propinaGuardada(r.orderId);
    expect(guardada).not.toBeNull();
    if (Number.isFinite(total)) expect(guardada).toBeCloseTo(Math.round(total * 15) / 100, 2);
  });
  it("propina en pesos con porcentaje 0 conserva los pesos", async () => {
    const s = setup("whatsapp");
    const r = await s.crear({ payment_method: "tarjeta", propina_porcentaje: 0, propina: 20 });
    expect(s.propinaGuardada(r.orderId)).toBe(20);
  });
});

describe("negativos: lo invalido sigue rechazandose", () => {
  it.each([-5, 31, 1000, "diez", Number.NaN, "-3%", "150%", {}, true])("propina_porcentaje %s", async (v) => {
    const s = setup("whatsapp");
    await expect(s.crear({ payment_method: "tarjeta", propina_porcentaje: v })).rejects.toThrow(/propina_porcentaje debe ser/);
  });
  it.each(["veinte", Number.NaN, {}, true])("propina %s", async (v) => {
    const s = setup("whatsapp");
    await expect(s.crear({ payment_method: "tarjeta", propina: v })).rejects.toThrow(/monto numérico/);
  });
  it("propina negativa en pesos se rechaza", async () => {
    const s = setup("whatsapp");
    await expect(s.crear({ payment_method: "tarjeta", propina: -5 })).rejects.toThrow();
  });
});
