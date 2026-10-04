// R-11 -- POST/GET /internal/restaurantes/promover-programados: promueve a `pending` los pedidos programados
// cuya hora ya esta dentro de la anticipacion, en TODAS las organizaciones (barrido de sistema).
//
// Es un cron de `vercel.json` (cada 5 minutos, ver docs/CRONS.md): la promocion de cada organizacion tambien ocurre
// cuando su panel consulta los pedidos (ver admin-orders.ts), pero sin este barrido un pedido programado no se
// promueve si nadie tiene el panel abierto. Va envuelto en `withHeartbeat` (latido en /superadmin/salud + kill switch
// por cron). Mismo guard que el resto de rutas internas: `x-atiende-internal-secret` o
// `Authorization: Bearer <CRON_SECRET>`.
//
// QA-restaurantes-R1-automatizacion-02: ademas de lo recien promovido, CADA corrida reconcilia los pedidos promovidos en
// las ultimas 24 h cuya comanda nunca llego al outbox del POS (un fallo transitorio al encolar la dejaba perdida para
// siempre, porque ninguna corrida volvia a tomar pedidos ya promovidos). Y una corrida con comandas que fallaron deja
// el latido y la bitacora en error/parcial (`CronPartialFailureError`), no en 'ok'. Avisos in-app (campana) de entrada
// a cocina y de pedido atrasado: ver programados-avisos.ts.
//
// Idempotente: una segunda llamada (o dos simultaneas) no promueve dos veces el mismo pedido ni toca uno
// cancelado (la funcion SQL solo actualiza filas en `programado`). Abre su PROPIA sesion de sistema (la
// funcion `restaurantes.promover_pedidos_programados` con organizacion nula solo la acepta esa sesion).
import { Hono } from "hono";
import { barrerAvisosOperativos, promoverProgramadosTodasLasOrganizaciones } from "@atiende/domain-restaurantes";
import type { ResultadoBarridoAvisos } from "@atiende/domain-restaurantes";
import { encolarComandasDePromovidos } from "@atiende/domain-restaurantes/softrestaurant";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";
import { avisarPromovidosEnCocinaBestEffort } from "./programados-avisos.ts";
import { softRestaurantComandaDeps } from "./softrestaurant-wiring.ts";

/** Ventana (horas) y tope por corrida de la reconciliacion de comandas perdidas. */
const RECONCILIAR_HORAS = 24;
const RECONCILIAR_LIMITE = 100;

const SIN_COMANDAS = { intentados: 0, encoladas: 0, omitidas: 0, errores: 0 };

export function restaurantesProgramadosInternoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/restaurantes/promover-programados", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, "/internal/restaurantes/promover-programados", async () => {
      const resultado = await deps.engine.withAppSession({ userId: null }, (db) => promoverProgramadosTodasLasOrganizaciones(deps.restaurantesRepo(db)));
      logEvent(c, "info", "restaurantes_programados_promovidos", { promovidos: resultado.promovidos.length, disponible: resultado.disponible });
      // Aviso in-app (campana): entran a cocina (o entran atrasados). Best-effort, en su propia sesion.
      const avisosCocina = await avisarPromovidosEnCocinaBestEffort(deps, resultado.promovidos);
      // R-29: encola la comanda al POS de lo recien promovido, en OTRA sesion de sistema (la promocion ya quedo
      // confirmada; un fallo aqui nunca la revierte). Idempotente: reintentar el endpoint no duplica filas.
      let comandas = SIN_COMANDAS;
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
      // QA-02: reconciliacion de comandas perdidas de corridas anteriores (o de la promocion desde el panel). Una sesion
      // para consultar y OTRA para encolar: un error de la consulta (base sin la 046) no toca la transaccion de encolado.
      let reconciliacion = SIN_COMANDAS;
      try {
        const yaAtendidos = new Set(resultado.promovidos.map((o) => o.id));
        const pendientes = (await deps.engine.withAppSession({ userId: null }, (db) => deps.restaurantesRepo(db).listPromotedOrdersWithoutComanda({ hours: RECONCILIAR_HORAS, limit: RECONCILIAR_LIMITE }))).filter(
          (o) => !yaAtendidos.has(o.id),
        );
        if (pendientes.length > 0) {
          reconciliacion = await deps.engine.withAppSession({ userId: null }, (db) =>
            encolarComandasDePromovidos(softRestaurantComandaDeps(deps, db, deps.restaurantesRepo(db)), pendientes, { cualquierEstadoVivo: true }),
          );
          logEvent(c, "info", "restaurantes_programados_comandas_reconciliadas", { ...reconciliacion });
        }
      } catch (err) {
        logEvent(c, "error", "restaurantes_programados_reconciliacion_fallida", { error: err instanceof Error ? err.message : String(err) });
        reconciliacion = { ...SIN_COMANDAS, errores: 1 };
      }
      let avisos: ResultadoBarridoAvisos = { disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 };
      try {
        avisos = await deps.engine.withAppSession({ userId: null }, (db) => barrerAvisosOperativos(db, { now: new Date() }));
      } catch (err) {
        logEvent(c, "error", "restaurantes_avisos_operativos_fallidos", { error: err instanceof Error ? err.message : String(err) });
        avisos = { ...avisos, errores: 1 };
      }
      logEvent(c, "info", "restaurantes_avisos_operativos", { ...avisos });
      const respuesta = c.json({
        ok: true,
        status: resultado.disponible ? "ok" : "not_available",
        promoted: resultado.promovidos.length,
        orderIds: resultado.promovidos.map((o) => o.id),
        comandas,
        reconciliacion,
        avisosCocina,
        avisos,
      });
      // Una corrida con comandas que no se pudieron encolar NO es 'ok': el latido y la bitacora la marcan (el cron no
      // reintenta por HTTP; la proxima corrida reconcilia).
      const errores = comandas.errores + reconciliacion.errores;
      if (errores > 0) throw new CronPartialFailureError(`${errores} comanda(s) de pedidos promovidos no se pudieron encolar al POS`, respuesta);
      return respuesta;
    })();
  });

  return app;
}
