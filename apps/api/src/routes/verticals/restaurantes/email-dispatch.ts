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
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo criterio que INLINE_BATCH_SIZE de citas/email-dispatch.ts. */
const INLINE_BATCH_SIZE = 5;

/** Cuerpo real de la ruta de cron — extraído para que
 *  `triggerRestaurantesEmailDispatchInline` no duplique la llamada a
 *  `dispatchPendingEmailJobs`; a diferencia del disparo inline, ESTA función
 *  abre su propia sesión de sistema (correcto para el cron). */
export async function runRestaurantesEmailDispatch(deps: AppDeps): Promise<EmailDispatchSummary> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const restaurantesRepo = deps.restaurantesRepo(db);
    return dispatchPendingEmailJobs(restaurantesRepo, deps.env.resend);
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
 */
export async function triggerRestaurantesEmailDispatchInline(deps: AppDeps, restaurantesRepo: RestaurantesRepository, batchSize: number = INLINE_BATCH_SIZE): Promise<void> {
  try {
    const summary = await dispatchPendingEmailJobs(restaurantesRepo, deps.env.resend, { batchSize });
    if (summary.dead > 0) {
      console.error(`restaurantes email-dispatch inline: ${summary.dead} correo(s) quedaron 'dead' en el drenado inline.`);
    }
  } catch (err) {
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
    const summary = await runRestaurantesEmailDispatch(deps);

    // HALLAZGO ALTO de la auditoría final — mismo criterio documentado en
    // citas/email-dispatch.ts: se deja el status code en 200 (contrato de Vercel
    // Cron), la corrección real es loguear estructurado con severidad `error`.
    if (summary.failed > 0 || summary.dead > 0) {
      console.error("restaurantes email-dispatch: corrida de cron con fallos", {
        severity: "error",
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
  });

  return app;
}
