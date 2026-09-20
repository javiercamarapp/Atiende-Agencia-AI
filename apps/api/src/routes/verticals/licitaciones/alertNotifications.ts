// Fase 10 — licitacionesAlertNotificationsRoutes: expone por HTTP el barrido
// real de despacho proactivo de alertas
// (`@atiende/worker::runAlertNotificationSweep`) y el dispatcher de correo
// que de verdad drena `licitaciones.messaging_outbox` vía Resend
// (`@atiende/domain-licitaciones::dispatchPendingEmailJobs`). Rutas
// INTERNAS, gateadas por secreto compartido (`x-atiende-internal-secret` o
// `Authorization: Bearer`, ver `internalOrCronSecretMatches`, análogo a
// CRON_SECRET), pensadas para ser invocadas por un scheduler externo (Vercel
// Cron/Supabase Cron) — MISMO patrón EXACTO que
// `./discover.ts` (recordatorios de plazo/ingesta, Fase 8) y
// `../rentas/email-dispatch.ts`/`../citas/email-dispatch.ts` (leídos primero
// como plantilla): sin `authMiddleware`/`dbSession`, abren su propia sesión
// de sistema (`userId: null`) para todo el barrido.
//
// Fase 12 (cierre del hallazgo ALTA "sin cron configurado: los correos de
// alerta nunca se despachan en producción") — `vercel.json` (raíz del repo)
// ya declara `crons` reales apuntando a estas 2 rutas (más las 2 de
// `./discover.ts`). Vercel Cron dispara SIEMPRE con GET (no permite headers
// custom en la config), por eso cada ruta se registra con
// `app.on(["GET", "POST"], ...)`: GET es lo que el cron real usa, POST sigue
// funcionando igual que antes para curl/tests manuales — misma lógica,
// mismo gate de secreto, sin duplicar el handler.
//
// Cierre del hallazgo "licitaciones no tiene disparo inline de correo, solo
// el cron diario de vercel.json::crons -- un correo encolado puede tardar
// hasta ~24h en salir": mismo principio EXACTO que
// `../hoteles/email-dispatch.ts::triggerHotelesEmailDispatchInline` (leído
// primero como plantilla) — `triggerLicitacionesEmailDispatchInline`
// (exportada abajo) recibe el MISMO `licitacionesRepo` ya abierto en la
// sesión del caller (nunca abre una sesión nueva) y hace un best-effort real:
// un fallo aquí NUNCA se propaga -- el correo ya quedó en el outbox y el cron
// diario de `/internal/licitaciones/email-dispatch` (red de seguridad de
// respaldo) lo recoge después. Se llama justo después del barrido de
// `runAlertNotificationSweep` de abajo (único punto del vertical que encola
// vía `channel='email'` fuera de `admin-staff.ts::staff.invite`, que -- igual
// que en citas/hoteles/restaurantes -- se deja fuera del disparo inline por
// paridad con esos verticales). Ese barrido corre en un cron SEPARADO del de
// email-dispatch (vercel.json los agenda por separado), así que sin esto una
// alerta podía esperar hasta 24h a que corriera el OTRO cron.
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-licitaciones";
import type { EmailDispatchSummary as LicitacionesEmailDispatchSummary, LicitacionesRepository } from "@atiende/domain-licitaciones";
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runAlertNotificationSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo criterio que INLINE_BATCH_SIZE de hoteles/email-dispatch.ts. */
export const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerLicitacionesEmailDispatchInline` no duplique la llamada a
 *  `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA función
 *  abre su propia sesión de sistema (correcto para el cron).
 *
 * Fix a2b (parte B) -- `batchSize` opcional, mismo criterio que
 * `runHotelesEmailDispatch`. El único call site real de este cron hoy es la
 * ruta `/internal/licitaciones/email-dispatch` de abajo (SIN argumento, batch
 * completo); licitaciones no encola este drenado en `postCommitTasks` (su
 * único disparo inline, `triggerLicitacionesEmailDispatchInline`, ya corre en
 * sesión de sistema propia, ver comentario de esa función). */
export async function runLicitacionesEmailDispatch(deps: AppDeps, batchSize?: number): Promise<LicitacionesEmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const repo = deps.licitacionesRepo(db);
    return dispatchPendingEmailJobs(repo, deps.env.resend, { batchSize });
  });
}

/**
 * Disparo inline best-effort — mismo principio que
 * `triggerHotelesEmailDispatchInline` de hoteles/email-dispatch.ts: llamar
 * justo después de que la vertical haya encolado (o no) un correo real,
 * pasando el MISMO `licitacionesRepo` ya abierto en la sesión de ESE request
 * (nunca una sesión nueva). Un fallo aquí NUNCA se propaga al caller HTTP —
 * el correo ya quedó en el outbox y el cron diario (red de seguridad de
 * respaldo) lo recoge después.
 *
 * Hotfix (auditoría a2, CRÍTICO) — recibe también `db` (el MISMO
 * `TenantDbSession` de `withAppSession`, nunca uno nuevo) para envolver el
 * drenado en `SAVEPOINT`. El ÚNICO call site real de esta función hoy
 * (`/internal/licitaciones/alert-notifications` de abajo) YA corre en sesión
 * de SISTEMA (`auth.uid()` null, guard pasa sin problema -- ver
 * auditoria-a2-resultado.json::refuted, "Alcance a restaurantes public.ts:129
 * createOrder y licitaciones alertNotifications.ts:95"), así que este SAVEPOINT
 * es defensa en profundidad (misma función que las otras 5 verticales,
 * protegida igual por si un futuro call site la invoca desde sesión de staff),
 * no la corrección de un bug activo en licitaciones.
 *
 * Fix a2b (parte C) — el `exec("SAVEPOINT ...")` ahora corre DENTRO del
 * `try` (antes corría antes, sin protección): si la transacción YA venía
 * abortada por una causa ANTERIOR a este trigger, ese `exec` en sí lanza
 * 25P02 -- sin el `try` alrededor, esa excepción se propagaba tal cual al
 * caller, contradiciendo el "nunca se propaga" de este docstring.
 *
 * Corrección (revisión independiente PR #168) — la versión anterior de este
 * fix tragaba SIEMPRE ese 25P02, incluso cuando la transacción YA venía
 * abortada por una causa AJENA a este trigger. Eso convertía un 500 honesto
 * (el `exec` se propagaba sin el `try`, el `catch` de `withAppSession` hacía
 * el ROLLBACK real) en un 2xx con el barrido de ESTE MISMO request perdido:
 * sin savepoint que recuperar, el `commit;` final de
 * `managed-postgres-engine.ts` sobre la transacción abortada se convierte en
 * un ROLLBACK silencioso. Ahora se distingue con `savepointTaken`: si el
 * SAVEPOINT mismo falla (nunca llegó a tomarse), no hay nada que este
 * trigger pueda proteger con un `ROLLBACK TO SAVEPOINT` -- se RELANZA, para
 * que el caller reciba el 5xx honesto. Solo cuando el SAVEPOINT SÍ se tomó
 * (la transacción estaba sana al entrar) y el fallo ocurre DESPUÉS se hace
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
 * `licitaciones-email-dispatch-savepoint.spec.ts` (afirma `execCalls` exacto).
 */
export async function triggerLicitacionesEmailDispatchInline(deps: AppDeps, db: TenantDbSession, licitacionesRepo: LicitacionesRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  await runWithSavepointFallback<void>({
    session: db,
    savepointName: "sp_inline_email_dispatch",
    primary: async () => {
      const summary = await dispatchPendingEmailJobs(licitacionesRepo, deps.env.resend, { batchSize });
      if (summary.dead > 0) {
        console.error(`licitaciones email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
      }
    },
    isRecoverable: () => true,
    fallback: async (err) => {
      console.error("licitaciones email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
    },
  });
}

export function licitacionesAlertNotificationsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/licitaciones/alert-notifications", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // r4-fix-crons-transaccion-por-unidad (auditoría a1b #2, MEDIA): YA NO se
    // abre una única `withAppSession` para todo el barrido -- `runAlertNotificationSweep`
    // recibe un runner (`withRepo`) que abre UNA transacción POR organización
    // (ver su comentario de cabecera en @atiende/worker).
    return withHeartbeat(deps, "/internal/licitaciones/alert-notifications", async () => {
      const withRepo = <T>(fn: (repo: LicitacionesRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.licitacionesRepo(db)));
      const sweep = await runAlertNotificationSweep(withRepo);
      // Disparo inline best-effort (ver comentario de cabecera): el barrido de
      // arriba pudo haber encolado recordatorios de plazo/renovación/cobranza
      // reales vía `channel='email'`. r4-fix-crons-transaccion-por-unidad:
      // antes compartía LA MISMA transacción del barrido completo; ahora abre
      // la suya propia -- mismo criterio que `runLicitacionesEmailDispatch`
      // (el cron separado de email-dispatch, que siempre abrió la suya). Sigue
      // pasando `db` (además de `repo`) porque `triggerLicitacionesEmailDispatchInline`
      // envuelve el drenado en su propio SAVEPOINT (hotfix auditoría a2).
      await deps.engine.withAppSession({ userId: null }, (db) => triggerLicitacionesEmailDispatchInline(deps, db, deps.licitacionesRepo(db)));
      const failures = sweep.filter((r) => r.error != null).map((r) => ({ organization_id: r.organizationId, error: r.error }));
      const totals = sweep.reduce(
        (acc, r) => ({
          deadline_reminders_created: acc.deadline_reminders_created + r.deadlineReminders.created,
          renewal_alerts_created: acc.renewal_alerts_created + r.renewalAlerts.alertsCreated,
          overdue_invoices: acc.overdue_invoices + r.collectionAlerts.overdueInvoices,
          emails_enqueued: acc.emails_enqueued + r.deadlineReminders.emailsEnqueued + r.renewalAlerts.emailsEnqueued + r.collectionAlerts.emailsEnqueued,
        }),
        { deadline_reminders_created: 0, renewal_alerts_created: 0, overdue_invoices: 0, emails_enqueued: 0 },
      );
      const body = {
        ok: failures.length === 0,
        organizations_checked: sweep.length,
        ...totals,
        corridas: sweep.map((r) => ({
          organization_id: r.organizationId,
          error: r.error ?? null,
          recordatorios_plazo: r.deadlineReminders,
          alertas_renovacion: r.renewalAlerts,
          alertas_cobranza: r.collectionAlerts,
        })),
        failures,
      };
      const response = c.json(body, 200);
      // (5) el latido no debe registrar "ok" limpio si alguna organización
      // falló -- ver CronPartialFailureError (with-heartbeat.ts).
      if (failures.length > 0) {
        throw new CronPartialFailureError(`alert-notifications: ${failures.length} de ${sweep.length} organizaciones fallaron`, response);
      }
      return response;
    })();
  });

  app.on(["GET", "POST"], "/internal/licitaciones/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que las demás rutas internas.
    return withHeartbeat(deps, "/internal/licitaciones/email-dispatch", async () => {
      const summary = await runLicitacionesEmailDispatch(deps);
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
