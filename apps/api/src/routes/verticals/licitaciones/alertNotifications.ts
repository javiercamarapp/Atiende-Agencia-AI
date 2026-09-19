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
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runAlertNotificationSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo criterio que INLINE_BATCH_SIZE de hoteles/email-dispatch.ts. */
const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerLicitacionesEmailDispatchInline` no duplique la llamada a
 *  `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA función
 *  abre su propia sesión de sistema (correcto para el cron). */
export async function runLicitacionesEmailDispatch(deps: AppDeps): Promise<LicitacionesEmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const repo = deps.licitacionesRepo(db);
    return dispatchPendingEmailJobs(repo, deps.env.resend);
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
 */
export async function triggerLicitacionesEmailDispatchInline(deps: AppDeps, db: TenantDbSession, licitacionesRepo: LicitacionesRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  await db.exec("SAVEPOINT sp_inline_email_dispatch");
  try {
    const summary = await dispatchPendingEmailJobs(licitacionesRepo, deps.env.resend, { batchSize });
    await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    if (summary.dead > 0) {
      console.error(`licitaciones email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
    }
  } catch (err) {
    try {
      await db.exec("ROLLBACK TO SAVEPOINT sp_inline_email_dispatch");
      await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    } catch (recoveryErr) {
      console.error("licitaciones email-dispatch inline: fallo recuperando el SAVEPOINT (no debería pasar):", recoveryErr);
    }
    console.error("licitaciones email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
  }
}

export function licitacionesAlertNotificationsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/licitaciones/alert-notifications", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/licitaciones/alert-notifications", () => deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.licitacionesRepo(db);
      const sweep = await runAlertNotificationSweep(repo);
      // Disparo inline best-effort (ver comentario de cabecera): el barrido de
      // arriba pudo haber encolado recordatorios de plazo/renovación/cobranza
      // reales vía `channel='email'`.
      await triggerLicitacionesEmailDispatchInline(deps, db, repo);
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
      return c.json(
        {
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
        },
        200,
      );
    }))();
  });

  app.on(["GET", "POST"], "/internal/licitaciones/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que las demás rutas internas.
    return withHeartbeat(deps, "/internal/licitaciones/email-dispatch", async () => {
      const summary = await runLicitacionesEmailDispatch(deps);
      return c.json({
        ok: true,
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
