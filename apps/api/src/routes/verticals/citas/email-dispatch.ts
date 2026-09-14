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
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasEmailDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/citas/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que google-calendar-sync.ts.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const summary = await dispatchPendingEmailJobs(citasRepo, deps.env.resend);
      return c.json({
        ok: true,
        processed: summary.processed,
        sent: summary.sent,
        failed: summary.failed,
        dead: summary.dead,
        errors: summary.errors.map((e) => ({ job_id: e.jobId, error: e.error })),
      });
    });
  });

  return app;
}
