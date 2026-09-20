// Fix hallazgo CONFIRMADO de la auditoría a3 (ALTA,
// `auditoria-a3-resultado.json::confirmed[0]`): cancelar una cita desde el panel
// de STAFF (POST /v1/citas/properties/:propertyId/appointments/:appointmentId/cancel,
// sesión de staff -- `dbSession`/`c.get("db")`) responde 500 y REVIERTE la
// cancelación cuando hay un candidato activo en la lista de espera que coincide
// con el hueco liberado y `whatsapp_config` está activo, porque
// `citas.claim_waitlist_notification_slot` SIEMPRE rechaza con 42501 en sesión de
// staff ("solo para la sesión de sistema") y ese error se tragaba SIN SAVEPOINT --
// dejaba la transacción de negocio abortada (25P02), y el `commit;` de
// `managed-postgres-engine.ts` sobre una transacción abortada revertía la propia
// cancelación en silencio.
//
// `InMemoryCitasRepository` (la que usa el resto de tests de esta ruta, ver
// `citas-appointments.spec.ts`) NUNCA reproduce este bug -- no tiene transacción
// real que "abortar". Por eso este test, igual que
// `citas-email-dispatch-savepoint.spec.ts` (mismo directorio, mismo criterio),
// sustituye `deps.citasRepo` por un `PostgresCitasRepository` real sobre un doble
// LOCAL de `TenantDbSession` que sí reproduce la semántica de una transacción
// Postgres abortada (mismo patrón que el helper compartido
// `packages/db/tests/support/aborting-fake-session.ts`, duplicado a propósito --
// ver el comentario de cabecera de ese archivo sobre por qué cada paquete es
// dueño de sus propios dobles de prueba) -- ejercitando la RUTA HTTP completa
// (auth real, `requirePropertyMembership` real contra el motor en memoria,
// `dbSession`/`postCommitTasks` reales).
//
// NOTA sobre el alcance de este doble: `deps.engine` sigue siendo el
// `InMemoryTenancyEngine` real de `buildCitasTestContext` (necesario para que
// `authMiddleware`/`dbSession`/`requirePropertyMembership` funcionen contra
// `core.membership`/`core.property` reales) -- SOLO `deps.citasRepo` se
// sustituye por el repositorio Postgres real sobre la sesión abortable. Por
// eso este test verifica la persistencia real de la transacción de negocio
// directamente sobre `session` (el `TenantDbSession` que SÍ comparten todas
// las llamadas de `citasRepo`, exactamente como en producción
// `deps.citasRepo(c.get("db"))` usa la MISMA sesión que el resto del
// request) en vez de sobre `res.status`, que en este arnés no reproduce el
// `AbortedTransactionCommitError` real de `managed-postgres-engine.ts` (eso
// ya se demuestra contra Postgres REAL, sin dobles, en
// `scripts/verify-citas-cancelar-con-lista-de-espera/`).
//
// Este test FALLABA contra el código de `appointments-lifecycle.ts` anterior a
// este fix: sin el SAVEPOINT en `tryNotifyWaitlistOfFreedSlot` (`reminders.ts`),
// la sesión que usa `citasRepo` quedaba abortada para siempre (una consulta
// real posterior, `session.query("select 1;")`, seguía lanzando 25P02) -- en
// producción eso es exactamente lo que hace que el `commit;` final devuelva
// "ROLLBACK" en silencio y la cancelación se pierda.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresCitasRepository } from "@atiende/domain-citas";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { authedJson } from "./hoteles-fixtures.ts";

const ORG_ID = "00000000-0000-0000-0000-0000000000f1";
const PROVIDER_ID = "00000000-0000-0000-0000-0000000000f2";
const SERVICE_ID = "00000000-0000-0000-0000-0000000000f3";
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000000f4";
const APPOINTMENT_ID = "00000000-0000-0000-0000-0000000000f5";
const WAITLIST_ID = "00000000-0000-0000-0000-0000000000f6";

interface FakeHandler {
  readonly match: RegExp;
  readonly respond: () => unknown;
}

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("claim_waitlist_notification_slot es solo para la sesión de sistema") as Error & { code: string };
  err.code = "42501";
  return err;
}

/** Doble LOCAL de `TenantDbSession` -- mismo criterio EXACTO que
 * `AbortAwareFakeSession` de `packages/db/tests/support/aborting-fake-session.ts`
 * y de `packages/domain-citas/tests/support/aborting-fake-session.ts` (duplicado
 * a propósito en cada paquete, ver sus comentarios de cabecera): una consulta
 * cuyo handler devuelve un `Error` dentro dispatch dentro de una transacción deja
 * la sesión "abortada" -- toda consulta/`exec` posterior lanza 25P02 hasta un
 * `ROLLBACK TO SAVEPOINT` real. */
class RouteAbortAwareFakeSession implements TenantDbSession {
  private aborted = false;
  readonly calls: string[] = [];
  constructor(private readonly handlers: readonly FakeHandler[]) {}

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    this.calls.push(sql.trim().split("\n")[0]!.toLowerCase());
    if (this.aborted) throw this.transactionAborted();
    return { rows: (this.dispatch(sql) as T[]) ?? [] };
  }

  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    this.calls.push(n);
    if (n.startsWith("rollback to savepoint")) {
      this.aborted = false;
      return;
    }
    if (n === "rollback" || n === "rollback;") {
      this.aborted = false;
      return;
    }
    if (this.aborted) throw this.transactionAborted();
    if (n.startsWith("savepoint") || n.startsWith("release savepoint")) return;
    this.dispatch(sql);
  }

  private transactionAborted(): Error & { code: string } {
    const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
    err.code = "25P02";
    return err;
  }

  private dispatch(sql: string): unknown[] | undefined {
    for (const h of this.handlers) {
      if (h.match.test(sql)) {
        const result = h.respond();
        if (result instanceof Error) {
          this.aborted = true;
          throw result;
        }
        return result as unknown[] | undefined;
      }
    }
    // catch-all -- cualquier consulta no anticipada (ej. loadAppointmentSyncRow de
    // tryTriggerCalendarSync) se comporta como "0 filas", nunca un error de test
    // opaco -- mismo criterio permisivo que el resto de la ruta real tolera para
    // sus muchas consultas de solo lectura best-effort.
    return [];
  }
}

function cancelledAppointmentRow() {
  return {
    id: APPOINTMENT_ID,
    organization_id: ORG_ID,
    property_id: null,
    provider_id: PROVIDER_ID,
    service_id: SERVICE_ID,
    customer_id: CUSTOMER_ID,
    starts_at: "2027-09-13T16:00:00.000Z",
    ends_at: "2027-09-13T16:30:00.000Z",
    status: "cancelled",
    source: "manual",
    notes: null,
    dedupe_fingerprint: null,
    idempotency_key: null,
    reminder_24h_sent_at: null,
    created_at: "2027-09-01T00:00:00.000Z",
    google_event_id: null,
    google_sync_status: null,
    google_sync_attempts: 0,
    google_sync_next_retry_at: null,
    google_sync_error: null,
  };
}

describe("POST /v1/citas/properties/:propertyId/appointments/:appointmentId/cancel — SAVEPOINT alrededor del aviso a lista de espera (fix auditoría a3, hallazgo confirmado #1)", () => {
  it("con un candidato activo en la lista de espera y whatsapp_config activo: responde 2xx, la sesión de negocio de `citasRepo` PERSISTE (una consulta posterior resuelve, sin 25P02) y la tarea post-commit del aviso queda encolada y corre sin lanzar", async () => {
    const ctx = await buildCitasTestContext(buildApp);

    const session = new RouteAbortAwareFakeSession([
      { match: /citas\.cancel_appointment_from_panel/, respond: () => [{ result: cancelledAppointmentRow() }] },
      { match: /from citas\.appointments where id = \$1 and organization_id = \$2/, respond: () => [cancelledAppointmentRow()] },
      { match: /from citas\.customers/, respond: () => [{ id: CUSTOMER_ID, organization_id: ORG_ID, full_name: "Cliente de prueba", phone: "5215500000000", email: null }] },
      { match: /from citas\.providers where id = \$1 and organization_id = \$2/, respond: () => [{ id: PROVIDER_ID, organization_id: ORG_ID, property_id: null, display_name: "Dr. Prueba", role_label: "Proveedor", is_active: true }] },
      // f2-citas-lista-de-espera, hallazgo (A): la lectura real ahora pasa por
      // `citas.system_load_live_waitlist_candidates` (migración 020), no por un
      // SELECT plano contra `citas.appointment_waitlist` (esa tabla solo tiene
      // policy de RLS de staff -- en sesión de sistema devolvía 0 filas).
      { match: /citas\.system_load_live_waitlist_candidates/, respond: () => [{ out_id: WAITLIST_ID, out_customer_phone: "5215500000001", out_customer_name: "Candidato", out_notified_count: 0, out_provider_id: PROVIDER_ID, out_service_id: null, out_preferred_date_from: null, out_preferred_date_to: null, out_preferred_time_window: "any", out_created_at: "2027-01-01T00:00:00.000Z" }] },
      // Corrección post-revisión de f2-citas-lista-de-espera (hallazgo A2,
      // señalado por revisor independiente): un mock `from citas.whatsapp_config`
      // (SELECT plano) aquí era FALSO contra Postgres real -- esa tabla también
      // solo tiene policy de RLS de staff, así que en sesión de sistema ese
      // SELECT plano SIEMPRE devuelve 0 filas. `resolveActiveWhatsAppPhoneNumberIdAsSystem`
      // ahora llama `citas.system_resolve_active_whatsapp_phone_number_id`
      // (migración 021) -- el mock de abajo simula esa RPC nueva, nunca el
      // SELECT plano. Sin este handler, la llamada caía al catch-all (0 filas
      // sin error) -> `phoneNumberId` quedaba `null` -> `runOptimizadorCore`
      // retornaba `no_whatsapp_config` ANTES de siquiera llamar a
      // `claim_waitlist_notification_slot`, y el test dejaba de ejercitar el
      // SAVEPOINT que dice probar (exactamente el defecto que el revisor
      // encontró en este mismo archivo).
      { match: /citas\.system_resolve_active_whatsapp_phone_number_id/, respond: () => [{ system_resolve_active_whatsapp_phone_number_id: "phone-1" }] },
      // El corazón del hallazgo confirmado: SIEMPRE 42501 en sesión de staff.
      { match: /citas\.claim_waitlist_notification_slot/, respond: () => pgPermissionDenied() },
    ]);

    const deps = { ...ctx.deps, citasRepo: () => new PostgresCitasRepository(session) };
    const app = buildApp(deps);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${APPOINTMENT_ID}/cancel`, authedJson(ctx.staff.owner.token, {}));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { appointment: { status: string } };
    expect(body.appointment.status).toBe("cancelled");

    // La transacción de negocio (staff) quedó utilizable -- prueba directa de que
    // el SAVEPOINT recuperó la sesión en vez de dejarla "aborted" para siempre.
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);

    // La tarea post-commit (`runCitasWaitlistNotifyAfterCancel`, sesión de
    // sistema) corrió DESPUÉS del commit del staff (dbSession la espera antes de
    // devolver la respuesta, ver middleware.ts) -- vuelve a intentar el mismo
    // claim (guard SQL intacto, sigue en 42501) y NO lanza hacia afuera: si
    // hubiera lanzado, `dbSession` lo habría tragado igual (best-effort), pero
    // el punto es que corrió sin reventar el proceso de test.
    const claimCalls = session.calls.filter((c) => c.includes("claim_waitlist_notification_slot"));
    expect(claimCalls.length).toBeGreaterThanOrEqual(1);

    // Una consulta REAL posterior sobre la misma sesión resuelve con normalidad --
    // exactamente el criterio que en producción evita `AbortedTransactionCommitError`.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
