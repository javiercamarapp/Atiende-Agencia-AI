// PM-C2: promociones con ALCANCE POR SUCURSAL (migracion 038, `promotions.property_ids`). El 2x1 del lunes de PM vale
// solo en Francisco de Montejo (T2), Pensiones (T3) y Galerias (T4): en Victory Platz (T7) y Altabrisa (T8) cobra
// completo (P6). Motor puro + de punta a punta sobre el repositorio en memoria, con el reloj de `Date` congelado (nunca
// setInterval: sin relojes con timers vivos). Zona America/Merida (UTC-6 sin horario de verano).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPromotionApplicable, selectAutomaticPromotion } from "../src/promotions.ts";
import { PromotionError } from "../src/errors.ts";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { PersistedOrderItem, Promotion } from "../src/types.ts";

const ZONA = "America/Merida";
// 2026-09-28 es lunes. Merida = UTC-6.
const LUNES_14H = new Date("2026-09-28T20:00:00Z");
const MARTES_14H = new Date("2026-09-29T20:00:00Z");
const DOMINGO_12H = new Date("2026-09-27T18:00:00Z");

const SUC_T2 = randomUUID();
const SUC_T7 = randomUUID();

function promo(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    code: "LUNES2X1PM",
    name: "Lunes 2x1",
    description: null,
    type: "bogo",
    value: 1,
    minOrderTotal: null,
    startsAt: null,
    endsAt: null,
    daysOfWeek: [1],
    startTime: null,
    endTime: null,
    maxUses: null,
    timesUsed: 0,
    isActive: true,
    channels: ["recoger"],
    productIds: ["pastor"],
    autoApply: true,
    courtesyProductIds: null,
    courtesyQuantity: null,
    createdAt: LUNES_14H.toISOString(),
    updatedAt: LUNES_14H.toISOString(),
    ...overrides,
  };
}
const item = (id: string, price: number, quantity: number): PersistedOrderItem => ({ id, name: id, price, quantity });
const items4 = [item("pastor", 28, 4)];
const total = (items: readonly PersistedOrderItem[]) => items.reduce((acc, i) => acc + i.price * i.quantity, 0);
const seleccionar = (promotions: Promotion[], canal: "recoger" | "domicilio", now: Date, propertyId?: string) =>
  selectAutomaticPromotion({ promotions, orderTotal: total(items4), items: items4, canal, now, zonaHoraria: ZONA, ...(propertyId !== undefined ? { propertyId } : {}) });

describe("alcance por sucursal en el motor (selectAutomaticPromotion / assertPromotionApplicable)", () => {
  it("con alcance [T2, T3]: aplica en T2, no en T7 (ni se sugiere: ignora en silencio)", () => {
    const p = promo({ propertyIds: [SUC_T2, randomUUID()] });
    const enT2 = seleccionar([p], "recoger", LUNES_14H, SUC_T2);
    expect(enT2.applied?.promotion.code).toBe("LUNES2X1PM");
    expect(enT2.applied?.discount).toBe(56);
    const enT7 = seleccionar([p], "recoger", LUNES_14H, SUC_T7);
    expect(enT7.applied).toBeNull();
    expect(enT7.suggestions).toEqual([]);
  });

  it("sin alcance (null o ausente) vale en todas las sucursales: la conducta de siempre no cambia", () => {
    for (const propertyIds of [null, undefined]) {
      const p = promo(propertyIds === undefined ? {} : { propertyIds });
      expect(seleccionar([p], "recoger", LUNES_14H, SUC_T7).applied?.discount).toBe(56);
      expect(seleccionar([p], "recoger", LUNES_14H).applied?.discount).toBe(56);
    }
  });

  it("con alcance pero sin sucursal del pedido: no se puede verificar y NO aplica (cierra por defecto)", () => {
    expect(seleccionar([promo({ propertyIds: [SUC_T2] })], "recoger", LUNES_14H).applied).toBeNull();
  });

  it("una lista vacia (la base la rechaza con CHECK) no vale en ninguna sucursal, nunca en todas", () => {
    expect(seleccionar([promo({ propertyIds: [] })], "recoger", LUNES_14H, SUC_T2).applied).toBeNull();
  });

  it("el alcance suma a dia y canal: T2 en martes o a domicilio tampoco aplica", () => {
    const p = promo({ propertyIds: [SUC_T2] });
    expect(seleccionar([p], "recoger", MARTES_14H, SUC_T2).applied).toBeNull();
    expect(seleccionar([p], "domicilio", LUNES_14H, SUC_T2).applied).toBeNull();
  });

  it("assertPromotionApplicable explica el rechazo por sucursal", () => {
    const p = promo({ propertyIds: [SUC_T2] });
    expect(() => assertPromotionApplicable(p, 112, LUNES_14H, ZONA, "recoger", undefined, SUC_T7)).toThrow(PromotionError);
    expect(() => assertPromotionApplicable(p, 112, LUNES_14H, ZONA, "recoger", undefined, SUC_T7)).toThrow(/no aplica en esta sucursal/);
    expect(() => assertPromotionApplicable(p, 112, LUNES_14H, ZONA, "recoger", undefined, SUC_T2)).not.toThrow();
  });
});

describe("2x1 del lunes por sucursal (de punta a punta, en memoria)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Dos sucursales con el MISMO pastor a $28: T2 (fco-montejo, del fixture) y T7 (garcia-lavin). El 2x1 vale solo en T2. */
  async function seed() {
    const f = buildRestaurantFixture();
    const t7 = randomUUID();
    f.repo.seedBranch({ propertyId: t7, organizationId: f.organizationId, name: "García Lavín (Victory Platz)", slug: "garcia-lavin", status: "active", phone: "+529991234568", address: "Victory Platz", lat: null, lng: null });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    await f.repo.upsertBranchZonaHoraria(t7, ZONA);
    const pastor = randomUUID();
    f.repo.seedProduct({ id: pastor, organizationId: f.organizationId, categoryId: f.categories.tacos, name: "Taco Al Pastor (individual)", description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: pastor, price: 28, isAvailable: true });
    f.repo.seedBranchProduct({ propertyId: t7, productId: pastor, price: 28, isAvailable: true });
    const creada = await f.repo.createPromotion(f.organizationId, {
      code: "LUNES2X1PM",
      name: "Lunes 2x1 en tacos al pastor",
      type: "bogo",
      value: 1,
      daysOfWeek: [1],
      channels: ["recoger"],
      productIds: [pastor],
      autoApply: true,
      propertyIds: [f.propertyId],
    });
    return { ...f, t7, pastor, creada };
  }
  const base = (f: { organizationId: string }, branchSlug: string) => ({ organizationId: f.organizationId, branchSlug });
  const pedido = (f: Awaited<ReturnType<typeof seed>>, branchSlug: string, extra: Record<string, unknown> = {}) => ({
    ...base(f, branchSlug),
    customerName: "Ana",
    customerPhone: "9991234567",
    source: "whatsapp" as const,
    paymentMethod: "efectivo" as const,
    canal: "recoger" as const,
    items: [{ productId: f.pastor, requestedQuantity: 4, tortilla: "maiz" as const }],
    ...extra,
  });

  it("el repositorio conserva el alcance al crear y lo cambia al actualizar", async () => {
    const f = await seed();
    expect(f.creada.propertyIds).toEqual([f.propertyId]);
    expect((await f.repo.findPromotionByCode(f.organizationId, "LUNES2X1PM"))?.propertyIds).toEqual([f.propertyId]);
    const sinAlcance = await f.repo.updatePromotion(f.organizationId, f.creada.id, { propertyIds: null });
    expect(sinAlcance?.propertyIds).toBeNull();
    const parche = await f.repo.updatePromotion(f.organizationId, f.creada.id, { name: "Otro nombre" });
    expect(parche?.propertyIds).toBeNull(); // un parche sin `propertyIds` no toca el alcance
  });

  it("lunes, para recoger en T2: 4 tacos al pastor se cobran 2", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const q = await quoteOrder(f.repo, { ...base(f, "fco-montejo"), canal: "recoger", items: [{ productId: f.pastor, requestedQuantity: 4, tortilla: "maiz" }] });
    expect(q.subtotal).toBe(112);
    expect(q.descuento).toBe(56);
    expect(q.total).toBe(56);
    const order = await createOrder(f.repo, pedido(f, "fco-montejo"));
    expect(order.total).toBe(56);
    expect(order.notes).toMatch(/Promoción aplicada: LUNES2X1PM/);
  });

  it("el mismo pedido en T7 cobra 4 (sin descuento, sin sugerencia)", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const q = await quoteOrder(f.repo, { ...base(f, "garcia-lavin"), canal: "recoger", items: [{ productId: f.pastor, requestedQuantity: 4, tortilla: "maiz" }] });
    expect(q.descuento).toBe(0);
    expect(q.total).toBe(112);
    expect(q.promocionAplicada).toBeNull();
    expect(q.promocionesSugeridas).toEqual([]);
    const order = await createOrder(f.repo, pedido(f, "garcia-lavin"));
    expect(order.total).toBe(112);
    expect(order.notes ?? "").not.toMatch(/Promoción aplicada/);
  });

  it("a domicilio en T2 cobra 4", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const order = await createOrder(f.repo, pedido(f, "fco-montejo", { canal: "domicilio", customerAddress: "Calle 5 #1", colonia: "Montejo" }));
    expect(order.total).toBe(112);
  });

  it("un martes en T2 cobra 4", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const order = await createOrder(f.repo, pedido(f, "fco-montejo"));
    expect(order.total).toBe(112);
  });

  it("P6 (conducta provisional): pedido creado un DOMINGO para recoger el LUNES se evalua con el dia de recogida", async () => {
    vi.setSystemTime(DOMINGO_12H);
    const f = await seed();
    const programadoPara = "2026-09-28T14:00:00-06:00";
    const enT2 = await createOrder(f.repo, pedido(f, "fco-montejo", { programadoPara }));
    expect(enT2.status).toBe("programado");
    expect(enT2.total).toBe(56);
    const enT7 = await createOrder(f.repo, pedido(f, "garcia-lavin", { programadoPara }));
    expect(enT7.total).toBe(112);
    // ... y el mismo domingo, sin programar (recoger YA), no hay 2x1 en ninguna sucursal
    const ahora = await createOrder(f.repo, pedido(f, "fco-montejo"));
    expect(ahora.total).toBe(112);
  });

  it("un codigo manual con alcance se rechaza fuera de su sucursal", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    await expect(createOrder(f.repo, pedido(f, "garcia-lavin", { promoCode: "LUNES2X1PM" }))).rejects.toThrow(/no aplica en esta sucursal/);
    const orderT2 = await createOrder(f.repo, pedido(f, "fco-montejo", { promoCode: "lunes2x1pm" }));
    expect(orderT2.total).toBe(56);
  });
});
