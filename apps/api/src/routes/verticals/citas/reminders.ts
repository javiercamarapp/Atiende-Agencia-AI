// Flujo 3 — POST /internal/citas/confirmacion-cita (recordatorio 24h, == el agente
// agente-recordatorio-citas del origen). Ruta interna, gateada por secreto
// compartido (x-atiende-internal-secret, análogo a CRON_SECRET), pensada para ser
// invocada por un scheduler externo (Vercel Cron / Supabase cron) — no un job de
// apps/worker (ninguna fase anterior lo construyó, ver diseño Fase 1 citas §0.4).
import { Hono } from "hono";
import { runConfirmacionCitaCore } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasRemindersRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/internal/citas/confirmacion-cita", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    const organizations = await deps.citasRepo.listActiveOrganizations();
    let processed = 0;
    let sent = 0;
    const failures: { organization_id: string; error: string }[] = [];

    // Un tenant con datos raros nunca tumba la corrida completa de los demás — se
    // captura y se sigue, se reporta en `failures[]` (ver diseño §5.3).
    for (const org of organizations) {
      try {
        const summary = await runConfirmacionCitaCore(deps.citasRepo, org.id);
        processed += summary.processed;
        sent += summary.sent;
      } catch (err) {
        failures.push({ organization_id: org.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return c.json({ ok: failures.length === 0, tenants_checked: organizations.length, processed, sent, failures });
  });

  return app;
}
