// R-15 -- GET|POST /internal/restaurantes/repartidor-licencias: barrido que avisa en la campana de owner/admin las licencias de
// repartidor vencidas o a menos de 30 dias (`restaurantes.repartidor.licencia_por_vencer` / `licencia_vencida`).
//
// Agendado en `vercel.json` (diario, 13:35 UTC = 07:35 en Merida), detenible por interruptor (SWITCHABLE_CRONS) y con latido
// (`withHeartbeat`). Vercel Cron lo invoca por GET con `Authorization: Bearer <CRON_SECRET>`; tambien acepta POST y
// `x-atiende-internal-secret`. Ademas, el aviso sale al guardar el perfil. Si algun aviso falla, la respuesta sigue siendo 200 con el
// conteo y el latido queda en error (`CronPartialFailureError`).
// Idempotente: dedupe mensual por repartidor (clave de la notificacion). UNA transaccion por repartidor: un fallo no frena a los demas.
// Sin PII. Contra la base sin migrar responde `status: "not_available"` (200), nunca un 500.
import { Hono } from "hono";
import { LICENCIA_AVISO_DIAS, hoyUtc, notificarLicenciaRepartidor } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export const REPARTIDOR_LICENCIAS_CRON_PATH = "/internal/restaurantes/repartidor-licencias";

export function restaurantesRepartidorLicenciasInternoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], REPARTIDOR_LICENCIAS_CRON_PATH, async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, REPARTIDOR_LICENCIAS_CRON_PATH, async () => {
      if (!deps.repartidorPerfilRepo) throw Errors.serviceUnavailable("El perfil del repartidor no está disponible en este despliegue.");
      const perfilRepo = deps.repartidorPerfilRepo;

      const lista = await deps.engine.withAppSession({ userId: null }, (db) => perfilRepo(db).licenciasPorVencer(LICENCIA_AVISO_DIAS));
      if (!lista.disponible) return c.json({ ok: true, status: "not_available", revisadas: 0, avisos: 0, fallos: 0 });

      const hoy = hoyUtc(new Date());
      let avisos = 0;
      let fallos = 0;
      for (const l of lista.valor) {
        try {
          // Una transaccion por repartidor: si falla, solo se revierte ese aviso.
          const emitido = await deps.engine.withAppSession({ userId: null }, (db) =>
            notificarLicenciaRepartidor(db, { organizationId: l.organizationId, userId: l.userId, diasRestantes: l.diasRestantes, hoy }),
          );
          if (emitido) avisos++;
        } catch (err) {
          fallos++;
          logEvent(c, "error", "restaurantes_licencias_barrido_fallo", { error: err instanceof Error ? err.message.slice(0, 200) : "error" });
        }
      }
      logEvent(c, "info", "restaurantes_licencias_barrido", { revisadas: lista.valor.length, avisos, fallos });
      const respuesta = c.json({ ok: fallos === 0, status: "ok", revisadas: lista.valor.length, avisos, fallos });
      if (fallos > 0) throw new CronPartialFailureError(`repartidor-licencias: fallaron ${fallos} avisos`, respuesta);
      return respuesta;
    })();
  });

  return app;
}
