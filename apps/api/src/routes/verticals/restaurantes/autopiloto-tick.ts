// Tick del autopiloto (migracion 050): corre dentro del tick existente de /internal/restaurantes/promover-programados (cada 5 min; SIN cron nuevo).
// Cada paso abre su PROPIA sesion de sistema (una transaccion por unidad): un fallo en un paso no revierte ni frena a los demas, y dentro de cada
// paso cada pedido/handoff va en su savepoint. Todo es idempotente (compare-and-set en la base + claves de dedupe), asi que reintentar el tick,
// o que dos instancias corran a la vez, no duplica ni transiciones ni avisos. Sin la migracion 050 cada paso responde `disponible: false`.
import type { Context } from "hono";
import {
  aplicarAvancesPos,
  aplicarEstadosSinClic,
  consultarEstadosPos,
  devolverHandoffsVencidos,
  escalarHandoffsSinTomar,
  escalarSolicitudesVencidas,
  reponerAgotadosDelDia,
} from "@atiende/domain-restaurantes";
import type { ComandaParaAvance, EstadoPosConsultado } from "@atiende/domain-restaurantes";
import type { AutopilotoServicioDeps } from "@atiende/domain-restaurantes";
import { encolarComandasDePromovidos, crearResolverSucursalPos } from "@atiende/domain-restaurantes/softrestaurant";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { softRestaurantComandaDeps, softRestaurantPortFor } from "./softrestaurant-wiring.ts";

export interface ResumenTickAutopiloto {
  readonly disponible: boolean;
  readonly escaladas: number;
  readonly estadosAplicados: number;
  readonly posAvanzadas: number;
  readonly posSinAdaptadorReal: boolean;
  readonly handoffsDevueltos: number;
  /** Tomas PENDIENTES sin tomar que avisaron al owner en este tick (QA R2 viaje-06). */
  readonly handoffsSinTomar: number;
  readonly agotadosRepuestos: number;
  /** Alertas de voz (costo del dia / tasa de error) disparadas por primera vez en esta corrida. */
  readonly alertasVoz: number;
  readonly errores: number;
}

export async function barrerAutopilotoTick(deps: AppDeps, c: Context, ahora: Date): Promise<ResumenTickAutopiloto> {
  const resumen = { disponible: false, escaladas: 0, estadosAplicados: 0, posAvanzadas: 0, posSinAdaptadorReal: false, handoffsDevueltos: 0, handoffsSinTomar: 0, agotadosRepuestos: 0, alertasVoz: 0, errores: 0 };
  const autoFactory = deps.autopilotoRepo;
  if (!autoFactory) return resumen;

  async function paso<T>(nombre: string, fn: (s: AutopilotoServicioDeps) => Promise<T>): Promise<T | null> {
    try {
      return await deps.engine.withAppSession({ userId: null }, (db) => {
        const repo = deps.restaurantesRepo(db);
        return fn({
          auto: autoFactory!(db),
          repo,
          db,
          encolarComandas: (orders) => encolarComandasDePromovidos(softRestaurantComandaDeps(deps, db, repo), orders),
        });
      });
    } catch (err) {
      resumen.errores++;
      logEvent(c, "error", "restaurantes_autopiloto_paso_fallido", { paso: nombre, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async function avanzarDesdePosDelTick(): Promise<{ readonly consultadas: number; readonly avanzadas: number; readonly sinAdaptadorReal: boolean } | null> {
    const port = softRestaurantPortFor(deps);
    if (!port.esReal) return { consultadas: 0, avanzadas: 0, sinAdaptadorReal: true };
    const resolver = deps.softRestaurantMapeo?.resolverSucursal ?? crearResolverSucursalPos();
    const comandas = await paso("pos_leer", (s) => s.auto.comandasParaAvance(50));
    if (!comandas || !comandas.disponible || comandas.valor.length === 0) return comandas ? { consultadas: 0, avanzadas: 0, sinAdaptadorReal: false } : null;
    let consultadas = 0;
    let estados: readonly EstadoPosConsultado[] = [];
    try {
      const r = await consultarEstadosPos(comandas.valor as readonly ComandaParaAvance[], port, (propertyId) => resolver({ propertyId, nombre: null }));
      consultadas = r.consultadas;
      estados = r.estados;
    } catch (err) {
      resumen.errores++;
      logEvent(c, "error", "restaurantes_autopiloto_paso_fallido", { paso: "pos_consultar", error: err instanceof Error ? err.message : String(err) });
    }
    const avanzadas = estados.length > 0 ? await paso("pos_aplicar", (s) => aplicarAvancesPos(s, estados)) : 0;
    return { consultadas, avanzadas: avanzadas ?? 0, sinAdaptadorReal: false };
  }

  const escalado = await paso("escalar", (s) => escalarSolicitudesVencidas(s, ahora));
  const estados = await paso("estados", (s) => aplicarEstadosSinClic(s, ahora));
  // Avance desde el POS en TRES fases (QA R2 automatizacion-07): leer las comandas (sesion 1), preguntar al POS SIN transaccion abierta y con
  // tope por consulta y presupuesto total (la red nunca va dentro de una transaccion), y aplicar lo consultado (sesion 2).
  const pos = await avanzarDesdePosDelTick();
  const handoffs = await paso("handoffs", (s) => devolverHandoffsVencidos(s, ahora));
  const sinTomar = await paso("handoffs_sin_tomar", (s) => escalarHandoffsSinTomar(s, ahora));
  const agotados = await paso("agotados", (s) => reponerAgotadosDelDia(s, ahora));
  // Alertas de voz (paridad A21): se evaluan solas en este mismo tick, sin cron nuevo ni boton.
  const evaluarVoz = deps.vozAlertasSistema;
  const alertasVoz = evaluarVoz ? await paso("alertas_voz", (s) => evaluarVoz(s.db)) : null;

  if (alertasVoz && alertasVoz.errores > 0) resumen.errores++;
  const disponible = [escalado, estados, handoffs, sinTomar, agotados, alertasVoz].some((r) => r?.disponible === true);
  const salida: ResumenTickAutopiloto = {
    disponible,
    escaladas: escalado?.escaladas ?? 0,
    estadosAplicados: estados?.aplicados ?? 0,
    posAvanzadas: pos?.avanzadas ?? 0,
    posSinAdaptadorReal: pos?.sinAdaptadorReal ?? false,
    handoffsDevueltos: handoffs?.devueltos ?? 0,
    handoffsSinTomar: sinTomar?.escalados ?? 0,
    agotadosRepuestos: agotados?.repuestos ?? 0,
    alertasVoz: alertasVoz?.nuevas ?? 0,
    errores: resumen.errores,
  };
  logEvent(c, "info", "restaurantes_autopiloto_tick", { ...salida });
  if (agotados && agotados.repuestos > 0) logEvent(c, "info", "restaurantes_agotados_repuestos", { cantidad: agotados.repuestos });
  return salida;
}
