// H-P3-04 -- configuracion del hotel desde el panel. Dos capas:
//  1. Adaptador en memoria: validaciones espejo de `hoteles.set_*` (migrations/047), bitacora con valor anterior y nuevo, idempotencia, y que
//     el impuesto/la politica/la sobreventa EDITADOS son los que consumen cotizacion, cancelacion y disponibilidad.
//  2. PostgresHotelesRepository REAL sobre AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion): sin la migracion 047 las
//     lecturas caen a los valores por omision, las escrituras lanzan HotelConfigUnavailableError y la sesion sigue utilizable. Cada test
//     FALLA si se quita el SAVEPOINT.
import { describe, expect, it } from "vitest";
import {
  CANCELLATION_POLICY_DEFAULTS,
  HotelConfigUnavailableError,
  InMemoryHotelesRepository,
  PostgresHotelesRepository,
  TAX_CONFIG_DEFAULTS,
  computeQuote,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const ORG = "00000000-0000-0000-0000-0000000000b1";
const RT = "00000000-0000-0000-0000-0000000000c1";
const ACTOR = "00000000-0000-0000-0000-0000000000d1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const siguiente = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };
const sigueUtil = async (session: AbortAwareFakeSession) => {
  await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
};

describe("adaptador en memoria: impuestos", () => {
  it("sin fila devuelve los valores por omision con configurado:false", async () => {
    const repo = new InMemoryHotelesRepository();
    await expect(repo.loadTaxSettings(P)).resolves.toEqual({ ...TAX_CONFIG_DEFAULTS, configurado: false });
  });

  it("guardar deja la bitacora con valor anterior nulo; cambiar el ISH guarda anterior y nuevo; repetir no duplica", async () => {
    const repo = new InMemoryHotelesRepository();
    const base = { propertyId: P, organizationId: ORG, actorUserId: ACTOR, ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0 };
    await repo.saveTaxSettings(base);
    await repo.saveTaxSettings(base);
    await repo.saveTaxSettings({ ...base, ishRate: 0.04 });
    const audit = await repo.listConfigAudit(P, 10);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ area: "impuestos", actorUserId: ACTOR, valorAnterior: { ishRate: 0.03 }, valorNuevo: { ishRate: 0.04 } });
    expect(audit[1]).toMatchObject({ valorAnterior: null, valorNuevo: { ishRate: 0.03 } });
  });

  it("rangos invalidos se rechazan con el mismo prefijo que la funcion SQL", async () => {
    const repo = new InMemoryHotelesRepository();
    const base = { propertyId: P, organizationId: ORG, actorUserId: ACTOR, ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0 };
    await expect(repo.saveTaxSettings({ ...base, ivaRate: 1.5 })).rejects.toThrow(/^impuestos_invalidos/);
    await expect(repo.saveTaxSettings({ ...base, discountThreshold: -1 })).rejects.toThrow(/^impuestos_invalidos/);
  });

  it("la cotizacion usa el impuesto EDITADO (el motor de cotizacion consume loadTaxConfig)", async () => {
    const repo = new InMemoryHotelesRepository();
    const rates = [{ date: "2026-11-01", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false }];
    const quote = async () =>
      computeQuote({ checkInDate: "2026-11-01", checkOutDate: "2026-11-02", currency: "MXN", nightlyRates: rates, taxConfig: await repo.loadTaxConfig(P) });
    await repo.saveTaxSettings({ propertyId: P, organizationId: ORG, actorUserId: ACTOR, ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0 });
    expect((await quote()).totalAmount).toBe(1190);
    await repo.saveTaxSettings({ propertyId: P, organizationId: ORG, actorUserId: ACTOR, ivaRate: 0.16, ishRate: 0.05, discountThreshold: 500, dsaPerNight: 0 });
    expect((await quote()).totalAmount).toBe(1210);
  });
});

describe("adaptador en memoria: politica de cancelacion y sobreventa", () => {
  it("la politica editada es la que lee la cancelacion (loadReservationCancellationPolicy) y el texto se recorta", async () => {
    const repo = new InMemoryHotelesRepository();
    await expect(repo.loadCancellationPolicySettings(P)).resolves.toEqual({ ...CANCELLATION_POLICY_DEFAULTS, configurado: false });
    const saved = await repo.saveCancellationPolicySettings({ propertyId: P, organizationId: ORG, actorUserId: ACTOR, freeUntilHours: 72, penaltyPct: 0.25, guestText: "  Gratis hasta 72 h.  " });
    expect(saved).toEqual({ freeUntilHours: 72, penaltyPct: 0.25, guestText: "Gratis hasta 72 h.", configurado: true });
    await expect(repo.loadReservationCancellationPolicy(P)).resolves.toEqual({ freeUntilHours: 72, penaltyPct: 0.25 });
  });

  it("penalidad fuera de 0-1 y horas negativas se rechazan", async () => {
    const repo = new InMemoryHotelesRepository();
    const base = { propertyId: P, organizationId: ORG, actorUserId: ACTOR, freeUntilHours: 24, penaltyPct: 0.5, guestText: null };
    await expect(repo.saveCancellationPolicySettings({ ...base, penaltyPct: 1.5 })).rejects.toThrow(/^politica_invalida/);
    await expect(repo.saveCancellationPolicySettings({ ...base, freeUntilHours: -1 })).rejects.toThrow(/^politica_invalida/);
  });

  it("sobreventa: guarda, lista, bitacora y devuelve null para un tipo ajeno", async () => {
    const repo = new InMemoryHotelesRepository();
    repo.seedRoomType(P, RT, { name: "Doble" });
    const saved = await repo.saveRoomTypeOverbooking({ propertyId: P, organizationId: ORG, actorUserId: ACTOR, roomTypeId: RT, maxOverbookRooms: 2, thresholdPct: 90 });
    expect(saved).toMatchObject({ roomTypeId: RT, maxOverbookRooms: 2, thresholdPct: 90 });
    await expect(repo.listRoomTypeOverbooking(P)).resolves.toEqual([{ roomTypeId: RT, name: "Doble", maxOverbookRooms: 2, thresholdPct: 90 }]);
    await expect(repo.saveRoomTypeOverbooking({ propertyId: "otra", organizationId: ORG, actorUserId: ACTOR, roomTypeId: RT, maxOverbookRooms: 1, thresholdPct: null })).resolves.toBeNull();
    await expect(repo.saveRoomTypeOverbooking({ propertyId: P, organizationId: ORG, actorUserId: ACTOR, roomTypeId: RT, maxOverbookRooms: 101, thresholdPct: null })).rejects.toThrow(/^sobreventa_invalida/);
    expect(await repo.listConfigAudit(P, 10)).toHaveLength(1);
  });
});

describe("adaptador en memoria: tarifas", () => {
  async function seed() {
    const repo = new InMemoryHotelesRepository();
    repo.seedRoomType(P, RT, { name: "Doble" });
    await repo.upsertRatePlanRange({ propertyId: P, organizationId: ORG, roomTypeId: RT, startDate: "2026-11-01", endDate: "2026-11-03", price: 1000, currency: "MXN", minStay: 1, closedToArrival: false, closedToDeparture: false });
    const rows = await repo.listRatePlans({ propertyId: P, from: "2026-11-01", to: "2026-11-30", roomTypeId: null, limit: 100 });
    return { repo, rows };
  }

  it("lista una fila por noche con id estable y orden por fecha", async () => {
    const { repo, rows } = await seed();
    expect(rows.map((r) => r.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    const again = await repo.listRatePlans({ propertyId: P, from: "2026-11-01", to: "2026-11-30", roomTypeId: null, limit: 100 });
    expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    await expect(repo.listRatePlans({ propertyId: P, from: "2026-11-02", to: "2026-11-02", roomTypeId: RT, limit: 100 })).resolves.toHaveLength(1);
    await expect(repo.listRatePlans({ propertyId: P, from: "2026-11-01", to: "2026-11-30", roomTypeId: "otro", limit: 100 })).resolves.toHaveLength(0);
  });

  it("editar el precio lo marca como manual, la cotizacion lo usa, y repetir la edicion es idempotente (una sola entrada de bitacora)", async () => {
    const { repo, rows } = await seed();
    const target = rows[0]!;
    const edit = { propertyId: P, organizationId: ORG, actorUserId: ACTOR, rateId: target.id, price: 1500, minStay: null };
    const first = await repo.saveRatePrice(edit);
    await repo.saveRatePrice(edit);
    expect(first).toMatchObject({ price: 1500, manualPriceAt: expect.any(String) });
    expect(await repo.listConfigAudit(P, 10)).toHaveLength(1);
    const nightly = await repo.loadNightlyRates(P, RT, "2026-11-01", "2026-11-03");
    expect(nightly.find((n) => n.date === "2026-11-01")?.price).toBe(1500);
  });

  it("tarifa de otra property -> null; precio negativo -> rechazo", async () => {
    const { repo, rows } = await seed();
    await expect(repo.saveRatePrice({ propertyId: "otra", organizationId: ORG, actorUserId: ACTOR, rateId: rows[0]!.id, price: 1, minStay: null })).resolves.toBeNull();
    await expect(repo.saveRatePrice({ propertyId: P, organizationId: ORG, actorUserId: ACTOR, rateId: rows[0]!.id, price: -1, minStay: null })).rejects.toThrow(/^tarifa_invalida/);
  });
});

describe("adaptador en memoria: el motor de revenue no pisa un precio fijado a mano", () => {
  async function conRecomendacion() {
    const repo = new InMemoryHotelesRepository();
    repo.seedRoomType(P, RT, { name: "Doble" });
    await repo.upsertRatePlanRange({ propertyId: P, organizationId: ORG, roomTypeId: RT, startDate: "2026-11-01", endDate: "2026-11-02", price: 1000, currency: "MXN", minStay: 1, closedToArrival: false, closedToDeparture: false });
    const rec = (fecha: string) =>
      repo.insertRateRecommendationAsSystem({ organizationId: ORG, propertyId: P, roomTypeId: RT, fecha, currentBarPrice: 1000, recommendedPrice: 1100, suggestedMinStay: 1, desglose: {} } as never);
    return { repo, rec };
  }

  async function conPrecioManual() {
    const { repo, rec } = await conRecomendacion();
    const [fila] = await repo.listRatePlans({ propertyId: P, from: "2026-11-01", to: "2026-11-01", roomTypeId: null, limit: 10 });
    await repo.saveRatePrice({ propertyId: P, organizationId: ORG, actorUserId: ACTOR, rateId: fila!.id, price: 1200, minStay: null });
    return { repo, rec };
  }

  it("una tarifa cargada por el alta de rango del panel NO queda manual: el motor aplica la recomendacion", async () => {
    const { repo, rec } = await conRecomendacion();
    const [antes] = await repo.listRatePlans({ propertyId: P, from: "2026-11-01", to: "2026-11-01", roomTypeId: null, limit: 10 });
    expect(antes?.manualPriceAt).toBeNull();
    const r = await rec("2026-11-01");
    await repo.applyRateRecommendationAsSystem(r.id);
    const [fila] = await repo.listRatePlans({ propertyId: P, from: "2026-11-01", to: "2026-11-01", roomTypeId: null, limit: 10 });
    expect(fila).toMatchObject({ price: 1100, manualPriceAt: null });
  });

  it("un precio fijado a mano con saveRatePrice bloquea la aplicacion automatica (pendiente): tarifa_manual_vigente y el precio no cambia", async () => {
    const { repo, rec } = await conPrecioManual();
    const r = await rec("2026-11-01");
    await expect(repo.applyRateRecommendationAsSystem(r.id)).rejects.toThrow(/^tarifa_manual_vigente/);
    const [fila] = await repo.listRatePlans({ propertyId: P, from: "2026-11-01", to: "2026-11-01", roomTypeId: null, limit: 10 });
    expect(fila).toMatchObject({ price: 1200 });
    expect(fila?.manualPriceAt).not.toBeNull();
  });

  it("la aprobacion humana explicita (aprobada) se aplica sobre un precio manual y limpia la marca", async () => {
    const { repo, rec } = await conPrecioManual();
    const r = await rec("2026-11-01");
    await repo.approveRateRecommendation(r.id, ACTOR);
    await repo.applyRateRecommendationAsSystem(r.id);
    const [fila] = await repo.listRatePlans({ propertyId: P, from: "2026-11-01", to: "2026-11-01", roomTypeId: null, limit: 10 });
    expect(fila).toMatchObject({ price: 1100, manualPriceAt: null });
  });
});

describe("PostgresHotelesRepository con la base SIN migrar (AbortAwareFakeSession)", () => {
  it("lecturas: impuestos, politica, tarifas y bitacora caen al camino anterior y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /dsa_per_night from hoteles\.tax_config/i, respond: () => pgError("42703", "column dsa_per_night does not exist") },
      { match: /from hoteles\.tax_config/i, respond: () => [{ iva_rate: "0.1600", ish_rate: "0.0300", discount_threshold: "500.00" }] },
      { match: /guest_text from hoteles\.cancellation_policy/i, respond: () => pgError("42703", "column guest_text does not exist") },
      { match: /from hoteles\.cancellation_policy/i, respond: () => [] },
      { match: /manual_price_at/i, respond: () => pgError("42703", "column rp.manual_price_at does not exist") },
      { match: /from hoteles\.rate_plan/i, respond: () => [{ id: "r1", room_type_id: RT, room_type_name: "Doble", date: "2026-11-01", price: "1000.00", currency: "MXN", min_stay: 1, closed_to_arrival: false, closed_to_departure: false }] },
      { match: /from hoteles\.config_audit_log/i, respond: () => pgError("42P01", "relation hoteles.config_audit_log does not exist") },
      siguiente,
    ]);
    const repo = new PostgresHotelesRepository(session);
    await expect(repo.loadTaxSettings(P)).resolves.toEqual({ ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0, configurado: true });
    await expect(repo.loadCancellationPolicySettings(P)).resolves.toEqual({ ...CANCELLATION_POLICY_DEFAULTS, configurado: false });
    const rates = await repo.listRatePlans({ propertyId: P, from: "2026-11-01", to: "2026-11-30", roomTypeId: null, limit: 10 });
    expect(rates).toEqual([expect.objectContaining({ id: "r1", price: 1000, manualPriceAt: null })]);
    await expect(repo.listConfigAudit(P, 10)).resolves.toEqual([]);
    await sigueUtil(session);
  });

  it("escrituras: sin la funcion set_* lanzan HotelConfigUnavailableError (nunca 25P02) y la sesion sigue utilizable", async () => {
    const missing = () => pgError("42883", "function hoteles.set_x(uuid) does not exist");
    const session = new AbortAwareFakeSession([
      { match: /hoteles\.set_tax_config/i, respond: missing },
      { match: /hoteles\.set_cancellation_policy/i, respond: missing },
      { match: /hoteles\.set_room_type_overbooking/i, respond: missing },
      { match: /hoteles\.set_rate_price/i, respond: missing },
      siguiente,
    ]);
    const repo = new PostgresHotelesRepository(session);
    const base = { propertyId: P, organizationId: ORG, actorUserId: ACTOR };
    await expect(repo.saveTaxSettings({ ...base, ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0 })).rejects.toBeInstanceOf(HotelConfigUnavailableError);
    await sigueUtil(session);
    await expect(repo.saveCancellationPolicySettings({ ...base, freeUntilHours: 24, penaltyPct: 0.5, guestText: null })).rejects.toBeInstanceOf(HotelConfigUnavailableError);
    await expect(repo.saveRoomTypeOverbooking({ ...base, roomTypeId: RT, maxOverbookRooms: 1, thresholdPct: null })).rejects.toBeInstanceOf(HotelConfigUnavailableError);
    await expect(repo.saveRatePrice({ ...base, rateId: "r1", price: 10, minStay: null })).rejects.toBeInstanceOf(HotelConfigUnavailableError);
    await sigueUtil(session);
  });

  it("un rechazo real de la funcion (42501) se repropaga con su mensaje y la sesion sigue utilizable; P0002 -> null", async () => {
    const session = new AbortAwareFakeSession([
      { match: /hoteles\.set_tax_config/i, respond: () => pgError("42501", "configuracion_requiere_owner_gm: solo owner/gm") },
      { match: /hoteles\.set_rate_price/i, respond: () => pgError("P0002", "tarifa_no_encontrada: x") },
      siguiente,
    ]);
    const repo = new PostgresHotelesRepository(session);
    const base = { propertyId: P, organizationId: ORG, actorUserId: ACTOR };
    await expect(repo.saveTaxSettings({ ...base, ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0 })).rejects.toThrow(/^configuracion_requiere_owner_gm/);
    await expect(repo.saveRatePrice({ ...base, rateId: "r1", price: 10, minStay: null })).resolves.toBeNull();
    await sigueUtil(session);
  });
});
