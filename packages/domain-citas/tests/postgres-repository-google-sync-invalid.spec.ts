// Hallazgo CRÍTICO de auditoría (a1, r3, verificado contra `main` en b4e5a83) —
// regresión para `PostgresCitasRepository.markAppointmentGoogleSyncInvalid`. Ver el
// comentario de cabecera del método en `../src/postgres-repository.ts` para el
// mecanismo completo: el CHECK vigente en la base real (`migrations/005_google_
// calendar_sync.sql`) no incluye `'invalid'` (solo lo agrega la migración 019, sin
// aplicar en la base real hasta que alguien la corra a mano) -- un UPDATE directo con
// `google_sync_status = 'invalid'` lanza 23514, y SIN SAVEPOINT eso deja la
// transacción del request/batch ABORTADA -- pérdida silenciosa de la cita (ver
// diseño completo en el comentario del método).
//
// Mismo doble de prueba (`AbortAwareFakeSession`, `./support/aborting-fake-
// session.ts`) y mismo criterio de "prueba de control" que `upsert-customer-
// savepoint.spec.ts`: un test ejercita el método REAL (ya con el fix), otro replica
// la MISMA secuencia de consultas SIN pasar por el SAVEPOINT del método, para
// demostrar que el bug que motiva el fix era real (25P02 sin protección).
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const APPOINTMENT_ID = "00000000-0000-0000-0000-0000000000cc";

function checkViolation(): Error & { code: string } {
  const err = new Error(
    'new row for relation "appointments" violates check constraint "appointments_google_sync_status_check"',
  ) as Error & { code: string };
  err.code = "23514";
  return err;
}

describe("PostgresCitasRepository.markAppointmentGoogleSyncInvalid — SAVEPOINT contra el CHECK viejo (23514)", () => {
  it("base SIN la migración 019 (CHECK viejo, sin 'invalid'): degrada a google_sync_status='error' conservando el motivo, SIN dejar la transacción abortada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /set google_sync_status = 'invalid'/, respond: () => checkViolation() },
      { match: /set google_sync_status = 'error'/, respond: () => [] },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    await repo.markAppointmentGoogleSyncInvalid(APPOINTMENT_ID, 1, "Cal.com rechazó el booking: falta attendeeEmail");

    // El camino de respaldo SÍ corrió (degradado a 'error', mismo SQL que
    // markAppointmentGoogleSyncExhausted).
    expect(session.calls.some((c) => c.includes("set google_sync_status = 'error'"))).toBe(true);
    // Y la sesión quedó recuperada -- SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE
    // corrieron en el orden correcto (si no, la consulta de respaldo habría
    // lanzado 25P02 en vez de completar).
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);

    // La sesión sigue utilizable para el resto del request/batch -- una consulta
    // normal posterior no debe fallar con 25P02.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("base YA con la migración 019 (CHECK nuevo, con 'invalid'): camino directo, nunca corre el fallback", async () => {
    const session = new AbortAwareFakeSession([{ match: /set google_sync_status = 'invalid'/, respond: () => [] }]);
    const repo = new PostgresCitasRepository(session);

    await repo.markAppointmentGoogleSyncInvalid(APPOINTMENT_ID, 1, "motivo");

    expect(session.calls.some((c) => c.includes("set google_sync_status = 'error'"))).toBe(false);
  });

  it("cualquier OTRO código de error (no 23514) se repropaga tal cual -- el fallback nunca enmascara un fallo real", async () => {
    const connectionError = new Error("connection terminated unexpectedly") as Error & { code: string };
    connectionError.code = "57P01";
    const session = new AbortAwareFakeSession([{ match: /set google_sync_status = 'invalid'/, respond: () => connectionError }]);
    const repo = new PostgresCitasRepository(session);

    await expect(repo.markAppointmentGoogleSyncInvalid(APPOINTMENT_ID, 1, "motivo")).rejects.toMatchObject({ code: "57P01" });
  });

  it("prueba de que el bug era real: la MISMA secuencia SIN SAVEPOINT (catch simple) deja la transacción abortada — la consulta siguiente del mismo request/batch falla con 25P02", async () => {
    const session = new AbortAwareFakeSession([{ match: /set google_sync_status = 'invalid'/, respond: () => checkViolation() }]);

    await expect(
      (async () => {
        try {
          // Exactamente lo que hacía el código ANTES de este fix: UPDATE directo,
          // sin SAVEPOINT.
          await session.query(`update citas.appointments set google_sync_status = 'invalid' where id = $1;`, [APPOINTMENT_ID]);
        } catch {
          // catch simple -- no recupera la sesión.
        }
        // Siguiente escritura del MISMO request (ej. encolar el correo, marcar
        // rate-limit, o el COMMIT final que Postgres trataría como ROLLBACK).
        return session.query(`update citas.appointments set google_sync_attempts = google_sync_attempts + 1 where id = $1;`, [APPOINTMENT_ID]);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});

describe("PostgresCitasRepository.runWithRowSavepoint — aísla una fila del lote de reconciliación", () => {
  it("fn falla: ROLLBACK TO SAVEPOINT deja la sesión utilizable para la siguiente fila, y el error se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([{ match: /select 1/, respond: () => [] }]);
    const repo = new PostgresCitasRepository(session);
    const rowError = new Error("createEvent falló y la escritura de resultado también");

    await expect(repo.runWithRowSavepoint(() => Promise.reject(rowError))).rejects.toBe(rowError);

    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    // La sesión NO quedó abortada -- la siguiente fila del batch puede seguir.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("fn tiene éxito: RELEASE SAVEPOINT, devuelve el resultado tal cual", async () => {
    const session = new AbortAwareFakeSession([]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.runWithRowSavepoint(async () => "fila sincronizada");

    expect(result).toBe("fila sincronizada");
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
  });
});
