// R-11 / aviso al staff: cuando un pedido PROGRAMADO se promueve a `pending` (entra a cocina) el staff recibe dos avisos
// reales, ambos idempotentes por pedido:
//   1. La bandeja `staff_order_notification` (evento `order.programado_promovido`, migracion 043): la que el panel de
//      pedidos ya consulta por polling. El aviso de `order.created` se emitio al crearlo, con la hora programada.
//   2. La notificacion in-app (campana, `core.notification`) del catalogo compartido
//      (`restaurantes.pedido.programado_en_cocina`): sin PII (el texto sale del catalogo, solo viaja el id del pedido).
//
// Reglas de robustez (mismas del resto de avisos): NUNCA lanza ni revierte la promocion. Cada pedido y cada aviso corre
// dentro de su propio SAVEPOINT (`repo.runWithRowSavepoint` / `emitirNotificacion`): contra una base sin la migracion 043 el
// evento nuevo viola el CHECK de la bandeja (o la funcion lo rechaza) y solo ese intento se revierte; la sesion sigue viva.
// Debe llamarse en una sesion de SISTEMA o de staff de la organizacion (`enqueue_staff_order_notification` exige ambas
// cosas) y DESPUES de que la promocion quedo confirmada, para que el pedido ya exista fuera de la transaccion que lo promovio.
import { emitirNotificacion } from "@atiende/db";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { etiquetaHoraLocal } from "./horarios.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Order } from "./types.ts";

/** Minutos de retraso (sobre la hora pedida) a partir de los cuales el pedido se avisa como atrasado (QA-restaurantes-R1-automatizacion-07). */
export const ATRASO_PROGRAMADO_MIN = 60;

/** `true` si el pedido entro a cocina mas de `ATRASO_PROGRAMADO_MIN` despues de su hora pedida (cron pausado, caida). La marca se deriva de
 * `promovido_at - programado_para` (sin columna nueva). */
export function esPromocionAtrasada(order: Pick<Order, "programadoPara" | "promovidoAt">, ahora: Date = new Date()): boolean {
  if (!order.programadoPara) return false;
  const promovidoMs = order.promovidoAt ? Date.parse(order.promovidoAt) : ahora.getTime();
  return promovidoMs - Date.parse(order.programadoPara) > ATRASO_PROGRAMADO_MIN * 60_000;
}

/** Campana in-app de un pedido programado que ENTRO a cocina: `programado_en_cocina`, o `programado_atrasado` (en su lugar) si entro con mas de
 * una hora de retraso. Idempotente por pedido (clave = id) y sin PII. Se usa tambien al adelantar un programado a mano. */
export async function emitirAvisoProgramadoEnCocina(db: TenantDbSession, order: Order, ahora: Date = new Date()): Promise<{ readonly estado: string; readonly atrasado: boolean }> {
  const atrasado = esPromocionAtrasada(order, ahora);
  const r = await emitirNotificacion(db, {
    evento: atrasado ? "restaurantes.pedido.programado_atrasado" : "restaurantes.pedido.programado_en_cocina",
    organizationId: order.organizationId,
    propertyId: order.propertyId,
    clave: order.id,
    entidadTipo: "order",
    entidadId: order.id,
  });
  return { estado: r.estado, atrasado };
}

export interface ResumenAvisosProgramados {
  /** Pedidos `pending` recien promovidos para los que se intento avisar. */
  readonly intentados: number;
  /** Pedidos con la bandeja del staff registrada (o ya registrada antes: idempotente). */
  readonly bandeja: number;
  /** Avisos que fallaron: la bandeja (incluida una base sin la migracion 043) o una campana con error real. Un `no_disponible` de la campana no cuenta. */
  readonly errores: number;
}

function mensajeBandeja(order: Order, zona: string): string {
  const sucursal = order.branch ? ` de ${order.branch}` : "";
  const hora = order.programadoPara ? ` (programado para ${etiquetaHoraLocal(new Date(order.programadoPara), zona)})` : "";
  return `El pedido PROGRAMADO de ${order.customerName}${sucursal}${hora} entró a cocina — $${order.total.toFixed(2)} MXN.`;
}

export async function avisarProgramadosPromovidos(repo: RestaurantesRepository, db: TenantDbSession, promovidos: readonly Order[]): Promise<ResumenAvisosProgramados> {
  let intentados = 0;
  let bandeja = 0;
  let errores = 0;
  for (const order of promovidos) {
    if (order.status !== "pending") continue;
    intentados += 1;
    try {
      const zona = resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(order.propertyId)).zonaHoraria);
      await repo.runWithRowSavepoint(() => repo.createStaffOrderNotification(order.organizationId, order.propertyId, order.id, "order.programado_promovido", mensajeBandeja(order, zona)));
      bandeja += 1;
    } catch (err) {
      errores += 1;
      console.error("pedidos-programados-avisos: la bandeja del staff no se pudo registrar (base sin migrar o fallo real):", err instanceof Error ? err.message : err);
    }
    const r = await emitirAvisoProgramadoEnCocina(db, order);
    if (r.estado === "error" || r.estado === "invalida") errores += 1;
  }
  return { intentados, bandeja, errores };
}
