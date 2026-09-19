// Fase 9 — GET/POST /internal/rentas/email-dispatch: drena el canal `email` de
// `rentas.messaging_outbox` vía Resend. Mismo patrón/guard EXACTO que
// apps/api/.../hoteles/email-dispatch.ts y .../citas/email-dispatch.ts: acepta GET
// (Vercel Cron, que solo dispara GET con `Authorization: Bearer <CRON_SECRET>`) y
// POST (header manual `x-atiende-internal-secret`/tests), gateada por
// `internalOrCronSecretMatches` (ver comentario de cabecera de
// `http-security.ts::internalOrCronSecretMatches`). Fail-closed real:
// sin RESEND_API_KEY configurada (deps.env.resend.apiKey === null), cada job falla
// explícito — la ruta responde 200 igual (el fallo por job ya quedó reflejado en el
// resumen; esto es un barrido periódico, no una operación que deba tumbar el
// scheduler) pero NUNCA marca ningún job 'sent' sin que Resend en verdad lo haya
// aceptado.
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
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo criterio que INLINE_BATCH_SIZE de hoteles/email-dispatch.ts. */
const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerRentasEmailDispatchInline` no duplique la llamada a
 *  `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA función
 *  abre su propia sesión de sistema (correcto para el cron). */
export async function runRentasEmailDispatch(deps: AppDeps): Promise<RentasEmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const rentasRepo = deps.rentasRepo(db);
    return dispatchPendingEmailJobs(rentasRepo, deps.env.resend);
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
 */
export async function triggerRentasEmailDispatchInline(deps: AppDeps, db: TenantDbSession, rentasRepo: RentasRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  await db.exec("SAVEPOINT sp_inline_email_dispatch");
  try {
    const summary = await dispatchPendingEmailJobs(rentasRepo, deps.env.resend, { batchSize });
    await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    if (summary.dead > 0) {
      console.error(`rentas email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
    }
  } catch (err) {
    try {
      await db.exec("ROLLBACK TO SAVEPOINT sp_inline_email_dispatch");
      await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    } catch (recoveryErr) {
      console.error("rentas email-dispatch inline: fallo recuperando el SAVEPOINT (no debería pasar):", recoveryErr);
    }
    console.error("rentas email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
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
