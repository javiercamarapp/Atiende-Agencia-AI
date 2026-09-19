// Prueba de regresión END-TO-END del hallazgo de la re-revisión del PR #158 (r3):
// `POST /v1/citas/:orgSlug/appointments/:appointmentId/reschedule`
// (apps/api/.../appointments-lifecycle.ts) pasaba de 409 a 500 en una carrera REAL
// de horario. Ejercita `rescheduleAppointment` (appointments.ts, lógica de negocio
// real) sobre `PostgresCitasRepository` + `AbortAwareFakeSession` (nunca el
// repositorio en memoria, que no reproduce la semántica de transacción abortada de
// Postgres) para demostrar el camino completo:
//
//   citas.reschedule_appointment_idempotent lanza AT423 (carrera real de horario)
//     -> SIN el SAVEPOINT de esta ronda: la sesión queda ABORTADA aunque el catch
//        de `rescheduleAppointmentIdempotent` mapee el error a un resultado
//        discriminado normal -- `computeAlternativeSlots` (appointments.ts) corre
//        sus 3 consultas sobre esa sesión abortada, su catch-all traga el 25P02 de
//        CADA una y devuelve `[]`; `mapErrorToHttp` responde 409 con
//        `alternative_slots: []` igual, pero el `COMMIT` final de `withAppSession`
//        (con la defensa del motor de este PR) lanza `AbortedTransactionCommitError`
//        -- 500 real a un caller ACTUAL.
//     -> CON el SAVEPOINT (`runWithRowSavepoint` alrededor del RPC, este fix):
//        `ROLLBACK TO SAVEPOINT` recupera la sesión ANTES de que el catch mapee
//        AT423, así que `computeAlternativeSlots` corre sobre una sesión SANA y
//        devuelve alternativas REALES -- el `COMMIT` final sí tiene éxito, 409 con
//        alternativas nunca 500.
//
// Este archivo prueba el ANTES (control, sin SAVEPOINT -- reproduce el bug real con
// el mismo helper genérico sin protección) y el DESPUÉS (con el fix, vía
// `PostgresCitasRepository` real) para que quede explícito qué cambió.
import { describe, expect, it } from "vitest";
import { rescheduleAppointment } from "../src/appointments.ts";
import { AppointmentAlternativesError } from "../src/errors.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

// Duplica localmente la forma de fila que `postgres-repository.ts::AppointmentRow`
// espera (esa interfaz es privada del módulo, sin exportar) -- solo para tipar los
// datos de este test, nunca importada de producción.
interface AppointmentRow {
  readonly id: string;
  readonly organization_id: string;
  readonly property_id: string | null;
  readonly provider_id: string;
  readonly service_id: string;
  readonly customer_id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly status: "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
  readonly source: "web" | "whatsapp" | "voice" | "manual";
  readonly notes: string | null;
  readonly dedupe_fingerprint: string | null;
  readonly idempotency_key: string | null;
  readonly reminder_24h_sent_at: string | null;
  readonly created_at: string;
  readonly google_event_id: string | null;
  readonly google_sync_status: "pending" | "synced" | "error" | "skipped" | "pending_cancel" | "deleted" | "invalid";
  readonly google_sync_attempts: number;
  readonly google_sync_next_retry_at: string | null;
  readonly google_sync_error: string | null;
}

const ORG_ID = "00000000-0000-0000-0000-0000000000o1";
const PROVIDER_ID = "00000000-0000-0000-0000-0000000000p1";
const SERVICE_ID = "00000000-0000-0000-0000-0000000000s1";
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000000c1";
const APPOINTMENT_ID = "00000000-0000-0000-0000-0000000000a1";

// Mismo día/timezone que ya usa appointments.spec.ts (lunes, un año hacia el futuro
// a propósito -- ver el comentario de ese archivo sobre date-rot).
const OLD_STARTS_AT = zonedTimeToUtc("2027-09-13", "10:00", "America/Merida").toISOString();
const OLD_ENDS_AT = zonedTimeToUtc("2027-09-13", "10:30", "America/Merida").toISOString();
const NEW_STARTS_AT = zonedTimeToUtc("2027-09-13", "11:00", "America/Merida").toISOString();

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function appointmentRow(): AppointmentRow {
  return {
    id: APPOINTMENT_ID,
    organization_id: ORG_ID,
    property_id: null,
    provider_id: PROVIDER_ID,
    service_id: SERVICE_ID,
    customer_id: CUSTOMER_ID,
    starts_at: OLD_STARTS_AT,
    ends_at: OLD_ENDS_AT,
    status: "pending",
    source: "web",
    notes: null,
    dedupe_fingerprint: null,
    idempotency_key: null,
    reminder_24h_sent_at: null,
    created_at: OLD_STARTS_AT,
    google_event_id: null,
    google_sync_status: "skipped",
    google_sync_attempts: 0,
    google_sync_next_retry_at: null,
    google_sync_error: null,
  };
}

/** Handlers compartidos por las consultas de solo-lectura que `prepareRescheduleAppointment`
 * y `computeAlternativeSlots` ejecutan (se llaman DOS veces cada una -- una por
 * cada fase -- el mismo handler simplemente responde igual las dos veces). El único
 * handler que varía entre el caso "antes"/"después" es el del RPC en sí. */
function readOnlyHandlers(): FakeSessionHandler[] {
  return [
    { match: /from citas\.appointments where id = \$1 and organization_id = \$2/, respond: () => [appointmentRow()] },
    { match: /from citas\.providers where id = \$1 and organization_id = \$2/, respond: () => [{ id: PROVIDER_ID, organization_id: ORG_ID, property_id: null, display_name: "Dra. Ríos", role_label: "Dentista", is_active: true }] },
    { match: /from citas\.services where id = \$1 and organization_id = \$2/, respond: () => [{ id: SERVICE_ID, organization_id: ORG_ID, name: "Limpieza", duration_minutes: 30, buffer_minutes_before: 0, buffer_minutes_after: 0, price_cents: null, is_active: true }] },
    { match: /from citas\.provider_services/, respond: () => [{ count: "1" }] },
    { match: /from citas\.tenant_config/, respond: () => [{ default_timezone: "America/Merida" }] },
    { match: /from citas\.availability_rules/, respond: () => [{ id: "r1", provider_id: PROVIDER_ID, day_of_week: 1, start_time: "09:00", end_time: "17:00", is_active: true }] },
    { match: /from citas\.availability_overrides/, respond: () => [] },
    // loadBusyIntervals -- distinto WHERE (`provider_id = $1`, no `id = $1`) del
    // findAppointmentForOrganization de arriba. Sin otras citas ocupando el día:
    // computeAvailableSlots debe poder ofrecer slots reales.
    { match: /from citas\.appointments\s+where provider_id = \$1/, respond: () => [] },
    // Sonda de "sesión utilizable DESPUÉS" que ambos tests corren directo contra
    // `session` (no contra el repo) -- ver el criterio ya establecido en
    // `postgres-repository-resolve-calcom-caldav-savepoint.spec.ts`.
    { match: /select 1/, respond: () => [] },
  ];
}

describe("rescheduleAppointment sobre PostgresCitasRepository real — regresión r3 (AT423 en carrera de horario)", () => {
  it("ANTES del fix (control): sin SAVEPOINT alrededor del RPC, la sesión queda abortada y las alternativas salen VACÍAS -- reproduce el bug real que causaba el 500", async () => {
    // Doble deliberadamente SIN SAVEPOINT -- reproduce el defecto que este PR
    // corrige, para dejar constancia de que el bug era real (mismo criterio que
    // `postgres-repository-google-sync-invalid.spec.ts`/`upsert-customer-savepoint
    // .spec.ts` con su prueba "de control").
    const session = new AbortAwareFakeSession([...readOnlyHandlers(), { match: /citas\.reschedule_appointment_idempotent/, respond: () => pgError("AT423", "slot taken") }]);
    // Repositorio de control: reschedule SIN pasar por `runWithRowSavepoint` (simula
    // el código pre-fix llamando la consulta directo, sin el SAVEPOINT que este PR
    // agrega).
    const controlRepo = new PostgresCitasRepository(session);
    (controlRepo as unknown as { rescheduleAppointmentIdempotent: PostgresCitasRepository["rescheduleAppointmentIdempotent"] }).rescheduleAppointmentIdempotent = async (organizationId, appointmentId, newStartsAt, newEndsAt, actorChannel, actorNote) => {
      try {
        const { rows } = await session.query<{ reschedule_appointment_idempotent: unknown }>(`select citas.reschedule_appointment_idempotent($1, $2, $3, $4, $5, $6) as reschedule_appointment_idempotent;`, [
          organizationId,
          appointmentId,
          newStartsAt,
          newEndsAt,
          actorChannel,
          actorNote,
        ]);
        return { outcome: "rescheduled", appointment: rows[0] as never };
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
        if (code === "AT423") return { outcome: "conflict_slot_taken" };
        throw err;
      }
    };

    const caught = await rescheduleAppointment(controlRepo, { organizationId: ORG_ID, appointmentId: APPOINTMENT_ID, newStartsAt: NEW_STARTS_AT }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(AppointmentAlternativesError);
    // Sin SAVEPOINT: la sesión sigue abortada, `computeAlternativeSlots` traga el
    // 25P02 de sus 3 consultas y devuelve `[]` -- exactamente el síntoma que la
    // re-revisión encontró (409 con alternativas vacías, y el COMMIT final habría
    // lanzado AbortedTransactionCommitError -> 500).
    expect((caught as AppointmentAlternativesError).alternativeSlots).toEqual([]);
    // Y la sesión queda inutilizable para cualquier consulta posterior -- la
    // condición exacta que dispara `AbortedTransactionCommitError` en el `COMMIT`
    // real de `withAppSession`.
    await expect(session.query("select 1;")).rejects.toMatchObject({ code: "25P02" });
  });

  it("DESPUÉS del fix: PostgresCitasRepository real con runWithRowSavepoint -- alternativas REALES, sesión utilizable, nunca 25P02", async () => {
    const session = new AbortAwareFakeSession([...readOnlyHandlers(), { match: /citas\.reschedule_appointment_idempotent/, respond: () => pgError("AT423", "slot taken") }]);
    const repo = new PostgresCitasRepository(session);

    const caught = await rescheduleAppointment(repo, { organizationId: ORG_ID, appointmentId: APPOINTMENT_ID, newStartsAt: NEW_STARTS_AT }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(AppointmentAlternativesError);
    const alternatives = (caught as AppointmentAlternativesError).alternativeSlots;
    // El resultado que de verdad importa: alternativas REALES (no `[]`), calculadas
    // por `computeAvailableSlots` sobre datos reales (regla 09:00-17:00, sin otras
    // citas ocupando el día) -- solo posible si la sesión ya está recuperada cuando
    // `computeAlternativeSlots` corre sus consultas.
    expect(alternatives.length).toBeGreaterThan(0);
    // Sesión utilizable DESPUÉS -- la condición exacta que evita
    // `AbortedTransactionCommitError` en el `COMMIT` real de `withAppSession`.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
