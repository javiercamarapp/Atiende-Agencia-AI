// Cron `/internal/superadmin/resumen-diario` -- genera Y PERSISTE el resumen
// diario automático del día calendario ANTERIOR (America/Mexico_City),
// envuelto en `withHeartbeat` (MISMO patrón que los otros 17 handlers
// `/internal/*`, ver `../../salud/with-heartbeat.ts`). Horario: 09:00
// America/Mexico_City (`15 00 * * *`... ver `vercel.json` -- corre DESPUÉS
// de los 17 crons existentes, todos entre 05:00 y 14:55 UTC, para que el
// resumen refleje el estado ya asentado del día anterior completo).
//
// Idempotente: re-ejecutarlo el mismo día ACTUALIZA el resumen de esa fecha
// (UPSERT por `fecha`), nunca duplica -- ver `core.upsert_daily_ops_
// summary`. El correo (best-effort, opcional) se intenta DESPUÉS de
// persistir, y se manda UNA sola vez por fecha sin importar cuántas veces
// corra este cron (ver `../../resumen-diario/correo.ts`).
import { Hono } from "hono";
import { Errors } from "../../errors.ts";
import { internalOrCronSecretMatches } from "../../http-security.ts";
import { logEvent } from "../../logger.ts";
import { withHeartbeat } from "../../salud/with-heartbeat.ts";
import { fechaAyerMexico } from "../../resumen-diario/motor.ts";
import { generarYPersistirResumenDiario } from "../../resumen-diario/agregador.ts";
import { enviarCorreoResumenDiarioSiCorresponde } from "../../resumen-diario/correo.ts";
import type { AppDeps } from "../../deps.ts";

/** Path EXACTO usado tanto en `vercel.json::crons` como en `withHeartbeat` --
 *  MISMA llave que `../../salud/cadencia.ts::cadenciaMinutosPorRuta` deriva
 *  del mismo `vercel.json` (ver el comentario de ese archivo). */
export const RESUMEN_DIARIO_CRON_PATH = "/internal/superadmin/resumen-diario";

export function resumenDiarioRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], RESUMEN_DIARIO_CRON_PATH, async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, RESUMEN_DIARIO_CRON_PATH, async () => {
      const fecha = fechaAyerMexico(new Date());
      const { agregados, narrativa, generadoPor } = await generarYPersistirResumenDiario(deps, fecha);

      if (agregados.salud.alertas.length > 0) {
        logEvent(c, "warn", "resumen_diario_con_alertas", { fecha, alertas: agregados.salud.alertas.length, criticas: agregados.salud.alertas.filter((a) => a.severidad === "critica").length });
      }

      const correo = await enviarCorreoResumenDiarioSiCorresponde(deps, fecha, agregados, narrativa);

      return c.json({ ok: true, fecha, generadoPor, alertas: agregados.salud.alertas.length, correo: correo.motivo });
    })();
  });

  return app;
}
