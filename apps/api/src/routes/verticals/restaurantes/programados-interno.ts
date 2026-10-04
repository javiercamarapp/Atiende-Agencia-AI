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
import { avisarProgramadosPromovidos, barrerAvisosOperativos, promoverProgramadosTodasLasOrganizaciones } from "@atiende/domain-restaurantes";
import type { ResultadoBarridoAvisos } from "@atiende/domain-restaurantes";
import { encolarComandasDePromovidos } from "@atiende/domain-restaurantes/softrestaurant";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";
import { softRestaurantComandaDeps } from "./softrestaurant-wiring.ts";

export function restaurantesProgramadosInternoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/restaurantes/promover-programados", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, "/internal/restaurantes/promover-programados", async () => {
      const resultado = await deps.engine.withAppSession({ userId: null }, (db) => promoverProgramadosTodasLasOrganizaciones(deps.restaurantesRepo(db)));
      logEvent(c, "info", "restaurantes_programados_promovidos", { promovidos: resultado.promovidos.length, disponible: resultado.disponible });
      // R-29: encola la comanda al POS de lo recien promovido, en OTRA sesion de sistema (la promocion ya quedo
      // confirmada; un fallo aqui nunca la revierte). Idempotente: reintentar el endpoint no duplica filas.
      let comandas = { intentados: 0, encoladas: 0, omitidas: 0, errores: 0 };
      if (resultado.promovidos.length > 0) {
        try {
          comandas = await deps.engine.withAppSession({ userId: null }, (db) =>
            encolarComandasDePromovidos(softRestaurantComandaDeps(deps, db, deps.restaurantesRepo(db)), resultado.promovidos),
          );
        } catch (err) {
          logEvent(c, "error", "restaurantes_programados_comanda_fallida", { error: err instanceof Error ? err.message : String(err) });
          comandas = { ...comandas, errores: resultado.promovidos.length };
        }
      }
      // Aviso al staff (bandeja + campana) de que el programado entro a cocina: tambien en su propia sesion, tras el commit
      // de la promocion; idempotente por pedido y nunca revierte nada.
      let avisosCocina = { intentados: 0, bandeja: 0, errores: 0 };
      if (resultado.promovidos.length > 0) {
        try {
          avisosCocina = await deps.engine.withAppSession({ userId: null }, (db) => avisarProgramadosPromovidos(deps.restaurantesRepo(db), db, resultado.promovidos));
        } catch (err) {
          logEvent(c, "error", "restaurantes_programados_aviso_fallido", { error: err instanceof Error ? err.message : String(err) });
          avisosCocina = { ...avisosCocina, errores: resultado.promovidos.length };
        }
      }
      let avisos: ResultadoBarridoAvisos = { disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 };
      try {
        avisos = await deps.engine.withAppSession({ userId: null }, (db) => barrerAvisosOperativos(db, { now: new Date() }));
      } catch (err) {
        logEvent(c, "error", "restaurantes_avisos_operativos_fallidos", { error: err instanceof Error ? err.message : String(err) });
        avisos = { ...avisos, errores: 1 };
      }
      logEvent(c, "info", "restaurantes_avisos_operativos", { ...avisos });
      return c.json({
        ok: true,
        status: resultado.disponible ? "ok" : "not_available",
        promoted: resultado.promovidos.length,
        orderIds: resultado.promovidos.map((o) => o.id),
        comandas,
        avisos,
      });
    })();
  });

  return app;
}
