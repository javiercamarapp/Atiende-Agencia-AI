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
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function rentasEmailDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/email-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que ical-sync-cron.ts.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const rentasRepo = deps.rentasRepo(db);
      const summary = await dispatchPendingEmailJobs(rentasRepo, deps.env.resend);
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
