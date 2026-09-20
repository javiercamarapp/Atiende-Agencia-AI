// Fase 11 — pruebas del motor real de promociones (ver src/promotions.ts): reglas
// de vigencia puras + CRUD real del repositorio (InMemoryRestaurantesRepository).
// Las pruebas de integración con el motor de pedidos (createOrder aplicando el
// descuento al total real) viven en orders.spec.ts; las de HTTP end-to-end en
// apps/api/tests/restaurantes-admin-promotions.spec.ts.
//
// FASE 3 (producto) — `assertPromotionApplicable`/`applyPromotionToOrderTotal`
// ahora reciben `zonaHoraria` explícito (ver el comentario de cabecera de
// `src/promotions.ts` para el bug real que corrige: `now.getDay()`/`getHours()`/
// `getMinutes()` leían el reloj del PROCESO, UTC en Vercel, nunca la hora local
// del negocio). Los tests de "sigue funcionando igual" de abajo fijan
// `ZONA = "America/Mexico_City"` y construyen el instante EN esa zona (nunca en
// la zona local del runner, que en CI es UTC) -- `instanteEnZona`/`hoyEnZona`
// reemplazan el viejo `atLocalTime` (que asumía que "la zona del runner" y "la
// zona del negocio" eran la misma, justo el supuesto que esta fase corrige).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyPromotionToOrderTotal, assertPromotionApplicable, computePromotionDiscount, normalizePromotionCode } from "../src/promotions.ts";
import { PromotionError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { Promotion } from "../src/types.ts";

const ZONA = "America/Mexico_City";

/** Offset real (en minutos) de `timeZone` respecto a UTC en el instante `date` --
 * mismo truco estándar que `@atiende/core-tenancy` documenta para convertir hora
 * de PARED de una zona a un instante absoluto (no hay constructor nativo para
 * "esta hora de pared en esta zona" en JS/Node). */
function offsetMinutosEnZona(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = dtf.formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return (asUTC - date.getTime()) / 60000;
}

/** El instante absoluto (UTC) que corresponde a `hh:mm` del `y-m-d` dado, EN
 * `timeZone` -- verificado con Intl.DateTimeFormat en zonas de offset fijo
 * (America/Mexico_City, America/Cancun) y con horario de verano
 * (America/Tijuana) antes de usarse en los tests de abajo (round-trip exacto en
 * los tres casos). */
function instanteEnZona(timeZone: string, y: number, m: number, d: number, hh: number, mm: number): Date {
  const guessUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset = offsetMinutosEnZona(timeZone, new Date(guessUtc));
  return new Date(guessUtc - offset * 60000);
}

/** `hh:mm` de HOY (calculado sobre el reloj real, nunca hardcodeado) EN
 * `timeZone` -- reemplaza al viejo `atLocalTime` (que construía la fecha en la
 * zona LOCAL del proceso de prueba, nunca en una zona de negocio real). */
function hoyEnZona(timeZone: string, hh: number, mm: number): Date {
  const now = new Date();
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number) as [number, number, number];
  return instanteEnZona(timeZone, y, m, d, hh, mm);
}

const WEEKDAY_SHORT_TO_JS_DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Día de la semana (convención `Date#getDay()`, 0=domingo) de `date` EN
 * `timeZone` -- para construir el "control" de un test sin depender de en qué
 * zona corre el runner. */
function diaSemanaEnZona(timeZone: string, date: Date): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return WEEKDAY_SHORT_TO_JS_DAY[weekday] ?? 0;
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
    expect(() => assertPromotionApplicable(promo, 100, new Date(), ZONA)).toThrow(PromotionError);
  });

  it("todavía no vigente (startsAt en el futuro) -> rechazada", () => {
    const promo = buildPromotion({ startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(() => assertPromotionApplicable(promo, 100, new Date(), ZONA)).toThrow(/todavía no está vigente/);
  });

  it("ya expiró (endsAt en el pasado) -> rechazada", () => {
    const promo = buildPromotion({ endsAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(() => assertPromotionApplicable(promo, 100, new Date(), ZONA)).toThrow(/ya expiró/);
  });

  it("dentro del rango de fechas -> aplica", () => {
    const promo = buildPromotion({
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(() => assertPromotionApplicable(promo, 100, new Date(), ZONA)).not.toThrow();
  });

  it("día de la semana fuera de daysOfWeek -> rechazada", () => {
    const now = new Date();
    const otroDia = (diaSemanaEnZona(ZONA, now) + 1) % 7; // cualquier día distinto al de hoy EN ZONA.
    const promo = buildPromotion({ daysOfWeek: [otroDia] });
    expect(() => assertPromotionApplicable(promo, 100, now, ZONA)).toThrow(/no aplica el día de hoy/);
  });

  it("día de la semana dentro de daysOfWeek -> aplica", () => {
    const now = new Date();
    const promo = buildPromotion({ daysOfWeek: [diaSemanaEnZona(ZONA, now)] });
    expect(() => assertPromotionApplicable(promo, 100, now, ZONA)).not.toThrow();
  });

  it("fuera de la ventana de hora (sin cruzar medianoche) -> rechazada", () => {
    const now = hoyEnZona(ZONA, 20, 0);
    const promo = buildPromotion({ startTime: "12:00", endTime: "17:00" });
    expect(() => assertPromotionApplicable(promo, 100, now, ZONA)).toThrow(/solo aplica de/);
  });

  it("dentro de la ventana de hora que CRUZA medianoche (ej. 22:00-02:00) -> aplica", () => {
    const now = hoyEnZona(ZONA, 23, 30);
    const promo = buildPromotion({ startTime: "22:00", endTime: "02:00" });
    expect(() => assertPromotionApplicable(promo, 100, now, ZONA)).not.toThrow();
  });

  it("fuera de la ventana que cruza medianoche -> rechazada", () => {
    const now = hoyEnZona(ZONA, 12, 0); // mediodía, fuera de 22:00-02:00
    const promo = buildPromotion({ startTime: "22:00", endTime: "02:00" });
    expect(() => assertPromotionApplicable(promo, 100, now, ZONA)).toThrow(/solo aplica de/);
  });

  it("maxUses ya alcanzado -> rechazada", () => {
    const promo = buildPromotion({ maxUses: 5, timesUsed: 5 });
    expect(() => assertPromotionApplicable(promo, 100, new Date(), ZONA)).toThrow(/límite de usos/);
  });

  it("maxUses todavía no alcanzado -> aplica", () => {
    const promo = buildPromotion({ maxUses: 5, timesUsed: 4 });
    expect(() => assertPromotionApplicable(promo, 100, new Date(), ZONA)).not.toThrow();
  });

  it("total por debajo de minOrderTotal -> rechazada", () => {
    const promo = buildPromotion({ minOrderTotal: 200 });
    expect(() => assertPromotionApplicable(promo, 150, new Date(), ZONA)).toThrow(/pedido mínimo/);
  });

  it("total alcanza minOrderTotal exacto -> aplica", () => {
    const promo = buildPromotion({ minOrderTotal: 200 });
    expect(() => assertPromotionApplicable(promo, 200, new Date(), ZONA)).not.toThrow();
  });
});

// FASE 3 (producto) — EFECTO real del fix: el MISMO instante absoluto, evaluado
// contra DOS zonas horarias reales, da un resultado DISTINTO cuando la zona
// cruza un límite (de día o de franja horaria) que la otra todavía no cruzó.
// Instante elegido y verificado con Intl.DateTimeFormat ANTES de escribir estos
// tests (nunca asumido):
//   new Date("2026-01-02T05:30:00.000Z") es:
//     - jueves 23:30 en America/Mexico_City (UTC-6, sin horario de verano)
//     - viernes 00:30 en America/Cancun     (UTC-5, sin horario de verano desde 2015)
describe("assertPromotionApplicable — EFECTO real de la zona horaria (FASE 3)", () => {
  const INSTANTE = new Date("2026-01-02T05:30:00.000Z");

  it("día de la semana: el MISMO instante es 'jueves' en CDMX y 'viernes' en Cancún -- una promo de viernes aplica en una zona y no en la otra", () => {
    const promoSoloViernes = buildPromotion({ daysOfWeek: [5] }); // 5 = viernes.

    // Contra el bug (siempre `now.getDay()` del proceso, nunca la zona real): el
    // resultado sería el MISMO sin importar qué zona se pasara -- el fix hace que
    // dependa de la zona real de la property.
    expect(() => assertPromotionApplicable(promoSoloViernes, 100, INSTANTE, "America/Mexico_City")).toThrow(/no aplica el día de hoy/); // sigue siendo jueves en CDMX.
    expect(() => assertPromotionApplicable(promoSoloViernes, 100, INSTANTE, "America/Cancun")).not.toThrow(); // ya es viernes en Cancún.
  });

  it("franja horaria: el MISMO instante es 23:30 en CDMX (dentro de 22:00-02:00) y 00:30 en Cancún (también dentro, pero ya del día siguiente)", () => {
    const promoNocturna = buildPromotion({ startTime: "22:00", endTime: "02:00" });
    // Ambas zonas caen dentro de la ventana que cruza medianoche -- control
    // positivo de que el fix no rompe el caso "misma ventana, ambas zonas".
    expect(() => assertPromotionApplicable(promoNocturna, 100, INSTANTE, "America/Mexico_City")).not.toThrow();
    expect(() => assertPromotionApplicable(promoNocturna, 100, INSTANTE, "America/Cancun")).not.toThrow();

    // Pero una ventana que SOLO cubre "tarde-noche" (17:00-21:00) sí discrepa: a
    // las 23:30 CDMX ya cerró; a las 00:30 Cancún (ya el día siguiente) también
    // cerró -- control de que ninguna zona la ve abierta a esta hora exacta.
    const promoTarde = buildPromotion({ startTime: "17:00", endTime: "21:00" });
    expect(() => assertPromotionApplicable(promoTarde, 100, INSTANTE, "America/Mexico_City")).toThrow(/solo aplica de/);
    expect(() => assertPromotionApplicable(promoTarde, 100, INSTANTE, "America/Cancun")).toThrow(/solo aplica de/);

    // Control real de la discrepancia de FRANJA (no solo de día): una ventana
    // "madrugada" 00:00-01:00 SOLO está abierta en Cancún (00:30) a este
    // instante, nunca en CDMX (23:30, todavía no es medianoche).
    const promoMadrugada = buildPromotion({ startTime: "00:00", endTime: "01:00" });
    expect(() => assertPromotionApplicable(promoMadrugada, 100, INSTANTE, "America/Mexico_City")).toThrow(/solo aplica de/);
    expect(() => assertPromotionApplicable(promoMadrugada, 100, INSTANTE, "America/Cancun")).not.toThrow();
  });
});

describe("applyPromotionToOrderTotal — compone sobre el total real, nunca duplica precio de línea", () => {
  it("aplica un 10% real y devuelve el nuevo total + el descuento", () => {
    const promo = buildPromotion({ type: "percentage", value: 10 });
    const result = applyPromotionToOrderTotal(90, promo, new Date(), ZONA);
    expect(result).toEqual({ total: 81, discount: 9 });
  });

  it("lanza PromotionError sin tocar el total si no es aplicable", () => {
    const promo = buildPromotion({ isActive: false });
    expect(() => applyPromotionToOrderTotal(90, promo, new Date(), ZONA)).toThrow(PromotionError);
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
