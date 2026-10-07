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
// a cocina y de pedido atrasado: ver packages/domain-restaurantes/src/pedidos-programados-avisos.ts. Borradores de campana de reactivacion: ver
// packages/domain-restaurantes/src/marketing/campanas.ts (migracion 052).
//
// Idempotente: una segunda llamada (o dos simultaneas) no promueve dos veces el mismo pedido ni toca uno
// cancelado (la funcion SQL solo actualiza filas en `programado`). Abre su PROPIA sesion de sistema (la
// funcion `restaurantes.promover_pedidos_programados` con organizacion nula solo la acepta esa sesion).
import { Hono } from "hono";
import { avisarProgramadosPromovidos, barrerAvisosOperativos, barrerSilencioWhatsapp, esPromocionAtrasada, generarBorradoresMarketing, promoverProgramadosTodasLasOrganizaciones } from "@atiende/domain-restaurantes";
import type { ResultadoBarridoAvisos, ResultadoBorradores, ResultadoSilencio } from "@atiende/domain-restaurantes";
import { encolarComandasDePromovidos } from "@atiende/domain-restaurantes/softrestaurant";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";
import { softRestaurantComandaDeps } from "./softrestaurant-wiring.ts";
import { barrerAutopilotoTick } from "./autopiloto-tick.ts";
import type { ResumenTickAutopiloto } from "./autopiloto-tick.ts";

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
      // Reactivacion de inactivos (autopiloto 2): arma los BORRADORES de campana (nunca envia: aprobar es un clic del dueño) y avisa en la
      // campana. Misma regla que el resto de unidades del tick: su PROPIA sesion de sistema, un fallo no toca la promocion ni las comandas.
      // Apagado por omision (solo organizaciones con marketing_config.activo); idempotente por organizacion + segmento + dia.
      let marketing: ResultadoBorradores = { disponible: false, borradores: 0, avisos: { emitidas: 0, sinNuevas: 0, errores: 0 } };
      try {
        marketing = await deps.engine.withAppSession({ userId: null }, (db) => generarBorradoresMarketing(db, new Date()));
      } catch (err) {
        logEvent(c, "error", "restaurantes_marketing_borradores_fallidos", { error: err instanceof Error ? err.message : String(err) });
      }
      logEvent(c, "info", "restaurantes_marketing_borradores", { ...marketing });
      // Alerta al dueño «WhatsApp silencioso» (autopiloto 2): otra unidad independiente del mismo tick, con el reloj absoluto (el dedupe usa el dia de
      // Merida). Una falla solo se registra: no toca la promocion, las comandas ni los demas avisos.
      let silencio: ResultadoSilencio = { disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 };
      try {
        silencio = await deps.engine.withAppSession({ userId: null }, (db) => barrerSilencioWhatsapp(db, { now: new Date() }));
      } catch (err) {
        logEvent(c, "error", "restaurantes_whatsapp_silencio_fallido", { error: err instanceof Error ? err.message : String(err) });
      }
      logEvent(c, "info", "restaurantes_whatsapp_silencio", { ...silencio });
      // Autopiloto (migracion 050): escalado de aprobaciones sin respuesta, estados sin clic, avance desde el POS, regreso de handoffs y agotados
      // por hoy. Cada paso en su propia sesion de sistema; sin la migracion cada uno responde `disponible: false` (sin error).
      let autopiloto: ResumenTickAutopiloto | null = null;
      let autopilotoFallo = false;
      try {
        autopiloto = await barrerAutopilotoTick(deps, c, new Date());
      } catch (err) {
        autopilotoFallo = true;
        logEvent(c, "error", "restaurantes_autopiloto_tick_fallido", { error: err instanceof Error ? err.message : String(err) });
      }
      const respuesta = c.json({
        ok: true,
        status: resultado.disponible ? "ok" : "not_available",
        promoted: resultado.promovidos.length,
        orderIds: resultado.promovidos.map((o) => o.id),
        comandas,
        reconciliacion,
        avisosCocina,
        atrasadosCocina: resultado.promovidos.filter((o) => esPromocionAtrasada(o)).length,
        avisos,
        marketing,
        silencio,
        autopiloto,
      });
      // Una corrida con comandas que no se pudieron encolar NO es 'ok': el latido y la bitacora la marcan (el cron no
      // reintenta por HTTP; la proxima corrida reconcilia). QA R2 automatizacion-06: lo mismo para los pasos del autopiloto, el barrido de
      // avisos operativos y el aviso de cocina; si un paso falla en cada tick (timeout de sentencia, bloqueo, regresion SQL) el panel de
      // salud debe verlo, no mostrar el cron sano. Si el autopiloto entero lanzo (autopiloto === null con repo cableado) cuenta como 1.
      const partes: string[] = [];
      const erroresComandas = comandas.errores + reconciliacion.errores;
      if (erroresComandas > 0) partes.push(`${erroresComandas} comanda(s) de pedidos promovidos no se pudieron encolar al POS`);
      if (avisos.errores > 0) partes.push(`${avisos.errores} alerta(s) operativa(s) fallaron`);
      if (avisosCocina.errores > 0) partes.push(`${avisosCocina.errores} aviso(s) de cocina fallaron`);
      if (autopilotoFallo) partes.push("el autopiloto fallo");
      else if (autopiloto && autopiloto.errores > 0) partes.push(`${autopiloto.errores} paso(s) del autopiloto fallaron`);
      if (partes.length > 0) throw new CronPartialFailureError(partes.join("; "), respuesta);
      return respuesta;
    })();
  });

  return app;
}
