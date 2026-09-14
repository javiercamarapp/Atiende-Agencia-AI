// Fase 6 §3 — POST /internal/citas/email-dispatch: drena el canal `email` de
// `citas.messaging_outbox` vía Resend (mismo patrón/guard que
// google-calendar-sync.ts y reminders.ts — header x-atiende-internal-secret,
// pensada para un scheduler externo). Fail-closed real: sin RESEND_API_KEY
// configurada (deps.env.resend.apiKey === null), cada job falla explícito — la
// ruta responde 200 igual (el fallo por job ya quedó reflejado en el resumen;
// esto es un barrido periódico, no una operación que deba tumbar el scheduler)
// pero NUNCA marca ningún job 'sent' sin que Resend en verdad lo haya aceptado.
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasEmailDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/internal/citas/email-dispatch", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

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
