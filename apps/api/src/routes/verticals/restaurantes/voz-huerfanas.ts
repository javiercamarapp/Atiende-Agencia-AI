// QA-restaurantes-R1-automatizacion-08 -- GET/POST /internal/restaurantes/voz-huerfanas: cierra como `abandonado` las llamadas de voz que quedaron
// abiertas (el worker murio antes de llamar a /cerrar), en TODAS las organizaciones (barrido de sistema). Sin este barrido la llamada quedaba "en curso"
// para siempre y el KPI de voz subestimaba el abandono.
//
// Cron de `vercel.json` (cada 30 minutos, ver docs/CRONS.md), envuelto en `withHeartbeat` (latido en /superadmin/salud + kill switch por cron). Mismo guard que
// el resto de rutas internas: `x-atiende-internal-secret` o `Authorization: Bearer <CRON_SECRET>`. Idempotente: una segunda corrida no encuentra nada.
// Compatibilidad con la base sin migrar: sin la migracion 042 responde 200 con `status: "not_available"` y no cierra nada (nunca un 500).
import { Hono } from "hono";
import { cerrarLlamadasHuerfanas } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function restaurantesVozHuerfanasRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/restaurantes/voz-huerfanas", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, "/internal/restaurantes/voz-huerfanas", async () => {
      const vozRepo = deps.vozRepo;
      if (!vozRepo) return c.json({ ok: true, status: "not_available", closed: 0 });
      const resultado = await deps.engine.withAppSession({ userId: null }, (db) => cerrarLlamadasHuerfanas(vozRepo(db)));
      logEvent(c, "info", "restaurantes_voz_huerfanas_cerradas", { cerradas: resultado.cerradas, disponible: resultado.disponible });
      return c.json({ ok: true, status: resultado.disponible ? "ok" : "not_available", closed: resultado.cerradas });
    })();
  });

  return app;
}
