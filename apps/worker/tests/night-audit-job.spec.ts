// Fase 6 hoteles (REQ-REV-013) — integración real (InMemoryHotelesRepository, sin
// HTTP) del PRIMER job real de apps/worker: posteo de hospedaje de reservas en casa,
// reutilización del no-show ya existente (runNoShowSweep, Fase 3), idempotencia por
// (property, business_date), y el barrido de todas las properties activas con reloj
// inyectado (determinista, sin depender de la hora real de la corrida de CI).
//
// Fase 6b (flujos de sistema, migrations/023_night_audit_sistema_escritura.sql): las
// pruebas de `describe("runNightAuditForProperty", ...)` de abajo usan
// `session: "staff"` (mismo comportamiento LITERAL de antes de esta fase, ver
// night-audit.ts) -- el bloque `describe("runNightAuditForProperty -- session:
// \"sistema\"", ...)` al final ejercita el camino nuevo (métodos `systemXxx`) contra
// el MISMO repositorio en memoria, para confirmar que ambos caminos producen el mismo
// resultado observable. `runNightAuditSweep` SIEMPRE corre `session: "sistema"`
// internamente (ver su comentario de cabecera) -- sus pruebas de abajo no cambian.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryHotelesRepository } from "@atiende/domain-hoteles";
import { runNightAuditForProperty, runNightAuditSweep } from "../src/jobs/hoteles/night-audit.ts";

let repo: InMemoryHotelesRepository;
let organizationId: string;
let propertyId: string;
let roomTypeId: string;

beforeEach(() => {
  repo = new InMemoryHotelesRepository();
  organizationId = randomUUID();
  propertyId = randomUUID();
  roomTypeId = randomUUID();
  repo.seedActiveHotelProperty(organizationId, propertyId);
  repo.seedTaxConfig(propertyId, { ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500 });
  repo.seedRoomType(propertyId, roomTypeId);
  repo.seedNightlyRates(propertyId, roomTypeId, [{ date: "2026-09-10", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);
});

async function seedInHouseReservation(checkInDate: string, checkOutDate: string) {
  const reservation = await repo.insertReservation({ organizationId, propertyId, roomTypeId, guestId: null, checkInDate, checkOutDate, totalAmount: 1000 });
  await repo.transitionReservation(propertyId, reservation.id, ["confirmada"], "check_in", null);
  await repo.transitionReservation(propertyId, reservation.id, ["check_in"], "en_estancia", null);
  const folio = await repo.ensurePrimaryFolio(propertyId, organizationId, reservation.id);
  return { reservation, folio };
}

describe("runNightAuditForProperty", () => {
  it("postea el hospedaje de la noche de cada reserva en casa (neto + IVA + ISH)", async () => {
    const { reservation, folio } = await seedInHouseReservation("2026-09-10", "2026-09-12");

    const summary = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10", session: "staff" });

    expect(summary.yaCompletado).toBe(false);
    expect(summary.postedCharges).toHaveLength(1);
    expect(summary.postedCharges[0]).toMatchObject({ reservationId: reservation.id, folioId: folio.id, amount: 1000 });
    expect(summary.ocupacion.enCasa).toBe(1);
    expect(summary.conciliacionAB).toEqual({ estado: "sin_pos_configurado" });
    expect(summary.anomalies).toEqual([]);
  });

  it("una segunda corrida del MISMO (property, business_date) SIEMPRE devuelve el resumen ya guardado, sin volver a postear", async () => {
    await seedInHouseReservation("2026-09-10", "2026-09-12");

    const first = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10", session: "staff" });
    const second = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10", session: "staff" });

    expect(first.postedCharges).toHaveLength(1);
    expect(second.yaCompletado).toBe(true);
    expect(second.postedCharges).toEqual(first.postedCharges);
    // El índice único parcial (charge_folio_stay_date_hospedaje_idx, espejado en
    // memoria) nunca deja un segundo cargo de hospedaje para la misma noche/folio.
    const charges = await repo.listChargesForCfdi((await repo.listFoliosByReservation(propertyId, first.postedCharges[0]!.reservationId))[0]!.id);
    expect(charges.filter((c) => c.concept === "hospedaje" && c.stayDate === "2026-09-10")).toHaveLength(1);
  });

  it("REQ-REV-013: reutiliza el no-show YA existente de Fase 3 -- una reserva confirmada vencida se marca no_show y su penalización se postea", async () => {
    const reservation = await repo.insertReservation({ organizationId, propertyId, roomTypeId, guestId: null, checkInDate: "2026-09-08", checkOutDate: "2026-09-10", totalAmount: 2000 });

    const summary = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10", session: "staff" });

    expect(summary.noShows).toHaveLength(1);
    expect(summary.noShows[0]!.reservationId).toBe(reservation.id);
    // 2000 / 2 noches = 1000 neto de penalización (evaluateNoShowPenaltyBase).
    expect(summary.noShows[0]!.chargeAmount).toBeCloseTo(1000, 2);
    const updated = await repo.findReservation(propertyId, reservation.id);
    expect(updated!.status).toBe("no_show");
  });

  it("verificación de folio-cero: una reserva en casa sin folio primario se reporta como anomalía, nunca se inventa el folio", async () => {
    // Reserva construida directamente vía insertReservation (sin ensurePrimaryFolio)
    // para simular el dato roto -- en producción `ensurePrimaryFolio` siempre corre
    // al confirmar (Fase 3), esto prueba que night-audit no falla en silencio si eso
    // alguna vez no pasó.
    const reservation = await repo.insertReservation({ organizationId, propertyId, roomTypeId, guestId: null, checkInDate: "2026-09-10", checkOutDate: "2026-09-12", totalAmount: 1000 });
    await repo.transitionReservation(propertyId, reservation.id, ["confirmada"], "check_in", null);
    await repo.transitionReservation(propertyId, reservation.id, ["check_in"], "en_estancia", null);

    const summary = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10", session: "staff" });

    expect(summary.postedCharges).toEqual([]);
    expect(summary.anomalies).toHaveLength(1);
    expect(summary.anomalies[0]).toMatchObject({ reservationId: reservation.id, type: "folio_cero" });
  });
});

describe("runNightAuditSweep", () => {
  it("con la hora local ya pasado el umbral, cierra el día anterior de cada property activa", async () => {
    await seedInHouseReservation("2026-09-09", "2026-09-11");
    // 2026-09-10T10:00:00Z == 04:00 hora CDMX (UTC-6) -- ya pasó el umbral de las 03:00.
    const now = () => new Date("2026-09-10T10:00:00Z");

    const results = await runNightAuditSweep(repo, { now });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ organizationId, propertyId, ran: true, businessDate: "2026-09-09" });
    expect(results[0]!.summary?.postedCharges).toHaveLength(0); // la tarifa sembrada es para 2026-09-10, no 2026-09-09 -- sin tarifa, anomalía.
    expect(results[0]!.summary?.anomalies[0]).toMatchObject({ type: "sin_tarifa" });
  });

  it("antes del umbral, omite la property con razón 'fuera_de_horario' sin tocar nada", async () => {
    // 2026-09-10T06:00:00Z == 00:00 hora CDMX -- antes de las 03:00.
    const now = () => new Date("2026-09-10T06:00:00Z");

    const results = await runNightAuditSweep(repo, { now });

    expect(results).toEqual([{ organizationId, propertyId, ran: false, skippedReason: "fuera_de_horario" }]);
  });

  it("un fallo en una property nunca detiene el barrido de las demás", async () => {
    const otherOrgId = randomUUID();
    const otherPropertyId = randomUUID();
    repo.seedActiveHotelProperty(otherOrgId, otherPropertyId);
    // otherPropertyId no tiene tax_config sembrado -- `loadTaxConfig` lanza.
    const now = () => new Date("2026-09-10T10:00:00Z");

    const results = await runNightAuditSweep(repo, { now });

    expect(results).toHaveLength(2);
    const failed = results.find((r) => r.propertyId === otherPropertyId);
    const ok = results.find((r) => r.propertyId === propertyId);
    expect(failed?.ran).toBe(false);
    expect(failed?.error).toBeDefined();
    expect(ok?.ran).toBe(true);
  });
});

// Fase 6b (flujos de sistema, migrations/023_night_audit_sistema_escritura.sql): el
// camino `session: "sistema"` usa los métodos `systemXxx` nuevos -- estas pruebas
// confirman que produce el MISMO resultado observable que `session: "staff"` (arriba)
// para los mismos fixtures, y que las funciones nuevas rechazan invariantes inválidas
// (equivalente en memoria de lo que la función SQL real valida, ver
// scripts/verify-hoteles-night-audit-sistema/ para la verificación contra Postgres
// real).
describe("runNightAuditForProperty -- session: \"sistema\"", () => {
  it("postea el hospedaje de la noche vía los métodos systemXxx (mismo resultado que session: \"staff\")", async () => {
    const { reservation, folio } = await seedInHouseReservation("2026-09-10", "2026-09-12");

    const summary = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10", session: "sistema" });

    expect(summary.postedCharges).toHaveLength(1);
    expect(summary.postedCharges[0]).toMatchObject({ reservationId: reservation.id, folioId: folio.id, amount: 1000 });
    expect(summary.anomalies).toEqual([]);
  });

  it("una segunda corrida del MISMO (property, business_date) bajo sesión de sistema tampoco vuelve a postear", async () => {
    await seedInHouseReservation("2026-09-10", "2026-09-12");

    const first = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10", session: "sistema" });
    const second = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10", session: "sistema" });

    expect(first.postedCharges).toHaveLength(1);
    expect(second.yaCompletado).toBe(true);
  });

  it("REQ-REV-013 bajo sesión de sistema: una reserva confirmada vencida se marca no_show y su penalización se postea vía systemApplyNoShow", async () => {
    const reservation = await repo.insertReservation({ organizationId, propertyId, roomTypeId, guestId: null, checkInDate: "2026-09-08", checkOutDate: "2026-09-10", totalAmount: 2000 });

    const summary = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10", session: "sistema" });

    expect(summary.noShows).toHaveLength(1);
    expect(summary.noShows[0]!.reservationId).toBe(reservation.id);
    expect(summary.noShows[0]!.chargeAmount).toBeCloseTo(1000, 2);
    const updated = await repo.findReservation(propertyId, reservation.id);
    expect(updated!.status).toBe("no_show");
  });

  it("systemPostNightAuditCharge rechaza un folio que no es el primario de la reserva (invariante validada por la función, no solo por el llamador)", async () => {
    const { reservation } = await seedInHouseReservation("2026-09-10", "2026-09-12");
    const otraReserva = await repo.insertReservation({ organizationId, propertyId, roomTypeId, guestId: null, checkInDate: "2026-09-01", checkOutDate: "2026-09-03", totalAmount: 500 });
    const folioAjeno = await repo.ensurePrimaryFolio(propertyId, organizationId, otraReserva.id);

    await expect(
      repo.systemPostNightAuditCharge({
        organizationId,
        propertyId,
        reservationId: reservation.id,
        folioId: folioAjeno.id,
        businessDate: "2026-09-10",
        netAmount: 1000,
        taxAmount: 160,
      }),
    ).rejects.toThrow(/folio_invalido/);
  });

  it("systemApplyNoShow: reintento (mismo llamado 2 veces -- reintento del cron o 2 instancias concurrentes) nunca duplica la penalización", async () => {
    const reservation = await repo.insertReservation({ organizationId, propertyId, roomTypeId, guestId: null, checkInDate: "2026-09-08", checkOutDate: "2026-09-10", totalAmount: 2000 });

    const first = await repo.systemApplyNoShow({ organizationId, propertyId, reservationId: reservation.id, netAmount: 1000, taxAmount: 160 });
    const second = await repo.systemApplyNoShow({ organizationId, propertyId, reservationId: reservation.id, netAmount: 1000, taxAmount: 160 });

    expect(first).not.toBeNull();
    // Segunda llamada pierde la carrera (la reserva ya no está 'confirmada') -- `null`,
    // NUNCA una segunda penalización -- mismo criterio atómico que `transitionReservation`.
    expect(second).toBeNull();
    const charges = await repo.listChargesForCfdi(first!.folioId);
    expect(charges.filter((c) => c.concept === "hospedaje" && c.stayDate === null)).toHaveLength(1);
  });

  it("systemApplyNoShow rechaza una reserva de otra organización/property (cross-tenant)", async () => {
    const otherOrgId = randomUUID();
    const otherPropertyId = randomUUID();
    const reservation = await repo.insertReservation({ organizationId, propertyId, roomTypeId, guestId: null, checkInDate: "2026-09-08", checkOutDate: "2026-09-10", totalAmount: 2000 });

    const applied = await repo.systemApplyNoShow({
      organizationId: otherOrgId,
      propertyId: otherPropertyId,
      reservationId: reservation.id,
      netAmount: 1000,
      taxAmount: 160,
    });

    expect(applied).toBeNull();
    const untouched = await repo.findReservation(propertyId, reservation.id);
    expect(untouched!.status).toBe("confirmada");
  });
});
