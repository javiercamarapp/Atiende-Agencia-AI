// Tick del ciclo operativo del pedido (migraciones 171 y 172): recordatorios de pedidos sin aceptar y envio de encuestas post-entrega. Corre dentro del tick
// existente de /internal/restaurantes/promover-programados (cada 5 min; SIN cron nuevo, sin tocar vercel.json). Cada paso abre su PROPIA sesion de sistema (una
// transaccion por unidad): un fallo en uno no revierte ni frena al otro ni a la promocion de programados. Sin las migraciones cada paso responde `disponible: false`.
import type { Context } from "hono";
import { barrerEncuestas, barrerRecordatorios, descripcionSeguraDeError } from "@atiende/domain-restaurantes";
import type { ResumenBarridoEncuestas, ResumenBarridoRecordatorios } from "@atiende/domain-restaurantes";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

export interface ResumenTickCiclo {
  readonly disponible: boolean;
  readonly recordatorios: ResumenBarridoRecordatorios;
  readonly encuestas: ResumenBarridoEncuestas;
  readonly errores: number;
}

const SIN_RECORDATORIOS: ResumenBarridoRecordatorios = { disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, escaladas: 0, errores: 0 };
const SIN_ENCUESTAS: ResumenBarridoEncuestas = { disponible: false, candidatas: 0, enviadas: 0, enviadasPlantilla: 0, omitidas: 0, esperando: 0, errores: 0 };

export async function barrerCicloPedidoTick(deps: AppDeps, c: Context, ahora: Date): Promise<ResumenTickCiclo> {
  const factory = deps.cicloPedidoRepo;
  if (!factory) return { disponible: false, recordatorios: SIN_RECORDATORIOS, encuestas: SIN_ENCUESTAS, errores: 0 };
  let errores = 0;
  let recordatorios = SIN_RECORDATORIOS;
  let encuestas = SIN_ENCUESTAS;
  try {
    recordatorios = await deps.engine.withAppSession({ userId: null }, (db) => barrerRecordatorios({ repo: deps.restaurantesRepo(db), ciclo: factory(db), db }, ahora));
    errores += recordatorios.errores;
  } catch (err) {
    errores += 1;
    logEvent(c, "error", "restaurantes_ciclo_recordatorios_fallidos", { error: descripcionSeguraDeError(err) });
  }
  try {
    encuestas = await deps.engine.withAppSession({ userId: null }, (db) =>
      barrerEncuestas({ repo: deps.restaurantesRepo(db), ciclo: factory(db), db, plantillasAprobadas: deps.env.whatsappApprovedTemplates ?? [] }, ahora),
    );
    errores += encuestas.errores;
  } catch (err) {
    errores += 1;
    logEvent(c, "error", "restaurantes_ciclo_encuestas_fallidas", { error: descripcionSeguraDeError(err) });
  }
  const resumen: ResumenTickCiclo = { disponible: recordatorios.disponible || encuestas.disponible, recordatorios, encuestas, errores };
  logEvent(c, "info", "restaurantes_ciclo_pedido_tick", { ...resumen });
  return resumen;
}
