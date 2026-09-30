// Fase 9 — GET/POST /internal/rentas/email-dispatch: drena el canal `email` de
// `rentas.messaging_outbox` vía Resend. Mismo patrón/guard EXACTO que
// apps/api/.../hoteles/email-dispatch.ts y .../citas/email-dispatch.ts: acepta GET
// (Vercel Cron, que solo dispara GET con `Authorization: Bearer <CRON_SECRET>`) y
// POST (header manual `x-atiende-internal-secret`/tests), gateada por
// `internalOrCronSecretMatches` (ver comentario de cabecera de
// `http-security.ts::internalOrCronSecretMatches`). Fail-closed real:
// sin RESEND_API_KEY configurada (deps.env.resend.apiKey === null), fix a2b
// hace que NINGÚN job se reclame -- quedan 'pending' intactos, ver
// `notConfigured`/`INLINE_BATCH_SIZE` abajo. CON la key configurada, cada job
// que Resend rechace falla explícito — la ruta responde 200 igual (el fallo
// por job ya quedó reflejado en el resumen; esto es un barrido periódico, no
// una operación que deba tumbar el scheduler) pero NUNCA marca ningún job
// 'sent' sin que Resend en verdad lo haya aceptado.
//
// Cierre del hallazgo "rentas no tiene disparo inline de correo, solo el cron
// diario de vercel.json::crons -- un correo encolado puede tardar hasta ~24h en
// salir": mismo principio EXACTO que
// `../hoteles/email-dispatch.ts::triggerHotelesEmailDispatchInline` (leído
// primero como plantilla) — `triggerRentasEmailDispatchInline` (exportada
// abajo) recibe el MISMO `rentasRepo` ya abierto en la transacción/sesión del
// caller (nunca abre una sesión nueva) y hace un best-effort real: un fallo
// aquí NUNCA se propaga -- el correo ya quedó en el outbox y el cron diario
// (red de seguridad de respaldo) lo recoge después. Se llama justo después de
// encolar un correo real en `./reservas.ts` (tryEnqueueReservaEmail al crear
// una reserva directa) y en `./checkin-recordatorio.ts` (el barrido periódico
// de `runRecordatorioCheckInCore`, un cron SEPARADO del de email-dispatch).
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-rentas";
import type { EmailDispatchSummary as RentasEmailDispatchSummary, RentasRepository } from "@atiende/domain-rentas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo criterio que INLINE_BATCH_SIZE de hoteles/email-dispatch.ts.
 * Exportado (fix a2b, parte B) para que el drenado post-commit de
 * `postCommitTasks` (reservas.ts) lo use también, en vez del batch completo
 * (25) por defecto. */
export const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerRentasEmailDispatchInline` no duplique la llamada a
 *  `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA función
 *  abre su propia sesión de sistema (correcto para el cron).
 *
 * Fix a2b (parte B) -- `batchSize` opcional: el cron real sigue llamando SIN
 * argumento (batch completo, 25), pero el drenado post-commit que
 * `reservas.ts` encola en `postCommitTasks` (ver comentario largo de
 * `dbSession` en `packages/core-auth/src/middleware.ts`, corre con `await`
 * ANTES de que la respuesta del staff se transmita) ahora pasa
 * `INLINE_BATCH_SIZE` explícito. */
export async function runRentasEmailDispatch(deps: AppDeps, batchSize?: number): Promise<RentasEmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const rentasRepo = deps.rentasRepo(db);
    return dispatchPendingEmailJobs(rentasRepo, deps.env.resend, { batchSize });
  });
}

/**
 * Disparo inline best-effort — mismo principio que
 * `triggerHotelesEmailDispatchInline` de hoteles/email-dispatch.ts: llamar
 * justo después de que la vertical haya encolado (o no) un correo real,
 * pasando el MISMO `rentasRepo` ya abierto en la transacción/sesión de ESE
 * request (nunca una sesión nueva). Un fallo aquí NUNCA se propaga al caller
 * HTTP — el correo ya quedó en el outbox y el cron diario (red de seguridad
 * de respaldo) lo recoge después.
 *
 * Hotfix (auditoría a2, CRÍTICO) — recibe también `db` (el MISMO
 * `TenantDbSession` de `c.get("db")`/`withAppSession`, nunca uno nuevo) para
 * envolver el drenado en `SAVEPOINT`. En TODA ruta de sesión de STAFF
 * (`auth.uid()` no nulo) `rentas.claim_email_outbox_batch` lanza SIEMPRE
 * 42501 (guard correcto, cross-tenant -- NO se afloja) y, sin este SAVEPOINT,
 * esa excepción deja la transacción de negocio COMPLETA abortada (25P02) hasta
 * un `ROLLBACK TO SAVEPOINT`: el `commit;` del motor sobre una transacción
 * abortada no lanza error (Postgres responde "ROLLBACK" en silencio, ver
 * packages/db/src/managed-postgres-engine.ts), así que la reserva manual de
 * ESTE MISMO request (reservas.ts) se pierde con un 2xx. Mismo patrón
 * SAVEPOINT ya usado en `InMemoryRentasTenancyEngine`/
 * `packages/domain-citas/src/postgres-repository.ts::upsertCustomer`. Ver
 * `scripts/verify-correo-inline-sesion-staff/` para la prueba ANTES/DESPUÉS
 * contra Postgres real.
 *
 * Fix a2b (parte C) — el `exec("SAVEPOINT ...")` ahora corre DENTRO del
 * `try` (antes corría antes, sin protección): si la transacción YA venía
 * abortada por una causa ANTERIOR a este trigger, ese `exec` en sí lanza
 * 25P02 -- sin el `try` alrededor, esa excepción se propagaba tal cual al
 * caller, contradiciendo el "nunca se propaga" de este docstring.
 *
 * Corrección (revisión independiente PR #168) — la versión anterior de este
 * fix tragaba SIEMPRE ese 25P02, incluso cuando la transacción YA venía
 * abortada por una causa AJENA a este trigger (p. ej. el encolado del correo
 * de la vertical traga un error de Postgres SIN savepoint propio). Eso
 * convertía un 500 honesto (el `exec` se propagaba sin el `try`, el `catch`
 * de `withAppSession` hacía el ROLLBACK real) en un 2xx con la reserva de
 * ESTE MISMO request perdida: sin savepoint que recuperar, el `commit;`
 * final de `managed-postgres-engine.ts` sobre la transacción abortada se
 * convierte en un ROLLBACK silencioso. Ahora se distingue con
 * `savepointTaken`: si el SAVEPOINT mismo falla (nunca llegó a tomarse), no
 * hay nada que este trigger pueda proteger con un `ROLLBACK TO SAVEPOINT` --
 * se RELANZA, para que el caller reciba el 5xx honesto. Solo cuando el
 * SAVEPOINT SÍ se tomó (la transacción estaba sana al entrar) y el fallo
 * ocurre DESPUÉS (incluido el 42501 determinista de sesión de staff) se hace
 * el `ROLLBACK TO SAVEPOINT` best-effort sin relanzar -- ese es el único
 * caso que este SAVEPOINT existe para aislar.
 *
 * FASE 2 (integridad, consolidación) -- mismo reemplazo EXACTO que
 * `../hoteles/email-dispatch.ts::triggerHotelesEmailDispatchInline` (leído
 * primero como plantilla): el SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE manual
 * de arriba se reemplaza por `runWithSavepointFallback` (@atiende/db) --
 * comportamiento idéntico, verificado contra la suite de regresión existente
 * (rentas-email-dispatch-savepoint.spec.ts, `AbortAwareFakeSession`).
 * `savepointName` fijo preserva el nombre exacto (`sp_inline_email_dispatch`)
 * que esa suite ya afirma.
 */
export async function triggerRentasEmailDispatchInline(deps: AppDeps, db: TenantDbSession, rentasRepo: RentasRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  const summary = await runWithSavepointFallback<RentasEmailDispatchSummary | undefined>({
    session: db,
    savepointName: "sp_inline_email_dispatch",
    primary: () => dispatchPendingEmailJobs(rentasRepo, deps.env.resend, { batchSize }),
    isRecoverable: () => true,
    fallback: (err) => {
      console.error("rentas email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
      return Promise.resolve(undefined);
    },
  });
  if (summary && summary.dead > 0) {
    console.error(`rentas email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
  }
}

export function rentasEmailDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que ical-sync-cron.ts.
    return withHeartbeat(deps, "/internal/rentas/email-dispatch", async () => {
      const summary = await runRentasEmailDispatch(deps);
      // Fix a2b (parte A) -- sin RESEND_API_KEY, `summary.notConfigured` es
      // true y `failed`/`dead` quedan en 0 (nunca se reclamó nada): estado
      // esperado, reflejado explícito en `status`.
      return c.json({
        ok: true,
        status: summary.notConfigured ? "not_configured" : "ok",
        processed: summary.processed,
        sent: summary.sent,
        failed: summary.failed,
        dead: summary.dead,
        errors: summary.errors.map((e) => ({ job_id: e.jobId, error: e.error })),
      });
    })();
  });

  return app;
}
