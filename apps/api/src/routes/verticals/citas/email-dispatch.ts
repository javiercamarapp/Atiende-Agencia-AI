// Fase 6 §3 — POST/GET /internal/citas/email-dispatch: drena el canal `email` de
// `citas.messaging_outbox` vía Resend (mismo patrón/guard que
// google-calendar-sync.ts y reminders.ts). Fail-closed real: sin RESEND_API_KEY
// configurada (deps.env.resend.apiKey === null), fix a2b hace que NINGÚN job
// se reclame -- quedan 'pending' intactos, ver `notConfigured`/
// `INLINE_BATCH_SIZE` abajo. CON la key configurada, cada job que Resend
// rechace falla explícito — la ruta responde 200 igual (el fallo por job ya
// quedó reflejado en el resumen; esto es un barrido periódico, no una
// operación que deba tumbar el scheduler) pero NUNCA marca ningún job 'sent'
// sin que Resend en verdad lo haya aceptado.
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
import { runWithSavepointFallback } from "@atiende/db";
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
 *  `dispatchPendingEmailJobs`). Exportado (fix a2b, parte B) para que el
 *  drenado post-commit de `postCommitTasks` (appointments-lifecycle.ts) lo
 *  use también, en vez del batch completo (25) por defecto. */
export const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerCitasEmailDispatchInline` (disparo inline, ver abajo) no duplique la
 *  llamada a `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA
 *  función abre su propia sesión de sistema (correcto para el cron, que no
 *  corre dentro de ninguna transacción de request).
 *
 * Fix a2b (parte B) -- `batchSize` opcional: el cron real sigue llamando SIN
 * argumento (batch completo, 25), pero el drenado post-commit que
 * `appointments-lifecycle.ts` encola en `postCommitTasks` (ver comentario
 * largo de `dbSession` en `packages/core-auth/src/middleware.ts`, corre con
 * `await` ANTES de que la respuesta del staff se transmita) ahora pasa
 * `INLINE_BATCH_SIZE` explícito -- mismo criterio que ya usaba el disparo
 * inline síncrono de abajo. */
export async function runCitasEmailDispatch(deps: AppDeps, batchSize?: number): Promise<EmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const citasRepo = deps.citasRepo(db);
    return dispatchPendingEmailJobs(citasRepo, deps.env.resend, { batchSize });
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
 *
 * Fix a2b (parte C) — el `exec("SAVEPOINT ...")` ahora corre DENTRO del
 * `try` (antes corría antes, sin protección): si la transacción YA venía
 * abortada por una causa ANTERIOR a este trigger, ese `exec` en sí lanza
 * 25P02 -- sin el `try` alrededor, esa excepción se propagaba tal cual al
 * caller, contradiciendo el "nunca se propaga" de este docstring.
 *
 * Corrección (revisión independiente PR #168) — la versión anterior de este
 * fix tragaba SIEMPRE ese 25P02, incluso cuando la transacción YA venía
 * abortada por una causa AJENA a este trigger (p. ej.
 * `tryEnqueueAppointmentEmail` traga un error de Postgres SIN savepoint
 * propio). Eso convertía un 500 honesto (el `exec` se propagaba sin el
 * `try`, el `catch` de `withAppSession` hacía el ROLLBACK real) en un 2xx
 * con la transición de la cita de ESTE MISMO request perdida: sin savepoint
 * que recuperar, el `commit;` final de `managed-postgres-engine.ts` sobre la
 * transacción abortada se convierte en un ROLLBACK silencioso. Ahora se
 * distingue con `savepointTaken`: si el SAVEPOINT mismo falla (nunca llegó a
 * tomarse), no hay nada que este trigger pueda proteger con un
 * `ROLLBACK TO SAVEPOINT` -- se RELANZA, para que el caller reciba el 5xx
 * honesto. Solo cuando el SAVEPOINT SÍ se tomó (la transacción estaba sana
 * al entrar) y el fallo ocurre DESPUÉS (incluido el 42501 determinista de
 * sesión de staff) se hace el `ROLLBACK TO SAVEPOINT` best-effort sin
 * relanzar -- ese es el único caso que este SAVEPOINT existe para aislar.
 *
 * Consolidación (Fase 2, integridad) — el `SAVEPOINT`/`ROLLBACK TO
 * SAVEPOINT`/`RELEASE SAVEPOINT` manual de arriba (idéntico al de
 * `restaurantes/email-dispatch.ts`, `despachos/notifications.ts` y
 * `licitaciones/alertNotifications.ts`) ahora corre por
 * `runWithSavepointFallback` (`@atiende/db`, mismo helper que ya reutilizan
 * `runWithRowSavepoint` de cada repositorio) en vez de repetir el
 * SAVEPOINT/ROLLBACK a mano: `isRecoverable` fijo en `true` (cualquier error
 * DESPUÉS del SAVEPOINT es best-effort) y `fallback` solo loguea -- nunca
 * relanza -- preservando exactamente la distinción `savepointTaken` de
 * arriba, porque `runWithSavepointFallback` ya relanza el error tal cual
 * cuando el `SAVEPOINT` mismo falla (no llega a invocar `fallback`) y solo
 * corre `fallback` cuando el `ROLLBACK TO SAVEPOINT` de recuperación sí tuvo
 * éxito. Se pasa `savepointName` fijo (no el nombre único por default del
 * helper) para no romper `citas-email-dispatch-savepoint.spec.ts`, que
 * afirma la secuencia exacta de `execCalls` sobre `sp_inline_email_dispatch`.
 */
export async function triggerCitasEmailDispatchInline(deps: AppDeps, db: TenantDbSession, citasRepo: CitasRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  await runWithSavepointFallback<void>({
    session: db,
    savepointName: "sp_inline_email_dispatch",
    primary: async () => {
      const summary = await dispatchPendingEmailJobs(citasRepo, deps.env.resend, { batchSize });
      if (summary.dead > 0) {
        console.error(`citas email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
      }
    },
    isRecoverable: () => true,
    fallback: async (err) => {
      console.error("citas email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
    },
  });
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
      // Fix a2b (parte A) -- `summary.notConfigured` implica `failed === 0 &&
      // dead === 0` (nunca se llegó a reclamar nada), así que este `if` YA no
      // dispara una alerta falsa cuando falta RESEND_API_KEY -- ver `status`
      // de abajo.
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
