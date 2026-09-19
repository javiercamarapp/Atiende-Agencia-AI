// Flujo 3 — POST/GET /internal/citas/confirmacion-cita (recordatorio 24h, == el
// agente agente-recordatorio-citas del origen). Ruta interna, gateada por secreto
// compartido (x-atiende-internal-secret, análogo a CRON_SECRET), pensada para ser
// invocada por un scheduler externo — no un job de apps/worker (ninguna fase
// anterior lo construyó, ver diseño Fase 1 citas §0.4).
//
// Wiring real del scheduler (cierra el hallazgo "nunca se disparan" del
// auditor): `vercel.json::crons` invoca este mismo path por GET una vez al día
// (plan Hobby de Vercel solo permite frecuencia diaria — cadencia razonable de
// por sí para un recordatorio "24h antes") con `Authorization: Bearer
// <CRON_SECRET>`. `internalOrCronSecretMatches` acepta esa forma además del header
// manual `x-atiende-internal-secret` que ya usaban los tests/invocaciones
// manuales — mismo secreto (`INTERNAL_SECRET`), dos formas de mandarlo.
import { Hono } from "hono";
import { runConfirmacionCitaCore } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasRemindersRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/citas/confirmacion-cita", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- abre su propia
    // sesión de sistema (`userId: null`) para todo el barrido, igual que documenta
    // postgres-repository.ts (ninguna de estas queries depende de un auth.uid() real).
    return withHeartbeat(deps, "/internal/citas/confirmacion-cita", () => deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const organizations = await citasRepo.listActiveOrganizations();
      let processed = 0;
      let sent = 0;
      let sentEmail = 0;
      const failures: { organization_id: string; error: string }[] = [];

      // Un tenant con datos raros nunca tumba la corrida completa de los demás — se
      // captura y se sigue, se reporta en `failures[]` (ver diseño §5.3).
      for (const org of organizations) {
        try {
          const summary = await runConfirmacionCitaCore(citasRepo, org.id);
          processed += summary.processed;
          sent += summary.sent;
          sentEmail += summary.sentEmail;
        } catch (err) {
          failures.push({ organization_id: org.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      return c.json({ ok: failures.length === 0, tenants_checked: organizations.length, processed, sent, sent_email: sentEmail, failures });
    }))();
  });

  return app;
}
