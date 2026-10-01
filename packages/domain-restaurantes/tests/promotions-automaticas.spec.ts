// PM PR-4: promociones AUTOMATICAS por dia y canal (sin codigo) + combo de cortesia, y que la regla
// 'tacos de bistec solo en ordenes de 3' siga intacta con ellas. Lunes: 2x1 en tacos al pastor; martes:
// nachos de pastor con 2 aguas de cortesia; SOLO para recoger, nunca a domicilio. Zona America/Merida
// (UTC-6 sin horario de verano).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeCortesiaDiscount, selectAutomaticPromotion } from "../src/promotions.ts";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { OrderValidationError } from "../src/errors.ts";
import { quoteToWire } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { PersistedOrderItem, Promotion } from "../src/types.ts";

const ZONA = "America/Merida";
// 2026-09-28 es lunes. Merida = UTC-6.
const LUNES_14H = new Date("2026-09-28T20:00:00Z");
const MARTES_14H = new Date("2026-09-29T20:00:00Z");
const MIERCOLES_14H = new Date("2026-09-30T20:00:00Z");

function promo(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    code: "AUTO",
    name: "Auto",
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
    channels: ["recoger"],
    productIds: null,
    autoApply: true,
    courtesyProductIds: null,
    courtesyQuantity: null,
    createdAt: LUNES_14H.toISOString(),
    updatedAt: LUNES_14H.toISOString(),
    ...overrides,
  };
}
const item = (id: string, price: number, quantity: number): PersistedOrderItem => ({ id, name: id, price, quantity });
const total = (items: readonly PersistedOrderItem[]) => items.reduce((acc, i) => acc + i.price * i.quantity, 0);

const LUNES_2X1 = () => promo({ code: "LUNES2X1", name: "Lunes 2x1 en pastor", daysOfWeek: [1], productIds: ["pastor"] });
const MARTES_NACHOS = () =>
  promo({ code: "MARTESNACHOS", name: "Martes nachos", type: "cortesia", daysOfWeek: [2], productIds: ["nachos"], courtesyProductIds: ["agua-jamaica", "agua-horchata"], courtesyQuantity: 2 });

function select(promotions: Promotion[], items: PersistedOrderItem[], canal: "recoger" | "domicilio", now: Date, diaNegocio?: number) {
  return selectAutomaticPromotion({ promotions, orderTotal: total(items), items, canal, now, zonaHoraria: ZONA, ...(diaNegocio !== undefined ? { diaNegocio } : {}) });
}

describe("selectAutomaticPromotion -- lunes 2x1 en pastor (solo recoger)", () => {
  it("lunes + recoger: aplica solo, sin codigo", () => {
    const r = select([LUNES_2X1()], [item("pastor", 28, 4)], "recoger", LUNES_14H);
    expect(r.applied?.promotion.code).toBe("LUNES2X1");
    expect(r.applied?.discount).toBe(56);
    expect(r.applied?.total).toBe(56);
  });

  it("lunes + DOMICILIO: nunca aplica y ni siquiera se sugiere", () => {
    const r = select([LUNES_2X1()], [item("pastor", 28, 4)], "domicilio", LUNES_14H);
    expect(r.applied).toBeNull();
    expect(r.suggestions).toEqual([]);
  });

  it("martes y miercoles: la promo del lunes no aplica", () => {
    for (const dia of [MARTES_14H, MIERCOLES_14H]) {
      const r = select([LUNES_2X1()], [item("pastor", 28, 4)], "recoger", dia);
      expect(r.applied).toBeNull();
      expect(r.suggestions).toEqual([]);
    }
  });

  it("lunes con una sola pieza de pastor: no descuenta, pero se SUGIERE (vale hoy)", () => {
    const r = select([LUNES_2X1()], [item("pastor", 28, 1)], "recoger", LUNES_14H);
    expect(r.applied).toBeNull();
    expect(r.suggestions.map((s) => [s.promotion.code, s.motivo])).toEqual([["LUNES2X1", "faltan_productos"]]);
  });

  it("una promocion automatica SIN canales explicitos nunca aplica (defensa en profundidad)", () => {
    for (const channels of [null, []] as const) {
      const r = select([promo({ channels, daysOfWeek: [1], productIds: ["pastor"] })], [item("pastor", 28, 4)], "recoger", LUNES_14H);
      expect(r.applied).toBeNull();
    }
  });

  it("una promocion NO automatica (solo con codigo) no se aplica sola, y una inactiva tampoco", () => {
    expect(select([promo({ autoApply: false, productIds: ["pastor"] })], [item("pastor", 28, 4)], "recoger", LUNES_14H).applied).toBeNull();
    expect(select([promo({ isActive: false, productIds: ["pastor"] })], [item("pastor", 28, 4)], "recoger", LUNES_14H).applied).toBeNull();
  });

  it("solo una promocion por pedido: gana la de mayor descuento (empate: codigo menor)", () => {
    const chica = promo({ code: "A-CHICA", type: "fixed", value: 10, productIds: null });
    const grande = promo({ code: "B-GRANDE", type: "fixed", value: 30, productIds: null });
    const r = select([chica, grande], [item("pastor", 28, 4)], "recoger", LUNES_14H);
    expect(r.applied?.promotion.code).toBe("B-GRANDE");
    const empate = select([promo({ code: "Z", type: "fixed", value: 10 }), promo({ code: "M", type: "fixed", value: 10 })], [item("pastor", 28, 4)], "recoger", LUNES_14H);
    expect(empate.applied?.promotion.code).toBe("M");
  });
});

describe("selectAutomaticPromotion -- dia de la semana en America/Merida", () => {
  it("lunes 23:30 en Merida (ya es martes 05:30 UTC) sigue siendo lunes", () => {
    const r = select([LUNES_2X1()], [item("pastor", 28, 2)], "recoger", new Date("2026-09-29T05:30:00Z"));
    expect(r.applied?.promotion.code).toBe("LUNES2X1");
  });

  it("domingo 23:30 en Merida (ya es lunes 05:30 UTC) todavia NO es lunes", () => {
    const r = select([LUNES_2X1()], [item("pastor", 28, 2)], "recoger", new Date("2026-09-28T05:30:00Z"));
    expect(r.applied).toBeNull();
  });

  it("cruce de medianoche del doble turno: 00:30 del martes dentro del turno del lunes cuenta como LUNES (dia de negocio)", () => {
    const martes0030 = new Date("2026-09-29T06:30:00Z"); // martes 00:30 Merida
    expect(select([LUNES_2X1()], [item("pastor", 28, 2)], "recoger", martes0030).applied).toBeNull(); // dia calendario: martes
    expect(select([LUNES_2X1()], [item("pastor", 28, 2)], "recoger", martes0030, 1).applied?.promotion.code).toBe("LUNES2X1"); // dia de negocio: lunes
    // ... y la promo del martes NO se adelanta a ese 00:30
    expect(select([MARTES_NACHOS()], [item("nachos", 90, 1), item("agua-jamaica", 30, 2)], "recoger", martes0030, 1).applied).toBeNull();
  });
});

describe("combo de cortesia -- martes nachos de pastor con 2 aguas", () => {
  const nachos = item("nachos", 90, 1);

  it("nachos + 2 aguas elegidas: las 2 aguas quedan a $0", () => {
    const items = [nachos, item("agua-jamaica", 30, 1), item("agua-horchata", 32, 1)];
    const r = select([MARTES_NACHOS()], items, "recoger", MARTES_14H);
    expect(r.applied?.promotion.code).toBe("MARTESNACHOS");
    expect(r.applied?.discount).toBe(62);
    expect(r.applied?.total).toBe(90);
  });

  it("nachos sin aguas en el pedido: no descuenta; se sugiere para que el agente las ofrezca", () => {
    const r = select([MARTES_NACHOS()], [nachos], "recoger", MARTES_14H);
    expect(r.applied).toBeNull();
    expect(r.suggestions.map((s) => s.motivo)).toEqual(["falta_elegir_cortesia"]);
  });

  it("solo aguas sin nachos: no hay cortesia (el disparador manda)", () => {
    expect(computeCortesiaDiscount(MARTES_NACHOS(), [item("agua-jamaica", 30, 2)])).toBe(0);
  });

  it("mas de 2 aguas: solo 2 van de cortesia, las mas baratas; las demas se cobran", () => {
    const items = [nachos, item("agua-jamaica", 30, 1), item("agua-horchata", 32, 3)];
    // 4 aguas, 2 de cortesia: 30 + 32
    expect(computeCortesiaDiscount(MARTES_NACHOS(), items)).toBe(62);
  });

  it("2 nachos => hasta 4 aguas de cortesia; con 3 aguas en el pedido se regalan las 3", () => {
    const items = [item("nachos", 90, 2), item("agua-jamaica", 30, 3)];
    expect(computeCortesiaDiscount(MARTES_NACHOS(), items)).toBe(90);
  });

  it("solo 1 agua en el pedido: se regala esa 1 (nunca mas piezas que las pedidas)", () => {
    expect(computeCortesiaDiscount(MARTES_NACHOS(), [nachos, item("agua-jamaica", 30, 1)])).toBe(30);
  });

  it("un producto que es disparador Y de cortesia no se regala a si mismo", () => {
    const rara = promo({ type: "cortesia", productIds: ["x"], courtesyProductIds: ["x"], courtesyQuantity: 1 });
    expect(computeCortesiaDiscount(rara, [item("x", 50, 2)])).toBe(0);
  });

  it("a domicilio la cortesia nunca aplica", () => {
    const items = [nachos, item("agua-jamaica", 30, 2)];
    expect(select([MARTES_NACHOS()], items, "domicilio", MARTES_14H).applied).toBeNull();
  });

  it("el lunes la promo del martes no aplica", () => {
    const items = [nachos, item("agua-jamaica", 30, 2)];
    expect(select([MARTES_NACHOS()], items, "recoger", LUNES_14H).applied).toBeNull();
  });

  it("una cortesia mal configurada (sin lista o sin cantidad) descuenta 0, nunca todo", () => {
    expect(computeCortesiaDiscount(promo({ type: "cortesia", productIds: ["nachos"], courtesyProductIds: null, courtesyQuantity: 2 }), [nachos, item("agua-jamaica", 30, 2)])).toBe(0);
    expect(computeCortesiaDiscount(promo({ type: "cortesia", productIds: ["nachos"], courtesyProductIds: ["agua-jamaica"], courtesyQuantity: null }), [nachos, item("agua-jamaica", 30, 2)])).toBe(0);
  });
});

describe("carrito mixto + regla de bistec en ordenes de 3 (de punta a punta, en memoria)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function seed() {
    const f = buildRestaurantFixture();
    await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    const mk = async (name: string, price: number, category = f.categories.tacos, description: string | null = null) => {
      const id = randomUUID();
      f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId: category, name, description, searchKeywords: [] });
      f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: id, price, isAvailable: true });
      return id;
    };
    const pastor = await mk("Tacos al Pastor", 28);
    const nachos = await mk("Nachos de Pastor", 90);
    const jamaica = await mk("Agua de Jamaica", 30, f.categories.bebidas);
    const horchata = await mk("Agua de Horchata", 32, f.categories.bebidas);
    await f.repo.createPromotion(f.organizationId, {
      code: "LUNES2X1",
      name: "Lunes 2x1 en tacos al pastor",
      type: "bogo",
      value: 1,
      daysOfWeek: [1],
      channels: ["recoger"],
      productIds: [pastor],
      autoApply: true,
    });
    await f.repo.createPromotion(f.organizationId, {
      code: "MARTESNACHOS",
      name: "Martes nachos de pastor con 2 aguas",
      type: "cortesia",
      value: 1,
      daysOfWeek: [2],
      channels: ["recoger"],
      productIds: [nachos],
      courtesyProductIds: [jamaica, horchata],
      courtesyQuantity: 2,
      autoApply: true,
    });
    return { ...f, ids: { pastor, nachos, jamaica, horchata, bistec: f.products.tacosPastor } };
  }
  const base = (f: Awaited<ReturnType<typeof seed>>) => ({ organizationId: f.organizationId, branchSlug: "fco-montejo" });

  it("lunes recoger: cotizar ya trae el 2x1 aplicado (total a pagar, subtotal y descuento)", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const q = await quoteOrder(f.repo, { ...base(f), canal: "recoger", items: [{ productId: f.ids.pastor, requestedQuantity: 4, tortilla: "mixta" }] });
    expect(q.subtotal).toBe(112);
    expect(q.descuento).toBe(56);
    expect(q.total).toBe(56);
    expect(q.promocionAplicada).toMatchObject({ code: "LUNES2X1", descuento: 56 });
    const wire = quoteToWire(q);
    expect(wire).toMatchObject({ total: 56, subtotal: 112, descuento: 56, promocion_aplicada: { code: "LUNES2X1" } });
  });

  it("lunes DOMICILIO: la misma cotizacion no trae promocion", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const q = await quoteOrder(f.repo, { ...base(f), canal: "domicilio", colonia: "Montejo", items: [{ productId: f.ids.pastor, requestedQuantity: 4, tortilla: "maiz" }] });
    expect(q.promocionAplicada).toBeNull();
    expect(q.promocionesSugeridas).toEqual([]);
    expect(q.total).toBe(112);
    expect(quoteToWire(q)).not.toHaveProperty("promocion_aplicada");
  });

  it("martes recoger con nachos y sin aguas: sugiere el combo con las opciones de agua del catalogo", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const q = await quoteOrder(f.repo, { ...base(f), canal: "recoger", items: [{ productId: f.ids.nachos, requestedQuantity: 1 }] });
    expect(q.promocionAplicada).toBeNull();
    expect(q.promocionesSugeridas).toHaveLength(1);
    const sug = q.promocionesSugeridas[0]!;
    expect(sug.motivo).toBe("falta_elegir_cortesia");
    expect(sug.opcionesCortesia?.map((o) => o.name).sort()).toEqual(["Agua de Horchata", "Agua de Jamaica"]);
    expect(sug.cortesiaPorUnidad).toBe(2);
    const wire = quoteToWire(q) as { promociones_sugeridas?: Array<{ opciones_cortesia: unknown[] }> };
    expect(wire.promociones_sugeridas?.[0]?.opciones_cortesia).toHaveLength(2);
  });

  it("martes recoger: nachos + 2 aguas elegidas => total = solo los nachos; el pedido se crea con ese total y lo anota", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const items = [
      { productId: f.ids.nachos, requestedQuantity: 1 },
      { productId: f.ids.jamaica, requestedQuantity: 1 },
      { productId: f.ids.horchata, requestedQuantity: 1 },
    ];
    const q = await quoteOrder(f.repo, { ...base(f), canal: "recoger", items });
    expect(q.total).toBe(90);
    const order = await createOrder(f.repo, { ...base(f), customerName: "Ana", customerPhone: "9991234567", source: "whatsapp", paymentMethod: "efectivo", canal: "recoger", items });
    expect(order.total).toBe(90);
    expect(order.notes).toMatch(/Promoción aplicada: MARTESNACHOS \(-\$62\.00\)/);
  });

  it("martes a DOMICILIO: el mismo carrito cobra todo", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const items = [
      { productId: f.ids.nachos, requestedQuantity: 1 },
      { productId: f.ids.jamaica, requestedQuantity: 2 },
    ];
    const order = await createOrder(f.repo, { ...base(f), customerName: "Ana", customerPhone: "9991234567", customerAddress: "Calle 5 #1", source: "web", canal: "domicilio", items });
    expect(order.total).toBe(150);
    expect(order.notes).not.toMatch(/Promoción aplicada/);
  });

  it("carrito mixto del lunes: 2x1 SOLO sobre el pastor; el bistec en orden de 3 y la bebida se cobran completos", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const items = [
      { productId: f.ids.pastor, requestedQuantity: 2, tortilla: "harina" as const },
      { productId: f.ids.bistec, requestedQuantity: 6, tortilla: "mixta" as const }, // 2 ordenes de 3 = 328
      { productId: f.ids.jamaica, requestedQuantity: 1 },
    ];
    const q = await quoteOrder(f.repo, { ...base(f), canal: "recoger", items });
    expect(q.subtotal).toBe(2 * 28 + 2 * 164 + 30);
    expect(q.descuento).toBe(28); // una pieza de pastor
    expect(q.total).toBe(q.subtotal - 28);
  });

  it("la regla 'bistec solo en ordenes de 3' sigue intacta aunque haya promo del dia", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    await expect(
      quoteOrder(f.repo, { ...base(f), canal: "recoger", items: [{ productId: f.ids.pastor, requestedQuantity: 2, tortilla: "maiz" }, { productId: f.ids.bistec, requestedQuantity: 4, tortilla: "maiz" }] }),
    ).rejects.toThrow(/solo se vende en órdenes de 3/);
    await expect(
      createOrder(f.repo, {
        ...base(f),
        customerName: "Ana",
        customerPhone: "9991234567",
        source: "whatsapp",
        paymentMethod: "efectivo",
        canal: "recoger",
        items: [{ productId: f.ids.pastor, requestedQuantity: 2, tortilla: "maiz" }, { productId: f.ids.bistec, requestedQuantity: 5, tortilla: "maiz" }],
      }),
    ).rejects.toBeInstanceOf(OrderValidationError);
  });

  it("el bistec (orden de 3) NO entra al 2x1 del pastor aunque se pida en multiplos", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const q = await quoteOrder(f.repo, { ...base(f), canal: "recoger", items: [{ productId: f.ids.bistec, requestedQuantity: 6, tortilla: "maiz" }] });
    expect(q.descuento).toBe(0);
    expect(q.total).toBe(328);
    expect(q.promocionesSugeridas.map((s) => s.code)).toEqual(["LUNES2X1"]); // vale hoy, pero este pedido no la dispara
  });

  it("un codigo manual sigue ganando sobre la automatica", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    await f.repo.createPromotion(f.organizationId, { code: "DIEZ", name: "10%", type: "percentage", value: 10 });
    const order = await createOrder(f.repo, {
      ...base(f),
      customerName: "Ana",
      customerPhone: "9991234567",
      source: "whatsapp",
      paymentMethod: "efectivo",
      canal: "recoger",
      promoCode: "diez",
      items: [{ productId: f.ids.pastor, requestedQuantity: 4, tortilla: "maiz" }],
    });
    expect(order.total).toBe(100.8); // 112 - 10%, sin el 2x1 automatico
    expect(order.notes).toMatch(/Promoción aplicada: DIEZ/);
  });
});
