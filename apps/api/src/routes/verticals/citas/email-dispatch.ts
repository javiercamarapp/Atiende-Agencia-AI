// Fase 6 §3 — POST/GET /internal/citas/email-dispatch: drena el canal `email` de
// `citas.messaging_outbox` vía Resend (mismo patrón/guard que
// google-calendar-sync.ts y reminders.ts). Fail-closed real: sin RESEND_API_KEY
// configurada (deps.env.resend.apiKey === null), cada job falla explícito — la
// ruta responde 200 igual (el fallo por job ya quedó reflejado en el resumen;
// esto es un barrido periódico, no una operación que deba tumbar el scheduler)
// pero NUNCA marca ningún job 'sent' sin que Resend en verdad lo haya aceptado.
//
// Wiring real del scheduler (cierra el hallazgo "nunca se disparan" del auditor):
// `vercel.json::crons` invoca este mismo path por GET una vez al día (único
// método/frecuencia que permite el plan Hobby de Vercel, ver
// docs/DEPLOY.md#resumen-de-costo-por-plataforma) con
// `Authorization: Bearer <CRON_SECRET>`. `internalOrCronSecretMatches` acepta esa
// forma además del header manual `x-atiende-internal-secret` que ya usaban los
// tests/invocaciones manuales — mismo secreto (`INTERNAL_SECRET`), dos formas
// de mandarlo. Un barrido diario dista de "inmediato" para un correo de
// confirmación (limitación real del tier gratuito, no de este código); subir a
// Vercel Pro permitiría bajar el `schedule` a cada pocos minutos sin tocar una
// sola línea de este archivo.
//
// CLUSTER #3 de la auditoría final (CRÍTICO, mismo hallazgo raíz que
// routes/internal/whatsapp-dispatch.ts): este cron diario sigue siendo la red de
// seguridad de respaldo, pero YA NO es el único disparador — cada acción de
// apps/api/src/routes/verticals/citas/{appointments,appointments-lifecycle}.ts
// que encola un correo real (`tryEnqueueAppointmentEmail`) llama
// `triggerCitasEmailDispatchInline` (exportado abajo) justo después, en la MISMA
// transacción/repo, para intentar el envío YA en vez de esperar al cron.
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-citas";
import type { CitasRepository, EmailDispatchSummary } from "@atiende/domain-citas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Límite del drenado INLINE -- deliberadamente chico, mismo criterio que
 *  INLINE_LIMIT de whatsapp-dispatch.ts: casi siempre hay 0-1 correo pendiente
 *  real (el que la acción actual acaba de encolar); cualquier remanente lo
 *  recoge el cron diario (batchSize completo por defecto de
 *  `dispatchPendingEmailJobs`). */
const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerCitasEmailDispatchInline` (disparo inline, ver abajo) no duplique la
 *  llamada a `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA
 *  función abre su propia sesión de sistema (correcto para el cron, que no
 *  corre dentro de ninguna transacción de request). */
export async function runCitasEmailDispatch(deps: AppDeps): Promise<EmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const citasRepo = deps.citasRepo(db);
    return dispatchPendingEmailJobs(citasRepo, deps.env.resend);
  });
}

/**
 * Disparo inline best-effort — mismo principio que
 * `@atiende/domain-citas::tryTriggerGoogleSync`: llamar justo después de
 * `tryEnqueueAppointmentEmail` haya encolado (o no) un correo real, pasando el
 * MISMO `citasRepo` ya abierto en la transacción de ESE request (nunca una
 * sesión nueva — una sesión nueva, en su propia transacción Postgres, no vería
 * el INSERT todavía sin commit de la transacción actual, ver comentario largo
 * de dbSession en @atiende/core-auth/src/middleware.ts). Un fallo aquí (Resend
 * caído, RESEND_API_KEY no configurada) NUNCA se propaga al caller HTTP — el
 * correo ya quedó en el outbox y el cron diario (red de seguridad de respaldo,
 * sigue corriendo) lo recoge en la siguiente corrida.
 *
 * Hotfix (auditoría a2, CRÍTICO) — recibe también `db` (el MISMO
 * `TenantDbSession` de `c.get("db")`/`withAppSession`, nunca uno nuevo) para
 * envolver el drenado en `SAVEPOINT`. En TODA ruta de sesión de STAFF
 * (`auth.uid()` no nulo) `citas.claim_email_outbox_batch` lanza SIEMPRE 42501
 * (guard correcto, cross-tenant -- NO se afloja) y, sin este SAVEPOINT, esa
 * excepción deja la transacción de negocio COMPLETA abortada (25P02) hasta un
 * `ROLLBACK TO SAVEPOINT`: el `commit;` del motor sobre una transacción
 * abortada no lanza error (Postgres responde "ROLLBACK" en silencio, ver
 * packages/db/src/managed-postgres-engine.ts), así que la transición de la
 * cita (cancelar/confirmar/completar/no-show) de ESTE MISMO request se pierde
 * con un 2xx. Mismo patrón SAVEPOINT ya usado en
 * `packages/domain-citas/src/postgres-repository.ts::upsertCustomer`. Ver
 * `scripts/verify-correo-inline-sesion-staff/` para la prueba ANTES/DESPUÉS
 * contra Postgres real.
 */
export async function triggerCitasEmailDispatchInline(deps: AppDeps, db: TenantDbSession, citasRepo: CitasRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  await db.exec("SAVEPOINT sp_inline_email_dispatch");
  try {
    const summary = await dispatchPendingEmailJobs(citasRepo, deps.env.resend, { batchSize });
    await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    if (summary.dead > 0) {
      console.error(`citas email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
    }
  } catch (err) {
    try {
      await db.exec("ROLLBACK TO SAVEPOINT sp_inline_email_dispatch");
      await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    } catch (recoveryErr) {
      console.error("citas email-dispatch inline: fallo recuperando el SAVEPOINT (no debería pasar):", recoveryErr);
    }
    console.error("citas email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
  }
}

export function citasEmailDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/citas/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que google-calendar-sync.ts.
    return withHeartbeat(deps, "/internal/citas/email-dispatch", async () => {
      const summary = await runCitasEmailDispatch(deps);

      // HALLAZGO ALTO de la auditoría final: esta ruta respondía SIEMPRE `ok: true`
      // sin importar cuántos jobs fallaran/murieran, así que nadie se enteraba
      // nunca de un fallo real de la corrida diaria. DECISIÓN DOCUMENTADA: se deja
      // el status code en 200 -- Vercel Cron únicamente entiende 200 como "el job
      // corrió" (ver docs/DEPLOY.md#resumen-de-costo-por-plataforma), y este
      // barrido ya aísla cada job fallido del resto del lote por diseño. La
      // corrección real es LOGUEAR estructurado con severidad `error` cuando hubo
      // fallos/jobs muertos -- consumible por cualquier integración de logs.
      if (summary.failed > 0 || summary.dead > 0) {
        logEvent(c, "error", "citas_email_dispatch_cron_con_fallos", {
          processed: summary.processed,
          failed: summary.failed,
          dead: summary.dead,
          errors: summary.errors.map((e) => ({ job_id: e.jobId, error: e.error })),
        });
      }

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
