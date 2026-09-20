// BLOQUEANTE de la re-revisión del PR #158 (r3, ronda 3 de auditoría) — regresión
// 409 -> 500 REAL en un caller ACTUAL (no "futuro"): `POST /v1/citas/:orgSlug/
// appointments/:appointmentId/reschedule` (`apps/api/.../appointments-lifecycle.ts`)
// en una carrera real de horario. `citas.reschedule_appointment_idempotent` lanza
// AT423 (`RAISE` dentro de una función SQL); sin SAVEPOINT alrededor del RPC, el
// `catch` mapeaba ese error a un resultado discriminado NORMAL (`conflict_slot_
// taken`) sin darse cuenta de que Postgres seguía viendo la transacción ABORTADA —
// `computeAlternativeSlots` (appointments.ts) corría sus consultas sobre esa sesión
// abortada, su catch-all tragaba el 25P02 y devolvía `[]`, y el `COMMIT` final de
// `withAppSession` (con la defensa del motor de este mismo PR) lanzaba
// `AbortedTransactionCommitError` -> 500, en vez del 409 con alternativas reales que
// el cliente debía recibir.
//
// Este archivo cubre los métodos de `postgres-repository.ts` que comparten el MISMO
// defecto (un catch por código AT4xx/AT403 sin `runWithRowSavepoint` alrededor del
// RPC): `createAppointmentIdempotent`, `runCancelRpc` (cancelar por agente/panel),
// confirm/complete/no-show desde panel, `createAppointmentFromPanel`,
// `rescheduleAppointmentIdempotent`, `reassignAppointmentIdempotent` y
// `retryAppointmentCalendarSyncFromPanel`. Cada caso demuestra: (1) el resultado
// discriminado que el caller espera se sigue devolviendo igual, (2) la sesión queda
// utilizable DESPUÉS (una consulta posterior no lanza 25P02), lo que en producción
// es exactamente lo que evita `AbortedTransactionCommitError` en el `COMMIT` real.
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-0000-0000-0000000000o1";
const APPOINTMENT_ID = "00000000-0000-0000-0000-0000000000a1";
const ACTOR_ID = "00000000-0000-0000-0000-0000000000u1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Toda aserción de "sesión utilizable DESPUÉS" comparte el mismo criterio que ya
 * usan `upsert-customer-savepoint.spec.ts`/`postgres-repository-resolve-*-
 * savepoint.spec.ts`: un `SAVEPOINT` se abrió, un `ROLLBACK TO SAVEPOINT` lo
 * recuperó, y una consulta normal posterior sobre la MISMA sesión no lanza 25P02. */
async function expectSessionRecovered(session: AbortAwareFakeSession): Promise<void> {
  expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
}

describe("PostgresCitasRepository — SAVEPOINT alrededor de los RPC de ciclo de vida (bloqueante r3)", () => {
  it("createAppointmentIdempotent: AT423 -> conflict_slot_taken, sesión utilizable después", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.create_appointment_idempotent/, respond: () => pgError("AT423", "slot taken") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.createAppointmentIdempotent(
      { organizationId: ORG_ID, propertyId: null, providerId: "p1", serviceId: "s1", customerId: "c1", startsAt: "2026-01-01T10:00:00.000Z", endsAt: "2026-01-01T10:30:00.000Z", status: "pending", source: "whatsapp", notes: null },
      "fp1",
      null,
    );

    expect(result).toEqual({ outcome: "conflict_slot_taken" });
    await expectSessionRecovered(session);
  });

  it("cancelAppointmentIdempotent (runCancelRpc): AT409 -> conflict_invalid_status, sesión utilizable después", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.cancel_appointment_idempotent/, respond: () => pgError("AT409", "already completed") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.cancelAppointmentIdempotent(ORG_ID, APPOINTMENT_ID);

    expect(result).toEqual({ outcome: "conflict_invalid_status", status: "completed" });
    await expectSessionRecovered(session);
  });

  it("cancelAppointmentFromPanel (runCancelRpc): AT403 -> forbidden_out_of_scope, sesión utilizable después", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.cancel_appointment_from_panel/, respond: () => pgError("AT403", "staff fuera de sucursal") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.cancelAppointmentFromPanel(ORG_ID, APPOINTMENT_ID, ACTOR_ID);

    expect(result).toEqual({ outcome: "forbidden_out_of_scope", message: "staff fuera de sucursal" });
    await expectSessionRecovered(session);
  });

  it("confirmAppointmentFromPanel: AT409 -> conflict_invalid_status, sesión utilizable después", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.confirm_appointment_from_panel/, respond: () => pgError("AT409", "already completed") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.confirmAppointmentFromPanel(ORG_ID, APPOINTMENT_ID, ACTOR_ID);

    expect(result).toEqual({ outcome: "conflict_invalid_status", status: "completed" });
    await expectSessionRecovered(session);
  });

  it("completeAppointmentFromPanel: AT404 -> not_found, sesión utilizable después", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.complete_appointment_from_panel/, respond: () => pgError("AT404", "not found") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.completeAppointmentFromPanel(ORG_ID, APPOINTMENT_ID, ACTOR_ID);

    expect(result).toEqual({ outcome: "not_found" });
    await expectSessionRecovered(session);
  });

  it("markAppointmentNoShowFromPanel: AT403 -> forbidden_out_of_scope, sesión utilizable después", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.mark_appointment_no_show_from_panel/, respond: () => pgError("AT403", "staff fuera de sucursal") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.markAppointmentNoShowFromPanel(ORG_ID, APPOINTMENT_ID, ACTOR_ID);

    expect(result).toEqual({ outcome: "forbidden_out_of_scope", message: "staff fuera de sucursal" });
    await expectSessionRecovered(session);
  });

  it("createAppointmentFromPanel: AT423 -> conflict_slot_taken, sesión utilizable después", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.create_appointment_from_panel/, respond: () => pgError("AT423", "slot taken") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.createAppointmentFromPanel({
      organizationId: ORG_ID,
      propertyId: null,
      providerId: "p1",
      serviceId: "s1",
      customerName: "Ana",
      customerPhone: "+525500000000",
      customerEmail: null,
      startsAt: "2026-01-01T10:00:00.000Z",
      endsAt: "2026-01-01T10:30:00.000Z",
      notes: null,
    });

    expect(result).toEqual({ outcome: "conflict_slot_taken" });
    await expectSessionRecovered(session);
  });

  it("rescheduleAppointmentIdempotent: AT423 -> conflict_slot_taken, sesión utilizable después (regresión 409->500 real, appointments-lifecycle.ts)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.reschedule_appointment_idempotent/, respond: () => pgError("AT423", "slot taken") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.rescheduleAppointmentIdempotent(ORG_ID, APPOINTMENT_ID, "2026-01-01T10:00:00.000Z", "2026-01-01T10:30:00.000Z", "whatsapp", null);

    expect(result).toEqual({ outcome: "conflict_slot_taken" });
    await expectSessionRecovered(session);
  });

  it("reassignAppointmentIdempotent: AT404 -> not_found, sesión utilizable después", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.reassign_appointment_idempotent/, respond: () => pgError("AT404", "not found") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.reassignAppointmentIdempotent(ORG_ID, APPOINTMENT_ID, "p2", "s2", "2026-01-01T11:00:00.000Z", "manual", null);

    expect(result).toEqual({ outcome: "not_found" });
    await expectSessionRecovered(session);
  });

  it("retryAppointmentCalendarSyncFromPanel: AT403 -> forbidden_out_of_scope, sesión utilizable después", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.retry_appointment_calendar_sync_from_panel/, respond: () => pgError("AT403", "staff fuera de sucursal") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.retryAppointmentCalendarSyncFromPanel(ORG_ID, APPOINTMENT_ID, ACTOR_ID);

    expect(result).toEqual({ outcome: "forbidden_out_of_scope", message: "staff fuera de sucursal" });
    await expectSessionRecovered(session);
  });

  it("un error NO reconocido (ej. fallo de conexión) se repropaga tal cual, DESPUÉS de recuperar la sesión -- nunca enmascara un fallo real", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.reschedule_appointment_idempotent/, respond: () => pgError("ECONNRESET", "connection reset") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    await expect(repo.rescheduleAppointmentIdempotent(ORG_ID, APPOINTMENT_ID, "2026-01-01T10:00:00.000Z", "2026-01-01T10:30:00.000Z", "whatsapp", null)).rejects.toMatchObject({ code: "ECONNRESET" });
    // Aunque el error no es reconocido y se repropaga, la recuperación del SAVEPOINT
    // ya corrió ANTES de repropagar (ver runWithSavepointFallback) -- la sesión
    // sigue utilizable para el resto del request/loop que la reutilice.
    await expectSessionRecovered(session);
  });
});
