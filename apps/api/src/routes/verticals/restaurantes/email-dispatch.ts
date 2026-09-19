// Hallazgo de auditoría (severidad MEDIA, "restaurantes no envía ningún correo:
// sin plantilla, sin dispatcher, sin remitente — solo WhatsApp"): POST/GET
// /internal/restaurantes/email-dispatch drena el canal `email` de
// `restaurantes.messaging_outbox` vía Resend — mismo patrón/guard EXACTO que
// `apps/api/src/routes/verticals/citas/email-dispatch.ts` (Fase 6 §3 citas), la
// primera vertical en resolver este mismo gap. Fail-closed real: sin
// RESEND_API_KEY configurada (deps.env.resend.apiKey === null), cada job falla
// explícito — la ruta responde 200 igual (el fallo por job ya quedó reflejado
// en el resumen; esto es un barrido periódico, no una operación que deba tumbar
// el scheduler) pero NUNCA marca ningún job 'sent' sin que Resend en verdad lo
// haya aceptado.
//
// Wiring real del scheduler: `vercel.json::crons` invoca este mismo path por
// GET (única frecuencia/método real que permite el plan Hobby de Vercel, ver
// docs/DEPLOY.md#resumen-de-costo-por-plataforma) con
// `Authorization: Bearer <CRON_SECRET>`. `internalOrCronSecretMatches` acepta
// esa forma además del header manual `x-atiende-internal-secret` que ya usan
// los tests/invocaciones manuales — mismo secreto (`INTERNAL_SECRET`), dos
// formas de mandarlo.
//
// CLUSTER #3 de la auditoría final (CRÍTICO, mismo hallazgo raíz que
// routes/internal/whatsapp-dispatch.ts): este cron diario sigue siendo la red de
// seguridad de respaldo, pero YA NO es el único disparador —
// apps/api/src/routes/verticals/restaurantes/public.ts (crea el pedido, que
// internamente encola `order.created.email` vía `tryNotifyCustomerOrderConfirmationEmail`)
// y whatsapp.ts (el agente puede crear un pedido dentro de la conversación)
// llaman `triggerRestaurantesEmailDispatchInline` (exportado abajo) justo
// después, en la MISMA transacción/repo, para intentar el envío YA en vez de
// esperar al cron.
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-restaurantes";
import type { EmailDispatchSummary, RestaurantesRepository } from "@atiende/domain-restaurantes";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo criterio que INLINE_BATCH_SIZE de citas/email-dispatch.ts. */
export const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerRestaurantesEmailDispatchInline` no duplique la llamada a
 *  `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA función
 *  abre su propia sesión de sistema (correcto para el cron).
 *
 * Fix a2b (parte B) -- `batchSize` opcional, mismo criterio que
 * `runHotelesEmailDispatch`. Restaurantes no encola este drenado en
 * `postCommitTasks` -- sus 2 call sites reales del disparo inline
 * (`public.ts::createOrder`, `whatsapp.ts`) ya corren en sesión de sistema
 * propia, ver comentario de `triggerRestaurantesEmailDispatchInline`. */
export async function runRestaurantesEmailDispatch(deps: AppDeps, batchSize?: number): Promise<EmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const restaurantesRepo = deps.restaurantesRepo(db);
    return dispatchPendingEmailJobs(restaurantesRepo, deps.env.resend, { batchSize });
  });
}

/**
 * Disparo inline best-effort — mismo principio que
 * `triggerCitasEmailDispatchInline` de citas/email-dispatch.ts: llamar justo
 * después de que `createOrder` haya encolado (o no) la confirmación por correo
 * al cliente, pasando el MISMO `restaurantesRepo` ya abierto en la transacción
 * de ESE request (nunca una sesión nueva, ver comentario de cabecera de esa
 * función gemela). Un fallo aquí NUNCA se propaga al caller HTTP — el correo ya
 * quedó en el outbox y el cron diario (red de seguridad de respaldo) lo recoge
 * después.
 *
 * Hotfix (auditoría a2, CRÍTICO) — recibe también `db` (el MISMO
 * `TenantDbSession` de `withAppSession`, nunca uno nuevo) para envolver el
 * drenado en `SAVEPOINT`. Los 2 call sites reales de esta función hoy
 * (`public.ts::createOrder`, `whatsapp.ts`) YA corren en sesión de SISTEMA
 * (`auth.uid()` null, guard pasa sin problema -- ver
 * auditoria-a2-resultado.json::refuted, "Alcance a restaurantes public.ts:129
 * createOrder"), así que este SAVEPOINT es defensa en profundidad (misma
 * función que las otras 5 verticales, protegida igual por si un futuro call
 * site la invoca desde sesión de staff), no la corrección de un bug activo en
 * restaurantes.
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
 * el ROLLBACK real) en un 2xx con la escritura de negocio de ESTE MISMO
 * request perdida: sin savepoint que recuperar, el `commit;` final de
 * `managed-postgres-engine.ts` sobre la transacción abortada se convierte en
 * un ROLLBACK silencioso. Ahora se distingue con `savepointTaken`: si el
 * SAVEPOINT mismo falla (nunca llegó a tomarse), no hay nada que este
 * trigger pueda proteger con un `ROLLBACK TO SAVEPOINT` -- se RELANZA, para
 * que el caller reciba el 5xx honesto. Solo cuando el SAVEPOINT SÍ se tomó
 * (la transacción estaba sana al entrar) y el fallo ocurre DESPUÉS se hace
 * el `ROLLBACK TO SAVEPOINT` best-effort sin relanzar -- ese es el único
 * caso que este SAVEPOINT existe para aislar.
 */
export async function triggerRestaurantesEmailDispatchInline(deps: AppDeps, db: TenantDbSession, restaurantesRepo: RestaurantesRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  let savepointTaken = false;
  try {
    await db.exec("SAVEPOINT sp_inline_email_dispatch");
    savepointTaken = true;
    const summary = await dispatchPendingEmailJobs(restaurantesRepo, deps.env.resend, { batchSize });
    await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    if (summary.dead > 0) {
      console.error(`restaurantes email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
    }
  } catch (err) {
    if (!savepointTaken) {
      console.error("restaurantes email-dispatch inline: la transacción ya venía abortada antes de este trigger, relanzando:", err);
      throw err;
    }
    try {
      await db.exec("ROLLBACK TO SAVEPOINT sp_inline_email_dispatch");
      await db.exec("RELEASE SAVEPOINT sp_inline_email_dispatch");
    } catch (recoveryErr) {
      console.error("restaurantes email-dispatch inline: fallo recuperando el SAVEPOINT (no debería pasar):", recoveryErr);
    }
    console.error("restaurantes email-dispatch inline: fallo best-effort, el cron diario lo recogerá:", err);
  }
}

export function restaurantesEmailDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/restaurantes/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que citas/google-calendar-sync.ts.
    return withHeartbeat(deps, "/internal/restaurantes/email-dispatch", async () => {
      const summary = await runRestaurantesEmailDispatch(deps);

      // HALLAZGO ALTO de la auditoría final — mismo criterio documentado en
      // citas/email-dispatch.ts: se deja el status code en 200 (contrato de Vercel
      // Cron), la corrección real es loguear estructurado con severidad `error`.
      // Fix a2b (parte A) -- `summary.notConfigured` implica `failed === 0 &&
      // dead === 0` (nunca se llegó a reclamar nada), así que este `if` YA no
      // dispara una alerta falsa cuando falta RESEND_API_KEY -- ver `status`
      // de abajo.
      if (summary.failed > 0 || summary.dead > 0) {
        logEvent(c, "error", "restaurantes_email_dispatch_cron_con_fallos", {
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
