// Cron `/internal/plataforma/prueba-avisos` (PL-16), lado SISTEMA (sin authMiddleware: lo llama el scheduler o un operador).
// Autenticacion: secreto interno (`INTERNAL_SECRET`) o de cron, comparado en tiempo constante.
//
// Reclama los avisos de fin de prueba que corresponden hoy (7 / 3 / 1 dias, en la zona horaria de cada negocio) y los emite por
// notificacion in-app y correo; cada aviso sale exactamente una vez aunque el cron corra varias veces (ver
// `../../plan-topes/aviso-prueba.ts`). Pensado para correr una vez al dia.
//
// Agendado en vercel.json (diario, 14:00 UTC = 08:00 en Merida), detenible por interruptor (SWITCHABLE_CRONS) y con latido
// (`withHeartbeat`). Vercel Cron lo invoca por GET con `Authorization: Bearer <CRON_SECRET>`. Base sin migrar: responde
// `disponible: false` con 200 (nunca 500) y no toca nada. Si algun aviso falla (`errores > 0`) la respuesta sigue siendo 200 y el
// latido queda en error (`CronPartialFailureError`).
import { Hono } from "hono";
import { Errors } from "../../errors.ts";
import { internalOrCronSecretMatches } from "../../http-security.ts";
import { logEvent } from "../../logger.ts";
import { CronPartialFailureError, withHeartbeat } from "../../salud/with-heartbeat.ts";
import { ejecutarAvisosPrueba } from "../../plan-topes/aviso-prueba.ts";
import type { AppDeps } from "../../deps.ts";

export const PRUEBA_AVISOS_PATH = "/internal/plataforma/prueba-avisos";

export function pruebaAvisosRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], PRUEBA_AVISOS_PATH, async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, PRUEBA_AVISOS_PATH, async () => {
      const resumen = await ejecutarAvisosPrueba(deps);
      if (!resumen.disponible) logEvent(c, "warn", "prueba_avisos_migracion_pendiente", {});
      if (resumen.errores > 0) logEvent(c, "warn", "prueba_avisos_con_errores", { errores: resumen.errores });
      const respuesta = c.json({ ok: true, ...resumen });
      if (resumen.errores > 0) throw new CronPartialFailureError(`prueba-avisos: ${resumen.errores} avisos con error`, respuesta);
      return respuesta;
    })();
  });

  return app;
}
