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
import { runCobranzaReminderSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo criterio que INLINE_BATCH_SIZE de hoteles/email-dispatch.ts. */
const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerDespachosEmailDispatchInline` no duplique la llamada a
 *  `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA función
 *  abre su propia sesión de sistema (correcto para el cron). */
export async function runDespachosEmailDispatch(deps: AppDeps): Promise<DespachosEmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const repo = deps.despachosRepo(db);
    return dispatchPendingEmailJobs(repo, deps.env.resend);
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
 */
export async function triggerDespachosEmailDispatchInline(deps: AppDeps, despachosRepo: DespachosRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  try {
    const summary = await dispatchPendingEmailJobs(despachosRepo, deps.env.resend, { batchSize });
    if (summary.dead > 0) {
      console.error(`despachos email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
    }
  } catch (err) {
    console.error("despachos email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
  }
}

export function despachosNotificationsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/despachos/cobranza-reminders", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/despachos/cobranza-reminders", () => deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.despachosRepo(db);
      const sweep = await runCobranzaReminderSweep(repo);
      // Disparo inline best-effort (ver comentario de cabecera): el barrido de
      // arriba pudo haber encolado recordatorios reales de cobranza vía
      // `channel='email'` -- este cron es INDEPENDIENTE del cron de
      // `/internal/despachos/email-dispatch` (vercel.json los agenda por
      // separado), así que sin esto un correo podía esperar hasta 24h a que
      // corriera el OTRO cron.
      await triggerDespachosEmailDispatchInline(deps, repo);
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
      return c.json(
        {
          ok: failures.length === 0,
          organizations_checked: sweep.length,
          ...totals,
          corridas: sweep.map((r) => ({
            organization_id: r.organizationId,
            error: r.error ?? null,
            properties: r.properties.map((p) => ({ property_id: p.propertyId, receivables_scanned: p.receivablesScanned, reminders_due: p.remindersDue, emails_enqueued: p.emailsEnqueued })),
          })),
          failures,
        },
        200,
      );
    }))();
  });

  app.on(["GET", "POST"], "/internal/despachos/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que las demás rutas internas.
    return withHeartbeat(deps, "/internal/despachos/email-dispatch", async () => {
      const summary = await runDespachosEmailDispatch(deps);
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
