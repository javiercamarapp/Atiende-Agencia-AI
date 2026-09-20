// Fix hallazgo CONFIRMADO de la auditoría a3 (ALTA,
// `auditoria-a3-resultado.json::confirmed[0]`) — cancelar una cita desde el panel
// de STAFF responde 500 y REVIERTE la cancelación cuando hay un candidato activo
// en la lista de espera que coincide con el hueco liberado y whatsapp_config está
// activo. Camino real: cancelAppointmentFromPanel (ya protegido con SAVEPOINT
// desde el PR #158, ver postgres-repository-lifecycle-rpc-savepoint.spec.ts) ->
// tryNotifyWaitlistAfterCancel -> tryNotifyWaitlistOfFreedSlot -> runOptimizadorCore
// -> repo.claimWaitlistNotificationSlot, que la RPC SQL real
// (citas.claim_waitlist_notification_slot) rechaza SIEMPRE con 42501 en sesión de
// staff ("solo para la sesión de sistema"). ANTES de este fix, ese catch lo tragaba
// SIN SAVEPOINT -- la sesión quedaba abortada (25P02) y cualquier consulta
// posterior en la MISMA transacción (incluida tryEnqueueAppointmentEmail) fallaba
// en cascada.
//
// Mismo patrón EXACTO que `postgres-repository-lifecycle-rpc-savepoint.spec.ts`
// (bloqueante r3) de este mismo directorio: `AbortAwareFakeSession` (doble local de
// este paquete, `./support/aborting-fake-session.ts` -- mismo comportamiento que el
// helper compartido `packages/db/tests/support/aborting-fake-session.ts`, duplicado
// a propósito, ver el comentario de cabecera de ese archivo) + `PostgresCitasRepository`
// real -- el único repositorio que de verdad ejecuta `SAVEPOINT`/`ROLLBACK TO
// SAVEPOINT` sobre la sesión, a diferencia de `InMemoryCitasRepository` (no-op).
//
// Estos tests FALLABAN contra el código de `reminders.ts`/
// `appointment-email-notifications.ts` anterior a este fix (sin
// `repo.runWithRowSavepoint` alrededor de `runOptimizadorCore`/
// `enqueueAppointmentEmailCore`): la sesión quedaba "aborted" para siempre y la
// aserción `expectSessionRecovered` reventaba con 25P02 en la consulta posterior.
//
// Actualizado (f2-citas-lista-de-espera, hallazgo A): `runOptimizadorCore` (vía
// `tryNotifyWaitlistOfFreedSlot`, sesión de sistema SIEMPRE) ahora lee
// `repo.loadLiveWaitlistCandidatesAsSystem` -- la RPC `security definer`
// `citas.system_load_live_waitlist_candidates` (migración 020), NO el SELECT
// plano contra `citas.appointment_waitlist` (esa tabla solo tiene policy de
// RLS de STAFF -- ver el comentario de cabecera de esa migración -- en sesión
// de sistema siempre devolvía 0 filas, en silencio). Los mocks de abajo
// simulan la RPC nueva, con las columnas `out_*` que devuelve.
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { tryNotifyWaitlistOfFreedSlot } from "../src/reminders.ts";
import { tryEnqueueAppointmentEmail } from "../src/appointment-email-notifications.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-0000-0000-0000000000o9";
const PROVIDER_ID = "00000000-0000-0000-0000-0000000000p9";
const SERVICE_ID = "00000000-0000-0000-0000-0000000000s9";
const APPOINTMENT_ID = "00000000-0000-0000-0000-0000000000a9";
const WAITLIST_ID = "00000000-0000-0000-0000-0000000000w9";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("claim_waitlist_notification_slot es solo para la sesión de sistema") as Error & { code: string };
  err.code = "42501";
  return err;
}

/** Mismo criterio que `expectSessionRecovered` de
 * `postgres-repository-lifecycle-rpc-savepoint.spec.ts`: un SAVEPOINT se abrió, un
 * ROLLBACK TO SAVEPOINT lo recuperó, y una consulta normal posterior sobre la
 * MISMA sesión (la misma transacción de negocio del request real) no lanza 25P02
 * -- eso es, a nivel de sesión, exactamente lo que en producción evita que el
 * `commit;` final de `managed-postgres-engine.ts` devuelva "ROLLBACK" en silencio.
 */
async function expectSessionRecovered(session: AbortAwareFakeSession): Promise<void> {
  expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
}

describe("tryNotifyWaitlistOfFreedSlot / tryEnqueueAppointmentEmail — SAVEPOINT (fix auditoría a3, hallazgo confirmado #1)", () => {
  it("claim_waitlist_notification_slot lanza 42501 (sesión de staff) -- best-effort devuelve null y la sesión de negocio queda utilizable después (antes de este fix: 25P02 permanente)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_load_live_waitlist_candidates/, respond: () => [{ out_id: WAITLIST_ID, out_customer_phone: "5215500000001", out_customer_name: "Candidato", out_notified_count: 0, out_provider_id: PROVIDER_ID, out_service_id: null, out_preferred_date_from: null, out_preferred_date_to: null, out_preferred_time_window: "any", out_created_at: "2026-01-01T00:00:00.000Z" }] },
      { match: /from citas\.whatsapp_config/, respond: () => [{ phone_number_id: "phone-1" }] },
      { match: /citas\.claim_waitlist_notification_slot/, respond: () => pgPermissionDenied() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await tryNotifyWaitlistOfFreedSlot(repo, ORG_ID, "America/Mexico_City", { providerId: PROVIDER_ID, serviceId: SERVICE_ID, startsAt: "2026-01-02T16:00:00.000Z" });

    // best-effort real: nunca lanza, devuelve null -- la cancelación/reagendado que
    // lo llamó ya se confirmó, esto NUNCA debe convertirse en un error visible.
    expect(result).toBeNull();
    await expectSessionRecovered(session);
  });

  it("(regresión) sin el SAVEPOINT del fix, este mismo escenario dejaría la sesión abortada para siempre -- lo prueba directo contra la sesión cruda, sin pasar por el repositorio", async () => {
    // Reproduce EXACTAMENTE el bug preexistente (comentario de cabecera): un
    // catch plano SIN SAVEPOINT sobre un error real de Postgres dentro de una
    // transacción NUNCA recupera la sesión -- cualquier consulta posterior sigue
    // fallando con 25P02 hasta un ROLLBACK TO SAVEPOINT real.
    const session = new AbortAwareFakeSession([{ match: /citas\.claim_waitlist_notification_slot/, respond: () => pgPermissionDenied() }, { match: /select 1/, respond: () => [] }]);

    try {
      await session.query("select * from citas.claim_waitlist_notification_slot($1, $2);");
    } catch {
      // esperado -- reproduce el catch plano que YA existía antes del fix.
    }

    await expect(session.query("select 1;")).rejects.toMatchObject({ code: "25P02" });
  });

  it("tryEnqueueAppointmentEmail: un error real de Postgres en su propia consulta también queda aislado por SAVEPOINT (mismo hueco, hallazgo #1 y #4 de la auditoría a3)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.appointments where id = \$1 and organization_id = \$2/, respond: () => pgPermissionDenied() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await tryEnqueueAppointmentEmail(repo, ORG_ID, "appointment.cancelled", APPOINTMENT_ID);

    expect(result).toBeNull();
    await expectSessionRecovered(session);
  });

  it("camino feliz: candidato matchea, whatsapp configurado, claim exitoso -- notifica sin ningún SAVEPOINT de recuperación (solo el de aislamiento, sin ROLLBACK TO SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_load_live_waitlist_candidates/, respond: () => [{ out_id: WAITLIST_ID, out_customer_phone: "5215500000001", out_customer_name: "Candidato", out_notified_count: 0, out_provider_id: PROVIDER_ID, out_service_id: null, out_preferred_date_from: null, out_preferred_date_to: null, out_preferred_time_window: "any", out_created_at: "2026-01-01T00:00:00.000Z" }] },
      { match: /from citas\.whatsapp_config/, respond: () => [{ phone_number_id: "phone-1" }] },
      { match: /citas\.claim_waitlist_notification_slot/, respond: () => [{ id: WAITLIST_ID, notified_count: 1 }] },
      { match: /citas\.enqueue_messaging_outbox/, respond: () => [{ enqueue_messaging_outbox: "00000000-0000-0000-0000-0000000000e1" }] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await tryNotifyWaitlistOfFreedSlot(repo, ORG_ID, "America/Mexico_City", { providerId: PROVIDER_ID, serviceId: SERVICE_ID, startsAt: "2026-01-02T16:00:00.000Z" });

    expect(result).toEqual({ matched: true, waitlistId: WAITLIST_ID, customerPhone: "5215500000001" });
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(false);
  });
});
