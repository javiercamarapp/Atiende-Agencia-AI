// Tick del autopiloto (migracion 050): corre dentro del tick existente de /internal/restaurantes/promover-programados (cada 5 min; SIN cron nuevo).
// Cada paso abre su PROPIA sesion de sistema (una transaccion por unidad): un fallo en un paso no revierte ni frena a los demas, y dentro de cada
// paso cada pedido/handoff va en su savepoint. Todo es idempotente (compare-and-set en la base + claves de dedupe), asi que reintentar el tick,
// o que dos instancias corran a la vez, no duplica ni transiciones ni avisos. Sin la migracion 050 cada paso responde `disponible: false`.
import type { Context } from "hono";
import {
  aplicarEstadosSinClic,
  avanzarDesdePos,
  devolverHandoffsVencidos,
  escalarSolicitudesVencidas,
  reponerAgotadosDelDia,
} from "@atiende/domain-restaurantes";
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
  readonly agotadosRepuestos: number;
  readonly errores: number;
}

export async function barrerAutopilotoTick(deps: AppDeps, c: Context, ahora: Date): Promise<ResumenTickAutopiloto> {
  const resumen = { disponible: false, escaladas: 0, estadosAplicados: 0, posAvanzadas: 0, posSinAdaptadorReal: false, handoffsDevueltos: 0, agotadosRepuestos: 0, errores: 0 };
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

  const escalado = await paso("escalar", (s) => escalarSolicitudesVencidas(s, ahora));
  const estados = await paso("estados", (s) => aplicarEstadosSinClic(s, ahora));
  const pos = await paso("pos", (s) => avanzarDesdePos(s, softRestaurantPortFor(deps), (propertyId) => (deps.softRestaurantMapeo?.resolverSucursal ?? crearResolverSucursalPos())({ propertyId, nombre: null })));
  const handoffs = await paso("handoffs", (s) => devolverHandoffsVencidos(s, ahora));
  const agotados = await paso("agotados", (s) => reponerAgotadosDelDia(s, ahora));

  const disponible = [escalado, estados, handoffs, agotados].some((r) => r?.disponible === true);
  const salida: ResumenTickAutopiloto = {
    disponible,
    escaladas: escalado?.escaladas ?? 0,
    estadosAplicados: estados?.aplicados ?? 0,
    posAvanzadas: pos?.avanzadas ?? 0,
    posSinAdaptadorReal: pos?.sinAdaptadorReal ?? false,
    handoffsDevueltos: handoffs?.devueltos ?? 0,
    agotadosRepuestos: agotados?.repuestos ?? 0,
    errores: resumen.errores,
  };
  logEvent(c, "info", "restaurantes_autopiloto_tick", { ...salida });
  if (agotados && agotados.repuestos > 0) logEvent(c, "info", "restaurantes_agotados_repuestos", { cantidad: agotados.repuestos });
  return salida;
}
