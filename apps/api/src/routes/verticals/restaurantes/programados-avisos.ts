// Avisos in-app (campana) cuando un pedido programado ENTRA a cocina (QA-restaurantes-R1-automatizacion-06 y -07).
//
// Un pedido programado ya avisó al crearse (`restaurantes.pedido.nuevo`, quizá días antes); lo que el staff necesita
// saber es cuándo pasa de Programados a Pendientes. Tres caminos lo promueven y los tres llaman aquí: el cron
// (`programados-interno.ts`), la promoción al consultar el panel y el adelanto manual (`admin-orders.ts`).
//
// Atrasado (-07): si pasó más de `ATRASO_PROGRAMADO_MIN` desde la hora pedida (cron pausado por el interruptor, caída),
// el aviso es `restaurantes.pedido.programado_atrasado` (en lugar del normal): el staff confirma con el cliente antes
// de cocinar. La marca se deriva de `promovido_at - programado_para` (sin columna nueva).
//
// Best-effort: NUNCA lanza ni cambia lo ya promovido. Va en SU PROPIA sesión de sistema (cada emisión corre dentro de
// SAVEPOINT en `emitirNotificacion`; contra la base sin la 0039 degrada a "no_disponible"). Texto sin PII (solo catálogo).
import { emitirNotificacion } from "@atiende/db";
import type { Order } from "@atiende/domain-restaurantes";
import type { AppDeps } from "../../../deps.ts";

/** Minutos de retraso (sobre la hora pedida) a partir de los cuales el pedido se avisa como atrasado. */
export const ATRASO_PROGRAMADO_MIN = 60;

export function esPromocionAtrasada(order: Pick<Order, "programadoPara" | "promovidoAt">, ahora: Date = new Date()): boolean {
  if (!order.programadoPara) return false;
  const promovidoMs = order.promovidoAt ? Date.parse(order.promovidoAt) : ahora.getTime();
  return promovidoMs - Date.parse(order.programadoPara) > ATRASO_PROGRAMADO_MIN * 60_000;
}

export interface ResumenAvisosPromovidos {
  readonly emitidas: number;
  /** Pedidos detectados como atrasados en esta tanda (haya o no podido emitirse el aviso). */
  readonly atrasados: number;
  readonly fallidas: number;
}

export async function avisarPromovidosEnCocinaBestEffort(deps: Pick<AppDeps, "engine">, promovidos: readonly Order[], ahora: Date = new Date()): Promise<ResumenAvisosPromovidos> {
  const vacio = { emitidas: 0, atrasados: 0, fallidas: 0 };
  const validos = promovidos.filter((o) => o.status !== "programado" && o.status !== "cancelado");
  if (validos.length === 0) return vacio;
  try {
    return await deps.engine.withAppSession({ userId: null }, async (db) => {
      let emitidas = 0;
      let atrasados = 0;
      let fallidas = 0;
      for (const o of validos) {
        const atrasado = esPromocionAtrasada(o, ahora);
        const r = await emitirNotificacion(db, {
          evento: atrasado ? "restaurantes.pedido.programado_atrasado" : "restaurantes.pedido.programado_en_cocina",
          organizationId: o.organizationId,
          propertyId: o.propertyId,
          clave: o.id,
          entidadTipo: "order",
          entidadId: o.id,
        });
        if (atrasado) atrasados += 1; // pedidos detectados como atrasados (aunque la base aun no tenga la tabla de notificaciones)
        if (r.estado === "emitida" || r.estado === "sin_nuevas") {
          emitidas += 1;
        } else if (r.estado === "invalida" || r.estado === "error") {
          fallidas += 1;
        }
      }
      return { emitidas, atrasados, fallidas };
    });
  } catch (err) {
    console.error("programados-avisos: no se pudieron emitir los avisos (best-effort):", err instanceof Error ? err.name : typeof err);
    return { ...vacio, fallidas: validos.length };
  }
}
