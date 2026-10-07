// QA R2 features-07: el codigo de compensacion (GRACIAS-XXXXXXXX, 10 % de un solo uso) que el dueno emite tras una queja debe canjearse en el
// SIGUIENTE pedido del mismo cliente por WhatsApp o voz. Decision de PM (T-AB01): ninguna tool acepta promo/descuento/total del modelo, asi que el
// SERVIDOR aplica solo el codigo emitido a ESE telefono (el del contexto del canal) en cotizar_pedido y crear_pedido. El uso se cuenta y no se reutiliza.
import { describe, expect, it } from "vitest";
import { invokeAgentTool, AGENT_TOOL_DEFINITIONS } from "../src/agent-tools/registry.ts";
import { esCodigoDeCompensacion, assertWebOrderRules, previewPromotion } from "../src/storefront.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const CODIGO = "GRACIAS-AB12CD34";
const TEL = "9991234567";

async function setup(channel: "whatsapp" | "voz" = "whatsapp", canal: "recoger" | "domicilio" = "recoger", phone = TEL) {
  const f = buildRestaurantFixture();
  await f.repo.createPromotion(f.organizationId, {
    code: CODIGO, name: "Compensacion de un solo uso", type: "percentage", value: 10, maxUses: 1, isActive: true, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  f.repo.seedCompensationCode(f.organizationId, TEL, CODIGO);
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel, phone, flow: { key: `k:${channel}:${canal}:${phone}`, turn: String(turn), now: () => Date.now() } });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 4 }]; // 4 x 45 = 180
  const base = { branch_slug: "fco-montejo", items, canal, ...(canal === "domicilio" ? { colonia_entrega: "Centro" } : {}) };
  const quote = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra });
  const confirm = () => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
  const create = (extra: Record<string, unknown> = {}) =>
    invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo", customer_address: "Calle 1 #100", ...extra });
  const nextTurn = () => void (turn += 1);
  return { f, quote, confirm, create, nextTurn };
}

type Cotizacion = { quote: { total: number; subtotal?: number; descuento?: number; promocion_aplicada?: { code: string } } };

describe.each(["whatsapp", "voz"] as const)("canje del codigo de compensacion por %s", (channel) => {
  it("cotizar baja el total 10 % SOLO, sin que el modelo mande ningun codigo, y lo declara como promocion aplicada", async () => {
    const s = await setup(channel);
    const q = (await s.quote()).result as Cotizacion;
    expect(q.quote.total).toBe(162);
    expect(q.quote.subtotal).toBe(180);
    expect(q.quote.descuento).toBe(18);
    expect(q.quote.promocion_aplicada?.code).toBe(CODIGO);
  });

  it("cotizar -> confirmar -> crear: el pedido se cobra con el descuento y el uso queda contado", async () => {
    const s = await setup(channel);
    await s.quote();
    s.nextTurn();
    await s.confirm();
    const creado = await s.create();
    expect((creado.raw as { total: number }).total).toBe(162);
    expect((await s.f.repo.findPromotionByCode(s.f.organizationId, CODIGO))?.timesUsed).toBe(1);
  });

  it("es de un solo uso: el siguiente pedido ya sale a precio completo", async () => {
    const s = await setup(channel);
    await s.quote();
    s.nextTurn();
    await s.confirm();
    await s.create();
    s.nextTurn();
    const otra = (await s.quote()).result as Cotizacion;
    expect(otra.quote.total).toBe(180);
    expect(otra.quote.promocion_aplicada).toBeUndefined();
  });

  it("el codigo es de ESE cliente: otro telefono cotiza a precio completo", async () => {
    const s = await setup(channel, "recoger", "9990000001");
    expect(((await s.quote()).result as Cotizacion).quote.total).toBe(180);
  });

  it("a domicilio tambien vale: el codigo de compensacion no es una promocion de recoger", async () => {
    const s = await setup(channel, "domicilio");
    expect(((await s.quote()).result as Cotizacion).quote.total).toBe(162);
  });

  it("un promo_code que mande el modelo se ignora en WhatsApp: no existe en el esquema de las tools", () => {
    for (const t of AGENT_TOOL_DEFINITIONS) expect(Object.keys(t.parameters.properties).join(","), t.name).not.toMatch(/promo|descuento|discount/i);
  });
});

describe("checkout web: codigo de compensacion a domicilio", () => {
  const base = { organizationId: "o", items: [{ productId: "p", quantity: 1 }], customerPhone: "9991234567", paymentMethod: "efectivo" as const, customerAddress: "Calle 1", canal: "domicilio" as const };

  it("esCodigoDeCompensacion reconoce solo la forma que emite el sistema", () => {
    expect(esCodigoDeCompensacion(" gracias-ab12cd34 ")).toBe(true);
    expect(esCodigoDeCompensacion("GRACIAS-123")).toBe(false);
    expect(esCodigoDeCompensacion("LUNES2X1")).toBe(false);
    expect(esCodigoDeCompensacion("GRACIAS-AB12CD34X")).toBe(false);
  });

  it("el checkout acepta el codigo de compensacion a domicilio, pero sigue rechazando una promocion normal", () => {
    expect(() => assertWebOrderRules({ ...base, branchSlug: "x", customerName: "A", source: "web", promoCode: CODIGO } as never)).not.toThrow();
    expect(() => assertWebOrderRules({ ...base, branchSlug: "x", customerName: "A", source: "web", promoCode: "LUNES2X1" } as never)).toThrow(/solo aplican para pedidos que recoges/);
  });

  it("la vista previa del carrito a domicilio valida el codigo de compensacion y rechaza una promocion normal", async () => {
    const f = buildRestaurantFixture();
    await f.repo.createPromotion(f.organizationId, { code: CODIGO, name: "c", type: "percentage", value: 10, maxUses: 1, isActive: true });
    const prev = await previewPromotion(f.repo, { organizationId: f.organizationId, propertyId: f.propertyId, rawCode: CODIGO, canal: "domicilio", total: 200, items: [] });
    expect(prev).toMatchObject({ valida: true, descuento: 20, totalConDescuento: 180 });
    const normal = await previewPromotion(f.repo, { organizationId: f.organizationId, propertyId: f.propertyId, rawCode: "OTRA", canal: "domicilio", total: 200, items: [] });
    expect(normal.valida).toBe(false);
  });
});
