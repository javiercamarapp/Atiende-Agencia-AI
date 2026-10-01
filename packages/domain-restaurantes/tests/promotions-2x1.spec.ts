// R-02 -- promociones 2x1 (bogo) y restriccion por canal (migracion 027). Reglas puras
// (computeBogoDiscount / applyPromotionToOrder) + integracion con createOrder sobre el repositorio
// en memoria. La regla "no aplica a domicilio" de PM se modela con channels = ["recoger"].
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyPromotionToOrder, applyPromotionToOrderTotal, computeBogoDiscount } from "../src/promotions.ts";
import { PromotionError } from "../src/errors.ts";
import { createOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput, PersistedOrderItem, Promotion } from "../src/types.ts";

const ZONA = "America/Merida";
const AHORA = new Date("2026-09-28T19:00:00Z"); // lunes 14:00 en Merida

function promo(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    code: "LUNES2X1",
    name: "Lunes 2x1",
    description: null,
    type: "bogo",
    value: 1,
    minOrderTotal: null,
    startsAt: null,
    endsAt: null,
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    maxUses: null,
    timesUsed: 0,
    isActive: true,
    channels: null,
    productIds: null,
    autoApply: false,
    courtesyProductIds: null,
    courtesyQuantity: null,
    createdAt: AHORA.toISOString(),
    updatedAt: AHORA.toISOString(),
    ...overrides,
  };
}
const item = (id: string, price: number, quantity: number): PersistedOrderItem => ({ id, name: id, price, quantity });

describe("computeBogoDiscount", () => {
  it("1 pieza: nada gratis; 2: una gratis; 3: una gratis; 4: dos gratis", () => {
    const p = promo();
    expect(computeBogoDiscount(p, [item("a", 42, 1)])).toBe(0);
    expect(computeBogoDiscount(p, [item("a", 42, 2)])).toBe(42);
    expect(computeBogoDiscount(p, [item("a", 42, 3)])).toBe(42);
    expect(computeBogoDiscount(p, [item("a", 42, 4)])).toBe(84);
  });

  it("entre productos distintos regala las piezas mas baratas (se paga la mas cara de cada par)", () => {
    const p = promo();
    // unidades: 60, 60, 42, 42 => pares (60,60) y (42,42): gratis 60 y 42? No: gratis = las floor(4/2)=2 mas baratas = 42 + 42.
    expect(computeBogoDiscount(p, [item("a", 60, 2), item("b", 42, 2)])).toBe(84);
    // unidades: 100, 20, 20 => 1 gratis: una de 20.
    expect(computeBogoDiscount(p, [item("a", 100, 1), item("b", 20, 2)])).toBe(20);
  });

  it("con productIds solo cuentan los productos elegibles; los demas renglones no entran", () => {
    const p = promo({ productIds: ["a"] });
    expect(computeBogoDiscount(p, [item("a", 42, 2), item("b", 10, 10)])).toBe(42);
    expect(computeBogoDiscount(p, [item("a", 42, 1), item("b", 10, 10)])).toBe(0);
  });

  it("productIds vacio equivale a 'todos' (nunca a 'ninguno')", () => {
    expect(computeBogoDiscount(promo({ productIds: [] }), [item("a", 42, 2)])).toBe(42);
  });

  it("redondea a centavos", () => {
    expect(computeBogoDiscount(promo(), [item("a", 33.335, 2)])).toBe(33.34);
  });
});

describe("applyPromotionToOrder", () => {
  it("2x1 aplica el descuento y baja el total", () => {
    const r = applyPromotionToOrder({ promotion: promo(), orderTotal: 126, items: [item("a", 42, 3)], canal: "recoger", now: AHORA, zonaHoraria: ZONA });
    expect(r).toEqual({ total: 84, discount: 42 });
  });

  it("2x1 con una sola pieza elegible se rechaza con la razon real (no es un descuento de 0 silencioso)", () => {
    expect(() => applyPromotionToOrder({ promotion: promo(), orderTotal: 42, items: [item("a", 42, 1)], canal: "recoger", now: AHORA, zonaHoraria: ZONA })).toThrow(/al menos 2 piezas/);
  });

  it("restriccion por canal: domicilio queda fuera cuando solo vale para recoger", () => {
    const p = promo({ channels: ["recoger"] });
    const args = { promotion: p, orderTotal: 84, items: [item("a", 42, 2)], now: AHORA, zonaHoraria: ZONA } as const;
    expect(() => applyPromotionToOrder({ ...args, canal: "domicilio" })).toThrow(/no aplica a pedidos a domicilio/);
    expect(applyPromotionToOrder({ ...args, canal: "recoger" }).discount).toBe(42);
  });

  it("channels null o vacio = todos los canales", () => {
    for (const channels of [null, []] as const) {
      const r = applyPromotionToOrder({ promotion: promo({ channels }), orderTotal: 84, items: [item("a", 42, 2)], canal: "domicilio", now: AHORA, zonaHoraria: ZONA });
      expect(r.discount).toBe(42);
    }
  });

  it("restriccion por dia: lunes si, martes no (en la zona del negocio)", () => {
    const p = promo({ daysOfWeek: [1] });
    const args = { promotion: p, orderTotal: 84, items: [item("a", 42, 2)], canal: "recoger", zonaHoraria: ZONA } as const;
    expect(applyPromotionToOrder({ ...args, now: AHORA }).discount).toBe(42);
    expect(() => applyPromotionToOrder({ ...args, now: new Date("2026-09-29T19:00:00Z") })).toThrow(/no aplica el día de hoy/);
  });

  it("limite de dia en zona: lunes 23:30 en Merida (martes 04:30 UTC) sigue siendo lunes", () => {
    const p = promo({ daysOfWeek: [1] });
    const r = applyPromotionToOrder({ promotion: p, orderTotal: 84, items: [item("a", 42, 2)], canal: "recoger", now: new Date("2026-09-29T04:30:00Z"), zonaHoraria: ZONA });
    expect(r.discount).toBe(42);
  });

  it("percentage y fixed conservan el calculo anterior", () => {
    const base = { orderTotal: 200, items: [item("a", 100, 2)], canal: "domicilio", now: AHORA, zonaHoraria: ZONA } as const;
    expect(applyPromotionToOrder({ ...base, promotion: promo({ type: "percentage", value: 10 }) })).toEqual({ total: 180, discount: 20 });
    expect(applyPromotionToOrder({ ...base, promotion: promo({ type: "fixed", value: 500 }) })).toEqual({ total: 0, discount: 200 });
  });

  it("la API vieja applyPromotionToOrderTotal rechaza un 2x1 (necesita renglones) en vez de descontar 1 peso", () => {
    expect(() => applyPromotionToOrderTotal(100, promo(), AHORA, ZONA)).toThrow(PromotionError);
  });
});

function input(f: ReturnType<typeof buildRestaurantFixture>, overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Cliente",
    customerPhone: "9991234567",
    customerAddress: "Calle 50 #200",
    items: [{ productId: f.products.cocaCola, requestedQuantity: 3 }],
    source: "web",
    ...overrides,
  };
}

describe("createOrder con 2x1 y canal", () => {
  it("2x1 sobre el producto elegible: persiste el total descontado y lo anota", async () => {
    const f = buildRestaurantFixture();
    await f.repo.createPromotion(f.organizationId, { code: "COCA2X1", name: "Coca 2x1", type: "bogo", value: 1, channels: ["recoger"], productIds: [f.products.cocaCola] });
    const order = await createOrder(f.repo, input(f, { canal: "recoger", promoCode: "coca2x1" }));
    expect(order.total).toBe(90); // 3 x 45 = 135, una gratis
    expect(order.notes).toMatch(/Promoción aplicada: COCA2X1 \(-\$45\.00\)/);
  });

  it("a domicilio la promocion de solo-recoger se rechaza y el pedido nunca se crea", async () => {
    const f = buildRestaurantFixture();
    await f.repo.createPromotion(f.organizationId, { code: "COCA2X1", name: "Coca 2x1", type: "bogo", value: 1, channels: ["recoger"] });
    await expect(createOrder(f.repo, input(f, { canal: "domicilio", promoCode: "COCA2X1" }))).rejects.toThrow(/no aplica a pedidos a domicilio/);
    expect(await f.repo.findCustomerByPhone(f.organizationId, "9991234567")).toBeNull();
  });

  it("el 2x1 de otro producto no descuenta el pedido (productos no elegibles)", async () => {
    const f = buildRestaurantFixture();
    await f.repo.createPromotion(f.organizationId, { code: "SOL2X1", name: "Sol 2x1", type: "bogo", value: 1, productIds: [f.products.cervezaSol] });
    await expect(createOrder(f.repo, input(f, { promoCode: "SOL2X1" }))).rejects.toThrow(/al menos 2 piezas/);
  });

  it("un codigo de otra organizacion no existe para esta (aislamiento multi-tenant)", async () => {
    const f = buildRestaurantFixture();
    await f.repo.createPromotion(randomUUID(), { code: "AJENO2X1", name: "x", type: "bogo", value: 1 });
    await expect(createOrder(f.repo, input(f, { promoCode: "AJENO2X1" }))).rejects.toThrow(/no existe/);
  });
});
