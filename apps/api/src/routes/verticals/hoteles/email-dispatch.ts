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
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function hotelesEmailDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/hoteles/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que hoteles/night-audit.ts.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const hotelesRepo = deps.hotelesRepo(db);
      const summary = await dispatchPendingEmailJobs(hotelesRepo, deps.env.resend);
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
