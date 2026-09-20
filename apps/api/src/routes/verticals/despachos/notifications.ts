// despachosNotificationsRoutes — hallazgo de auditoría (severidad ALTA):
// "Despachos no tiene ninguna infraestructura de correo (ni outbox, ni
// plantilla HTML, ni dispatch), mientras citas/rentas/licitaciones sí la
// tienen". Expone por HTTP el barrido real de recordatorios de cobranza
// (`@atiende/worker::runCobranzaReminderSweep`) y el dispatcher de correo que
// de verdad drena `despachos.messaging_outbox` vía Resend
// (`@atiende/domain-despachos::dispatchPendingEmailJobs`) — MISMO patrón
// EXACTO que `../hoteles/email-dispatch.ts`/`../citas/email-dispatch.ts`:
// rutas INTERNAS que aceptan GET (scheduler) y POST (manual/tests), gateadas
// por `internalOrCronSecretMatches` (acepta tanto el header manual
// `x-atiende-internal-secret` como el `Authorization: Bearer <secreto>` que
// manda Vercel Cron en sus invocaciones GET — ver comentario de cabecera de
// `http-security.ts::internalOrCronSecretMatches`) — sin `authMiddleware`/
// `dbSession`, abren su propia sesión de sistema (`userId: null`) para todo el
// barrido.
//
// Cierre del hallazgo "despachos no tiene disparo inline de correo, solo el
// cron diario de vercel.json::crons -- un correo encolado puede tardar hasta
// ~24h en salir": mismo principio EXACTO que
// `../hoteles/email-dispatch.ts::triggerHotelesEmailDispatchInline` (leído
// primero como plantilla) — `triggerDespachosEmailDispatchInline` (exportada
// abajo) recibe el MISMO `despachosRepo` ya abierto en la transacción/sesión
// del caller (nunca abre una sesión nueva) y hace un best-effort real: un
// fallo aquí NUNCA se propaga -- el correo ya quedó en el outbox y el cron
// diario (red de seguridad de respaldo) lo recoge después. Se llama justo
// después de encolar un correo real en
// `../despachos/vencimientos.ts::escalar` (tryEnqueueEscalationEmail) y justo
// después del barrido de `runCobranzaReminderSweep` en la ruta
// `/internal/despachos/cobranza-reminders` de abajo (ese barrido encola vía
// `@atiende/domain-despachos::cobranza/email-notifications.ts`, un cron
// SEPARADO del de email-dispatch -- sin este disparo inline, un recordatorio
// de cobranza podía esperar a que corriera el OTRO cron).
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-despachos";
import type { DespachosRepository, EmailDispatchSummary as DespachosEmailDispatchSummary } from "@atiende/domain-despachos";
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runCobranzaReminderSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo criterio que INLINE_BATCH_SIZE de hoteles/email-dispatch.ts.
 * Exportado (fix a2b, parte B) para que el drenado post-commit de
 * `postCommitTasks` (vencimientos.ts) lo use también, en vez del batch
 * completo (25) por defecto. */
export const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerDespachosEmailDispatchInline` no duplique la llamada a
 *  `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA función
 *  abre su propia sesión de sistema (correcto para el cron).
 *
 * Fix a2b (parte B) -- `batchSize` opcional: el cron real sigue llamando SIN
 * argumento (batch completo, 25), pero el drenado post-commit que
 * `vencimientos.ts` encola en `postCommitTasks` (ver comentario largo de
 * `dbSession` en `packages/core-auth/src/middleware.ts`, corre con `await`
 * ANTES de que la respuesta del staff se transmita) ahora pasa
 * `INLINE_BATCH_SIZE` explícito. */
export async function runDespachosEmailDispatch(deps: AppDeps, batchSize?: number): Promise<DespachosEmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const repo = deps.despachosRepo(db);
    return dispatchPendingEmailJobs(repo, deps.env.resend, { batchSize });
  });
}

/**
 * Disparo inline best-effort — mismo principio que
 * `triggerHotelesEmailDispatchInline` de hoteles/email-dispatch.ts: llamar
 * justo después de que la vertical haya encolado (o no) un correo real,
 * pasando el MISMO `despachosRepo` ya abierto en la transacción/sesión de ESE
 * request (nunca una sesión nueva). Un fallo aquí NUNCA se propaga al caller
 * HTTP — el correo ya quedó en el outbox y el cron diario (red de seguridad
 * de respaldo) lo recoge después.
 *
 * Hotfix (auditoría a2, CRÍTICO) — recibe también `db` (el MISMO
 * `TenantDbSession` de `c.get("db")`/`withAppSession`, nunca uno nuevo) para
 * envolver el drenado en `SAVEPOINT`. En TODA ruta de sesión de STAFF
 * (`auth.uid()` no nulo) `despachos.claim_email_outbox_batch` lanza SIEMPRE
 * 42501 (guard correcto, cross-tenant -- NO se afloja) y, sin este SAVEPOINT,
 * esa excepción deja la transacción de negocio COMPLETA abortada (25P02) hasta
 * un `ROLLBACK TO SAVEPOINT`: el `commit;` del motor sobre una transacción
 * abortada no lanza error (Postgres responde "ROLLBACK" en silencio, ver
 * packages/db/src/managed-postgres-engine.ts), así que el escalamiento de
 * vencimientos.ts de ESTE MISMO request se pierde con un 2xx. Mismo patrón
 * SAVEPOINT ya usado en
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
 * de escalamiento traga un error de Postgres SIN savepoint propio). Eso
 * convertía un 500 honesto (el `exec` se propagaba sin el `try`, el `catch`
 * de `withAppSession` hacía el ROLLBACK real) en un 2xx con el escalamiento
 * de ESTE MISMO request perdido: sin savepoint que recuperar, el `commit;`
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
 * Consolidación (Fase 2, integridad) — mismo refactor que
 * `citas/email-dispatch.ts::triggerCitasEmailDispatchInline` (leído primero
 * como plantilla): el SAVEPOINT/ROLLBACK/RELEASE manual de arriba ahora corre
 * por `runWithSavepointFallback` (`@atiende/db`) con `isRecoverable` fijo en
 * `true` y un `fallback` que solo loguea -- nunca relanza. Preserva la
 * distinción `savepointTaken`: `runWithSavepointFallback` relanza tal cual
 * cuando el SAVEPOINT mismo falla (nunca invoca `fallback` en ese caso) y
 * solo corre `fallback` tras un `ROLLBACK TO SAVEPOINT` de recuperación
 * exitoso. `savepointName` fijo para no romper
 * `despachos-email-dispatch-savepoint.spec.ts` (afirma `execCalls` exacto).
 */
export async function triggerDespachosEmailDispatchInline(deps: AppDeps, db: TenantDbSession, despachosRepo: DespachosRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  await runWithSavepointFallback<void>({
    session: db,
    savepointName: "sp_inline_email_dispatch",
    primary: async () => {
      const summary = await dispatchPendingEmailJobs(despachosRepo, deps.env.resend, { batchSize });
      if (summary.dead > 0) {
        console.error(`despachos email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
      }
    },
    isRecoverable: () => true,
    fallback: async (err) => {
      console.error("despachos email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
    },
  });
}

export function despachosNotificationsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/despachos/cobranza-reminders", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // r4-fix-crons-transaccion-por-unidad (auditoría a1b #2, MEDIA): YA NO se
    // abre una única `withAppSession` para todo el barrido -- `runCobranzaReminderSweep`
    // recibe un runner (`withRepo`) que abre UNA transacción POR organización
    // (ver su comentario de cabecera en @atiende/worker).
    return withHeartbeat(deps, "/internal/despachos/cobranza-reminders", async () => {
      const withRepo = <T>(fn: (repo: DespachosRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.despachosRepo(db)));
      const sweep = await runCobranzaReminderSweep(withRepo);
      // Disparo inline best-effort (ver comentario de cabecera del archivo): el
      // barrido de arriba pudo haber encolado recordatorios reales de cobranza
      // vía `channel='email'` -- este cron es INDEPENDIENTE del cron de
      // `/internal/despachos/email-dispatch` (vercel.json los agenda por
      // separado), así que sin esto un correo podía esperar hasta 24h a que
      // corriera el OTRO cron. r4-fix-crons-transaccion-por-unidad: antes
      // compartía LA MISMA transacción del barrido completo (un fallo del
      // drenado inline podía tumbar el barrido y viceversa); ahora que el
      // barrido ya no tiene una única `repo`/transacción "del request", abre
      // la suya propia -- mismo criterio que `runDespachosEmailDispatch` (el
      // cron separado de email-dispatch, que siempre abrió la suya). Sigue
      // pasando `db` (además de `repo`) porque `triggerDespachosEmailDispatchInline`
      // envuelve el drenado en su propio SAVEPOINT (hotfix auditoría a2).
      await deps.engine.withAppSession({ userId: null }, (db) => triggerDespachosEmailDispatchInline(deps, db, deps.despachosRepo(db)));
      const failures = sweep.filter((r) => r.error != null).map((r) => ({ organization_id: r.organizationId, error: r.error }));
      const totals = sweep.reduce(
        (acc, r) => {
          for (const p of r.properties) {
            acc.receivables_scanned += p.receivablesScanned;
            acc.reminders_due += p.remindersDue;
            acc.emails_enqueued += p.emailsEnqueued;
          }
          return acc;
        },
        { receivables_scanned: 0, reminders_due: 0, emails_enqueued: 0 },
      );
      const body = {
        ok: failures.length === 0,
        organizations_checked: sweep.length,
        ...totals,
        corridas: sweep.map((r) => ({
          organization_id: r.organizationId,
          error: r.error ?? null,
          properties: r.properties.map((p) => ({ property_id: p.propertyId, receivables_scanned: p.receivablesScanned, reminders_due: p.remindersDue, emails_enqueued: p.emailsEnqueued })),
        })),
        failures,
      };
      const response = c.json(body, 200);
      // (5) el latido no debe registrar "ok" limpio si alguna organización
      // falló -- ver CronPartialFailureError (with-heartbeat.ts).
      if (failures.length > 0) {
        throw new CronPartialFailureError(`cobranza-reminders: ${failures.length} de ${sweep.length} organizaciones fallaron`, response);
      }
      return response;
    })();
  });

  app.on(["GET", "POST"], "/internal/despachos/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que las demás rutas internas.
    return withHeartbeat(deps, "/internal/despachos/email-dispatch", async () => {
      const summary = await runDespachosEmailDispatch(deps);
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
