// C-17 -- hallazgo de la prueba real de concurrencia (scripts/verify-citas-concurrencia): cuando dos reservas del mismo proveedor y horario
// se disparan a la vez (por ejemplo "reagendar" y "crear"), Postgres puede resolver la carrera abortando a una con 40P01 (deadlock_detected)
// en vez de 23P01/AT423. Antes ese 40P01 salia como error generico (500); ahora es el mismo "horario ya no disponible" (conflict_slot_taken)
// en las 4 rutas que reservan, y la MISMA sesion queda utilizable (SAVEPOINT) -- una sesion abortada rompe el COMMIT del request.
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository, esConflictoDeHorario } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const CITA = "00000000-0000-4000-8000-0000000000c1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente/i, respond: () => [{ ok: 1 }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const DEADLOCK = () => pgError("40P01", "deadlock detected");

async function sesionSigueViva(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("esConflictoDeHorario", () => {
  it("AT423 y 40P01 son conflicto de horario; cualquier otro codigo no", () => {
    expect(esConflictoDeHorario("AT423")).toBe(true);
    expect(esConflictoDeHorario("40P01")).toBe(true);
    for (const otro of ["AT409", "AT404", "23505", "25P02", "57014", undefined, null]) expect(esConflictoDeHorario(otro), String(otro)).toBe(false);
  });
});

describe("40P01 (deadlock) al reservar = horario ya no disponible, sin romper la sesion", () => {
  it("createAppointmentIdempotent", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.create_appointment_idempotent/i, respond: DEADLOCK }, SIGUIENTE]);
    const r = await new PostgresCitasRepository(session).createAppointmentIdempotent(
      { organizationId: ORG, propertyId: null, providerId: "p", serviceId: "s", customerId: "c", startsAt: "2031-01-01T10:00:00Z", endsAt: "2031-01-01T10:30:00Z", status: "pending", source: "whatsapp", notes: null },
      "fp",
      null,
    );
    expect(r).toEqual({ outcome: "conflict_slot_taken" });
    await sesionSigueViva(session);
  });

  it("createAppointmentFromPanel", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.create_appointment_from_panel/i, respond: DEADLOCK }, SIGUIENTE]);
    const r = await new PostgresCitasRepository(session).createAppointmentFromPanel({
      organizationId: ORG, propertyId: null, providerId: "p", serviceId: "s", customerName: "N", customerPhone: "+520000000000", customerEmail: null, startsAt: "2031-01-01T10:00:00Z", endsAt: "2031-01-01T10:30:00Z", notes: null,
    });
    expect(r).toEqual({ outcome: "conflict_slot_taken" });
    await sesionSigueViva(session);
  });

  it("rescheduleAppointmentIdempotent", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.reschedule_appointment_idempotent/i, respond: DEADLOCK }, SIGUIENTE]);
    const r = await new PostgresCitasRepository(session).rescheduleAppointmentIdempotent(ORG, CITA, "2031-01-01T10:00:00Z", "2031-01-01T10:30:00Z", "manual", null);
    expect(r).toEqual({ outcome: "conflict_slot_taken" });
    await sesionSigueViva(session);
  });

  it("reassignAppointmentIdempotent", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.reassign_appointment_idempotent/i, respond: DEADLOCK }, SIGUIENTE]);
    const r = await new PostgresCitasRepository(session).reassignAppointmentIdempotent(ORG, CITA, "p2", "s2", "2031-01-01T10:30:00Z", "manual", null);
    expect(r).toEqual({ outcome: "conflict_slot_taken" });
    await sesionSigueViva(session);
  });

  it("un error inesperado distinto (timeout) NO se confunde con un conflicto: se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.reschedule_appointment_idempotent/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresCitasRepository(session).rescheduleAppointmentIdempotent(ORG, CITA, "2031-01-01T10:00:00Z", "2031-01-01T10:30:00Z", "manual", null)).rejects.toThrow(/timeout/);
  });
});
