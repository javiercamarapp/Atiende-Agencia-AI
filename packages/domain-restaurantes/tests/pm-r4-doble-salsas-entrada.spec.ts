// QA-PM-R4-reglas-09 / reglas-10: doble_salsas que llega solo al crear o con tipo incorrecto no se ignora en silencio; la salsa basica pedida como complemento dice "ya viene incluida".
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

function setup() {
  const f = buildRestaurantFixture();
  const extra = randomUUID();
  f.repo.seedProduct({ id: extra, organizationId: f.organizationId, categoryId: f.categories.bebidas, name: "Extra Salsa", description: null, searchKeywords: [] });
  f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: extra, price: 19, isAvailable: true });
  const ctx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567" };
  const items = [{ product_id: f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger", customer_name: "Nora", payment_method: "efectivo" };
  return { f, ctx, base };
}

describe("doble_salsas en crear_pedido", () => {
  it("una cadena en vez de lista se rechaza con un mensaje claro (antes se ignoraba)", async () => {
    const s = setup();
    await expect(invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, doble_salsas: "salsa_roja" })).rejects.toThrow(/doble_salsas debe ser una lista/);
    await expect(invokeAgentTool(s.f.repo, s.ctx, "cotizar_pedido", { ...s.base, doble_salsas: "salsa_roja" })).rejects.toThrow(/doble_salsas debe ser una lista/);
  });
  it("doble_salsas solo al crear (la cotizacion no la traia) cobra el extra o rechaza; nunca crea en silencio sin cobrarlo", async () => {
    const s = setup();
    const sinDoble = await invokeAgentTool(s.f.repo, s.ctx, "cotizar_pedido", s.base);
    const totalSinDoble = (sinDoble.result as { quote: { total: number } }).quote.total;
    let creado: { total?: number; items?: unknown[] } | null = null;
    let rechazo: string | null = null;
    try {
      const r = await invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, doble_salsas: ["salsa_verde"] });
      creado = (r.result as { order: { total: number; items: unknown[] } }).order;
    } catch (e) {
      rechazo = (e as Error).message;
    }
    if (creado) expect(creado.total).toBe(totalSinDoble + 19);
    else expect(rechazo).toMatch(/doble|cotiz/i);
  });
});

describe("salsa basica como complemento pedido", () => {
  it("una salsa basica ya incluida no se rechaza (no-op); una inexistente si", async () => {
    const s = setup();
    const r = await invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, requested_complements: ["salsa_verde"] });
    expect(r.orderId).not.toBeNull();
    await expect(invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, requested_complements: ["chimichurri"] })).rejects.toThrow(/chimichurri/);
  });
});

describe("hora_recogida numerica (QA-PM-R4-reglas-11)", () => {
  it("un epoch se rechaza en cotizar y crear en vez de crear el pedido sin hora; el texto ISO y el vacio siguen igual", async () => {
    const s = setup();
    await expect(invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, hora_recogida: 1760380800 })).rejects.toThrow(/hora_recogida debe ser texto/);
    await expect(invokeAgentTool(s.f.repo, s.ctx, "cotizar_pedido", { ...s.base, hora_recogida: 1760380800 })).rejects.toThrow(/minutos_para_recoger/);
    const r = await invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, hora_recogida: "" });
    expect(r.orderId).not.toBeNull();
  });
});

describe("media orden de nachos con bebida (QA-PM-R4-reglas-02)", () => {
  it("la cotizacion sin promocion trae la frase literal de que las bebidas se cobran; sin media orden no la trae", async () => {
    const f = buildRestaurantFixture();
    const nachos = randomUUID();
    f.repo.seedProduct({ id: nachos, organizationId: f.organizationId, categoryId: f.categories.bebidas, name: "Nachos de Pastor (1/2 orden)", description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: nachos, price: 232, isAvailable: true });
    const horchata = randomUUID();
    f.repo.seedProduct({ id: horchata, organizationId: f.organizationId, categoryId: f.categories.bebidas, name: "Horchata", description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: horchata, price: 60, isAvailable: true });
    const ctx = { organizationId: f.organizationId, channel: "voz" as const, phone: "9991234567" };
    const cot = (items: unknown[]) => invokeAgentTool(f.repo, ctx, "cotizar_pedido", { branch_slug: "fco-montejo", items, canal: "recoger" });
    const con = await cot([
      { product_id: nachos, product_name: "Nachos de Pastor (1/2 orden)", requested_quantity: 1 },
      { product_id: horchata, product_name: "Horchata", requested_quantity: 2 },
    ]);
    expect((con.result as { quote: { total: number } }).quote.total).toBe(352);
    expect((con.result as { mensaje_media_orden_nachos?: string }).mensaje_media_orden_nachos).toMatch(/únicamente con la orden completa de nachos/);
    const sin = await cot([{ product_id: horchata, product_name: "Horchata", requested_quantity: 2 }]);
    expect(sin.result).not.toHaveProperty("mensaje_media_orden_nachos");
  });
});
