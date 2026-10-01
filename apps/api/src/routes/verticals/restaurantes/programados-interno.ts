// R-11 -- POST/GET /internal/restaurantes/promover-programados: promueve a `pending` los pedidos programados
// cuya hora ya esta dentro de la anticipacion, en TODAS las organizaciones (barrido de sistema).
//
// Es un cron de `vercel.json` (cada 5 minutos, ver docs/CRONS.md): la promocion de cada organizacion tambien ocurre
// cuando su panel consulta los pedidos (ver admin-orders.ts), pero sin este barrido un pedido programado no se
// promueve si nadie tiene el panel abierto. Va envuelto en `withHeartbeat` (latido en /superadmin/salud + kill switch
// por cron). Mismo guard que el resto de rutas internas: `x-atiende-internal-secret` o
// `Authorization: Bearer <CRON_SECRET>`.
//
// Idempotente: una segunda llamada (o dos simultaneas) no promueve dos veces el mismo pedido ni toca uno
// cancelado (la funcion SQL solo actualiza filas en `programado`). Abre su PROPIA sesion de sistema (la
// funcion `restaurantes.promover_pedidos_programados` con organizacion nula solo la acepta esa sesion).
import { Hono } from "hono";
import { promoverProgramadosTodasLasOrganizaciones } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function restaurantesProgramadosInternoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/restaurantes/promover-programados", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, "/internal/restaurantes/promover-programados", async () => {
      const resultado = await deps.engine.withAppSession({ userId: null }, (db) => promoverProgramadosTodasLasOrganizaciones(deps.restaurantesRepo(db)));
      logEvent(c, "info", "restaurantes_programados_promovidos", { promovidos: resultado.promovidos.length, disponible: resultado.disponible });
      return c.json({
        ok: true,
        status: resultado.disponible ? "ok" : "not_available",
        promoted: resultado.promovidos.length,
        orderIds: resultado.promovidos.map((o) => o.id),
      });
    })();
  });

  return app;
}
