// Fase 12 hoteles (hallazgo ALTA) — POST/GET /internal/hoteles/email-dispatch:
// drena el canal `email` de `hoteles.messaging_outbox` vía Resend. Mismo patrón
// EXACTO que apps/api/src/routes/verticals/citas/email-dispatch.ts. Fail-closed
// real: sin RESEND_API_KEY configurada (deps.env.resend.apiKey === null), cada
// job falla explícito — la ruta responde 200 igual (el fallo por job ya quedó
// reflejado en el resumen; esto es un barrido periódico, no una operación que deba
// tumbar el scheduler) pero NUNCA marca ningún job 'sent' sin que Resend en
// verdad lo haya aceptado.
//
// Wiring real del scheduler: `vercel.json::crons` invoca este mismo path por GET
// una vez al día (único método/frecuencia que permite el plan Hobby de Vercel, ver
// docs/DEPLOY.md#resumen-de-costo-por-plataforma) con
// `Authorization: Bearer <CRON_SECRET>`. `internalOrCronSecretMatches` acepta esa
// forma además del header manual `x-atiende-internal-secret` que usan los
// tests/invocaciones manuales — mismo secreto (`INTERNAL_SECRET`), dos formas de
// mandarlo.
//
// CLUSTER #3 de la auditoría final (CRÍTICO, mismo hallazgo raíz que
// routes/internal/whatsapp-dispatch.ts): este cron diario sigue siendo la red de
// seguridad de respaldo, pero YA NO es el único disparador — cada acción de
// apps/api/src/routes/verticals/hoteles/{folios,reservas,cfdi}.ts que encola un
// correo real (`tryEnqueueGuestEmail`) llama `triggerHotelesEmailDispatchInline`
// (exportado abajo) justo después, en la MISMA transacción/repo, para intentar
// el envío YA en vez de esperar al cron.
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-hoteles";
import type { HotelesEmailDispatchSummary, HotelesRepository } from "@atiende/domain-hoteles";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo criterio que INLINE_BATCH_SIZE de citas/email-dispatch.ts. */
const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerHotelesEmailDispatchInline` no duplique la llamada a
 *  `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA función
 *  abre su propia sesión de sistema (correcto para el cron). */
export async function runHotelesEmailDispatch(deps: AppDeps): Promise<HotelesEmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const hotelesRepo = deps.hotelesRepo(db);
    return dispatchPendingEmailJobs(hotelesRepo, deps.env.resend);
  });
}

/**
 * Disparo inline best-effort — mismo principio que
 * `triggerCitasEmailDispatchInline` de citas/email-dispatch.ts: llamar justo
 * después de que `tryEnqueueGuestEmail` haya encolado (o no) un correo real,
 * pasando el MISMO `hotelesRepo` ya abierto en la transacción de ESE request
 * (nunca una sesión nueva, ver comentario de cabecera de esa función gemela).
 * Un fallo aquí NUNCA se propaga al caller HTTP — el correo ya quedó en el
 * outbox y el cron diario (red de seguridad de respaldo) lo recoge después.
 *
 * Hotfix (auditoría a2, CRÍTICO) — recibe también `db` (el MISMO
 * `TenantDbSession` de `c.get("db")`/`withAppSession`, nunca uno nuevo) para
 * envolver el drenado en `SAVEPOINT`. En TODA ruta de sesión de STAFF
 * (`auth.uid()` no nulo) `hoteles.claim_email_outbox_batch` lanza SIEMPRE
 * 42501 (guard correcto, cross-tenant -- NO se afloja) y, sin este SAVEPOINT,
 * esa excepción deja la transacción de negocio COMPLETA abortada (25P02) hasta
 * un `ROLLBACK TO SAVEPOINT`: el `commit;` del motor sobre una transacción
 * abortada no lanza error (Postgres responde "ROLLBACK" en silencio, ver
 * packages/db/src/managed-postgres-engine.ts), así que la escritura de negocio
 * de ESTE MISMO request (folio cerrado, reserva creada...) se pierde con un
 * 2xx -- o, si la ruta corre dentro de `repo.withIdempotency` (reservas.ts/
 * cfdi.ts), la siguiente consulta de esa transacción falla con 25P02 y el
 * cliente recibe 500. Mismo patrón SAVEPOINT ya usado en
 * `packages/domain-citas/src/postgres-repository.ts::upsertCustomer`. Ver
 * `scripts/verify-correo-inline-sesion-staff/` para la prueba ANTES/DESPUÉS
 * contra Postgres real.
 */
export async function triggerHotelesEmailDispatchInline(deps: AppDeps, db: TenantDbSession, hotelesRepo: HotelesRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  await db.exec("SAVEPOINT sp_inline_email_dispatch");
  try {
    const summary = await dispatchPendingEmailJobs(hotelesRepo, deps.env.resend, { batchSize });
    await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    if (summary.dead > 0) {
      console.error(`hoteles email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
    }
  } catch (err) {
    // Cubre TANTO el 42501 determinista de sesión de staff (ver arriba) COMO
    // cualquier otro error real de Postgres/Resend -- ambos dejan la
    // transacción igual de abortada y necesitan el mismo ROLLBACK TO SAVEPOINT
    // para que el resto del request (incluido el `commit;` final) pueda seguir
    // usando la sesión con normalidad.
    try {
      await db.exec("ROLLBACK TO SAVEPOINT sp_inline_email_dispatch");
      await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    } catch (recoveryErr) {
      console.error("hoteles email-dispatch inline: fallo recuperando el SAVEPOINT (no debería pasar):", recoveryErr);
    }
    console.error("hoteles email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
  }
}

export function hotelesEmailDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/hoteles/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que hoteles/night-audit.ts.
    return withHeartbeat(deps, "/internal/hoteles/email-dispatch", async () => {
      const summary = await runHotelesEmailDispatch(deps);

      // HALLAZGO ALTO de la auditoría final — mismo criterio documentado en
      // citas/email-dispatch.ts: se deja el status code en 200 (contrato de Vercel
      // Cron), la corrección real es loguear estructurado con severidad `error`.
      if (summary.failed > 0 || summary.dead > 0) {
        logEvent(c, "error", "hoteles_email_dispatch_cron_con_fallos", {
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
