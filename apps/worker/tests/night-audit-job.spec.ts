// Fase 6 hoteles (REQ-REV-013) — integración real (InMemoryHotelesRepository, sin
// HTTP) del PRIMER job real de apps/worker: posteo de hospedaje de reservas en casa,
// reutilización del no-show ya existente (runNoShowSweep, Fase 3), idempotencia por
// (property, business_date), y el barrido de todas las properties activas con reloj
// inyectado (determinista, sin depender de la hora real de la corrida de CI).
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

    const summary = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10" });

    expect(summary.yaCompletado).toBe(false);
    expect(summary.postedCharges).toHaveLength(1);
    expect(summary.postedCharges[0]).toMatchObject({ reservationId: reservation.id, folioId: folio.id, amount: 1000 });
    expect(summary.ocupacion.enCasa).toBe(1);
    expect(summary.conciliacionAB).toEqual({ estado: "sin_pos_configurado" });
    expect(summary.anomalies).toEqual([]);
  });

  it("una segunda corrida del MISMO (property, business_date) SIEMPRE devuelve el resumen ya guardado, sin volver a postear", async () => {
    await seedInHouseReservation("2026-09-10", "2026-09-12");

    const first = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10" });
    const second = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10" });

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

    const summary = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10" });

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

    const summary = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate: "2026-09-10" });

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
