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
import type { CitasRepository } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasRemindersRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/citas/confirmacion-cita", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // r4-fix-crons-transaccion-por-unidad: MISMO patrón exacto que hoteles/
    // night-audit -- YA NO se abre una única `withAppSession` para todo el
    // barrido. Un error SQL real en UNA organización dejaba esa transacción
    // compartida ABORTADA (25P02); las organizaciones siguientes fallaban en
    // cascada, y el COMMIT final -- sobre una transacción abortada -- devolvía
    // `ROLLBACK` sin lanzar, revirtiendo en silencio confirmaciones ya
    // encoladas de organizaciones anteriores. Ahora: una transacción para
    // listar, y UNA transacción POR organización.
    return withHeartbeat(deps, "/internal/citas/confirmacion-cita", async () => {
      const withRepo = <T>(fn: (repo: CitasRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.citasRepo(db)));
      const organizations = await withRepo((repo) => repo.listActiveOrganizations());
      let processed = 0;
      let sent = 0;
      let sentEmail = 0;
      const failures: { organization_id: string; error: string }[] = [];

      // Un tenant con datos raros nunca tumba la corrida completa de los demás — se
      // captura y se sigue, se reporta en `failures[]` (ver diseño §5.3).
      for (const org of organizations) {
        try {
          const summary = await withRepo((repo) => runConfirmacionCitaCore(repo, org.id));
          processed += summary.processed;
          sent += summary.sent;
          sentEmail += summary.sentEmail;
        } catch (err) {
          failures.push({ organization_id: org.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const response = c.json({ ok: failures.length === 0, tenants_checked: organizations.length, processed, sent, sent_email: sentEmail, failures });
      if (failures.length > 0) {
        throw new CronPartialFailureError(`confirmacion-cita: ${failures.length} de ${organizations.length} organizaciones fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
