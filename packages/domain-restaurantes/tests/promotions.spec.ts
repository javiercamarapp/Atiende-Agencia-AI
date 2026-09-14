// Fase 11 — pruebas del motor real de promociones (ver src/promotions.ts): reglas
// de vigencia puras + CRUD real del repositorio (InMemoryRestaurantesRepository).
// Las pruebas de integración con el motor de pedidos (createOrder aplicando el
// descuento al total real) viven en orders.spec.ts; las de HTTP end-to-end en
// apps/api/tests/restaurantes-admin-promotions.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyPromotionToOrderTotal, assertPromotionApplicable, computePromotionDiscount, normalizePromotionCode } from "../src/promotions.ts";
import { PromotionError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { Promotion } from "../src/types.ts";

/** Fecha de HOY (calculada, nunca hardcodeada) a una hora local fija -- evita el
 * "date-rot" de asumir un día de la semana o una fecha calendario fijos (barrido
 * real de esta sesión, ver historial de commits de fix(tests) sobre date-rot): al
 * fijar solo la hora/minuto sobre `new Date()` real, la prueba nunca depende de en
 * qué fecha se ejecute. */
function atLocalTime(hh: number, mm: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
}

function buildPromotion(overrides: Partial<Promotion> = {}): Promotion {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    code: "BIENVENIDA10",
    name: "Bienvenida",
    description: null,
    type: "percentage",
    value: 10,
    minOrderTotal: null,
    startsAt: null,
    endsAt: null,
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    maxUses: null,
    timesUsed: 0,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("normalizePromotionCode", () => {
  it("mayúsculas + recorta espacios", () => {
    expect(normalizePromotionCode("  bienvenida10 ")).toBe("BIENVENIDA10");
  });
});

describe("computePromotionDiscount", () => {
  it("porcentaje: calcula sobre el total real, redondeado a centavos", () => {
    const promo = buildPromotion({ type: "percentage", value: 10 });
    expect(computePromotionDiscount(promo, 199.99)).toBeCloseTo(20, 2);
  });

  it("fijo: nunca deja el pedido en negativo (se acota al total real)", () => {
    const promo = buildPromotion({ type: "fixed", value: 500 });
    expect(computePromotionDiscount(promo, 90)).toBe(90);
  });

  it("fijo: descuenta el valor exacto cuando cabe dentro del total", () => {
    const promo = buildPromotion({ type: "fixed", value: 25 });
    expect(computePromotionDiscount(promo, 90)).toBe(25);
  });
});

describe("assertPromotionApplicable — vigencia real", () => {
  it("promoción inactiva -> rechazada", () => {
    const promo = buildPromotion({ isActive: false });
    expect(() => assertPromotionApplicable(promo, 100, new Date())).toThrow(PromotionError);
  });

  it("todavía no vigente (startsAt en el futuro) -> rechazada", () => {
    const promo = buildPromotion({ startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(() => assertPromotionApplicable(promo, 100, new Date())).toThrow(/todavía no está vigente/);
  });

  it("ya expiró (endsAt en el pasado) -> rechazada", () => {
    const promo = buildPromotion({ endsAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(() => assertPromotionApplicable(promo, 100, new Date())).toThrow(/ya expiró/);
  });

  it("dentro del rango de fechas -> aplica", () => {
    const promo = buildPromotion({
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(() => assertPromotionApplicable(promo, 100, new Date())).not.toThrow();
  });

  it("día de la semana fuera de daysOfWeek -> rechazada", () => {
    const now = new Date();
    const otroDia = (now.getDay() + 1) % 7; // cualquier día distinto al de hoy
    const promo = buildPromotion({ daysOfWeek: [otroDia] });
    expect(() => assertPromotionApplicable(promo, 100, now)).toThrow(/no aplica el día de hoy/);
  });

  it("día de la semana dentro de daysOfWeek -> aplica", () => {
    const now = new Date();
    const promo = buildPromotion({ daysOfWeek: [now.getDay()] });
    expect(() => assertPromotionApplicable(promo, 100, now)).not.toThrow();
  });

  it("fuera de la ventana de hora (sin cruzar medianoche) -> rechazada", () => {
    const now = atLocalTime(20, 0);
    const promo = buildPromotion({ startTime: "12:00", endTime: "17:00" });
    expect(() => assertPromotionApplicable(promo, 100, now)).toThrow(/solo aplica de/);
  });

  it("dentro de la ventana de hora que CRUZA medianoche (ej. 22:00-02:00) -> aplica", () => {
    const now = atLocalTime(23, 30);
    const promo = buildPromotion({ startTime: "22:00", endTime: "02:00" });
    expect(() => assertPromotionApplicable(promo, 100, now)).not.toThrow();
  });

  it("fuera de la ventana que cruza medianoche -> rechazada", () => {
    const now = atLocalTime(12, 0); // mediodía, fuera de 22:00-02:00
    const promo = buildPromotion({ startTime: "22:00", endTime: "02:00" });
    expect(() => assertPromotionApplicable(promo, 100, now)).toThrow(/solo aplica de/);
  });

  it("maxUses ya alcanzado -> rechazada", () => {
    const promo = buildPromotion({ maxUses: 5, timesUsed: 5 });
    expect(() => assertPromotionApplicable(promo, 100, new Date())).toThrow(/límite de usos/);
  });

  it("maxUses todavía no alcanzado -> aplica", () => {
    const promo = buildPromotion({ maxUses: 5, timesUsed: 4 });
    expect(() => assertPromotionApplicable(promo, 100, new Date())).not.toThrow();
  });

  it("total por debajo de minOrderTotal -> rechazada", () => {
    const promo = buildPromotion({ minOrderTotal: 200 });
    expect(() => assertPromotionApplicable(promo, 150, new Date())).toThrow(/pedido mínimo/);
  });

  it("total alcanza minOrderTotal exacto -> aplica", () => {
    const promo = buildPromotion({ minOrderTotal: 200 });
    expect(() => assertPromotionApplicable(promo, 200, new Date())).not.toThrow();
  });
});

describe("applyPromotionToOrderTotal — compone sobre el total real, nunca duplica precio de línea", () => {
  it("aplica un 10% real y devuelve el nuevo total + el descuento", () => {
    const promo = buildPromotion({ type: "percentage", value: 10 });
    const result = applyPromotionToOrderTotal(90, promo, new Date());
    expect(result).toEqual({ total: 81, discount: 9 });
  });

  it("lanza PromotionError sin tocar el total si no es aplicable", () => {
    const promo = buildPromotion({ isActive: false });
    expect(() => applyPromotionToOrderTotal(90, promo, new Date())).toThrow(PromotionError);
  });
});

describe("Promociones — CRUD real del repositorio", () => {
  it("crea una promoción real y la resuelve por código", async () => {
    const fixture = buildRestaurantFixture();
    const created = await fixture.repo.createPromotion(fixture.organizationId, {
      code: "descuento10",
      name: "10% en toda la cuenta",
      type: "percentage",
      value: 10,
    });
    expect(created.code).toBe("descuento10"); // el repo no normaliza -- eso es responsabilidad de la capa de aplicación
    expect(created.timesUsed).toBe(0);
    expect(created.isActive).toBe(true);

    const found = await fixture.repo.findPromotionByCode(fixture.organizationId, "descuento10");
    expect(found?.id).toBe(created.id);
  });

  it("código de otra organización nunca resuelve (aislamiento real)", async () => {
    const fixture = buildRestaurantFixture();
    const otherOrgId = randomUUID();
    await fixture.repo.createPromotion(otherOrgId, { code: "AJENO", name: "x", type: "fixed", value: 10 });
    expect(await fixture.repo.findPromotionByCode(fixture.organizationId, "AJENO")).toBeNull();
  });

  it("edita solo los campos del patch, preserva el resto", async () => {
    const fixture = buildRestaurantFixture();
    const created = await fixture.repo.createPromotion(fixture.organizationId, { code: "EDITABLE", name: "Original", type: "fixed", value: 20, maxUses: 10 });
    const updated = await fixture.repo.updatePromotion(fixture.organizationId, created.id, { name: "Editado", isActive: false });
    expect(updated?.name).toBe("Editado");
    expect(updated?.isActive).toBe(false);
    expect(updated?.value).toBe(20); // no tocado por el patch
    expect(updated?.maxUses).toBe(10); // no tocado por el patch
  });

  it("editar una promoción de OTRA organización devuelve null", async () => {
    const fixture = buildRestaurantFixture();
    const otherOrgId = randomUUID();
    const created = await fixture.repo.createPromotion(otherOrgId, { code: "AJENA", name: "x", type: "fixed", value: 10 });
    expect(await fixture.repo.updatePromotion(fixture.organizationId, created.id, { name: "hackeado" })).toBeNull();
  });

  it("incrementPromotionUses: incrementa de verdad y respeta maxUses de forma atómica", async () => {
    const fixture = buildRestaurantFixture();
    const created = await fixture.repo.createPromotion(fixture.organizationId, { code: "LIMITADA", name: "x", type: "fixed", value: 10, maxUses: 2 });

    expect(await fixture.repo.incrementPromotionUses(fixture.organizationId, created.id)).toBe(true);
    expect(await fixture.repo.incrementPromotionUses(fixture.organizationId, created.id)).toBe(true);
    // Ya alcanzó maxUses=2 -- el tercer intento pierde la carrera, nunca la rebasa.
    expect(await fixture.repo.incrementPromotionUses(fixture.organizationId, created.id)).toBe(false);

    const final = await fixture.repo.findPromotion(fixture.organizationId, created.id);
    expect(final?.timesUsed).toBe(2);
  });

  it("incrementPromotionUses de una promoción desactivada -> false, nunca incrementa", async () => {
    const fixture = buildRestaurantFixture();
    const created = await fixture.repo.createPromotion(fixture.organizationId, { code: "INACTIVA", name: "x", type: "fixed", value: 10, isActive: false });
    expect(await fixture.repo.incrementPromotionUses(fixture.organizationId, created.id)).toBe(false);
  });

  it("listPromotions incluye activas E inactivas (el panel admin necesita ver ambas)", async () => {
    const fixture = buildRestaurantFixture();
    await fixture.repo.createPromotion(fixture.organizationId, { code: "ACTIVA", name: "x", type: "fixed", value: 10 });
    await fixture.repo.createPromotion(fixture.organizationId, { code: "APAGADA", name: "x", type: "fixed", value: 10, isActive: false });
    const listed = await fixture.repo.listPromotions(fixture.organizationId);
    expect(listed.map((p) => p.code).sort()).toEqual(["ACTIVA", "APAGADA"]);
  });
});
