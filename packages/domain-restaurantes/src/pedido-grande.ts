// REGLA DE PEDIDO GRANDE (decision de Javier, 2-oct-2026, Los Taquitos de PM): un pedido de mas de $4,000, o de mas de 5 kg,
// (o de mas de $2,500 si el numero no tiene historial y paga en efectivo) NO entra directo a cocina: la sucursal lo confirma.
//
// Antes la regla solo vivia en el prompt (`PM_PEDIDO_GRANDE_POR_OMISION`): si el modelo olvidaba escalar, el servidor creaba el
// pedido en `pending` y salia a cocina sin aviso. Ahora el servidor la hace cumplir en `crear_pedido` de los canales de agente
// (WhatsApp y voz): en vez de crear el pedido registra el aviso `escalada:pedido_grande` al equipo con el resumen, y el modelo
// recibe un resultado NORMAL (no un error) para que le diga al cliente que la sucursal lo contactara.
//
// Alcance: solo organizaciones con perfil de agente `taqueria_pm` y mientras el motivo `pedido_grande` no este apagado en su
// configuracion (`escalationReasonsOff`, el interruptor que ya existe en el editor del agente). Sin migracion: contra una base
// sin la configuracion del agente (`findWhatsAppAgentConfig` -> null) no se aplica la regla y el camino anterior queda igual.
import { pesoDeProductoEnGramos } from "./product-search.ts";
import type { PersistedOrderItem } from "./types.ts";

/** Total (MXN) a partir del cual un pedido es grande. */
export const PEDIDO_GRANDE_TOTAL_MXN = 4000;
/** Kilos a partir de los cuales un pedido es grande. */
export const PEDIDO_GRANDE_KG = 5;
/** Total (MXN) a partir del cual es grande si el numero no tiene historial y paga en efectivo. */
export const PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN = 2500;

/** Ventana (ms) en la que los pedidos recientes del mismo numero se SUMAN al evaluar el umbral: partir un pedido grande en varios chicos
 * dentro de la misma conversacion no lo evade, y los pedidos de esa ventana tampoco cuentan como "historial" del numero. */
export const PEDIDO_GRANDE_VENTANA_ACUMULADO_MS = 6 * 3_600_000;

export type MotivoPedidoGrande = "total" | "peso" | "sin_historial_efectivo";

/** Kilos que suman los renglones cuyo NOMBRE declara un peso ("Pastor — 2 kg" x 3 = 6 kg). Los tacos, bebidas y demas suman 0. */
export function pesoTotalKg(items: readonly Pick<PersistedOrderItem, "name" | "quantity">[]): number {
  let gramos = 0;
  for (const item of items) {
    const g = pesoDeProductoEnGramos(item.name);
    if (g !== null) gramos += g * item.quantity;
  }
  return gramos / 1000;
}

export interface AcumuladoReciente {
  readonly total: number;
  readonly pesoKg: number;
  readonly cuantos: number;
}

/** Suma lo que el mismo numero ya pidio dentro de la ventana (sin contar cancelados). Pura; `ahoraMs` lo pone el llamador. */
export function acumuladoReciente(
  pedidos: readonly { readonly createdAt: string; readonly status: string; readonly total: number; readonly items: readonly Pick<PersistedOrderItem, "name" | "quantity">[] }[],
  ahoraMs: number,
): AcumuladoReciente {
  let total = 0;
  let pesoKg = 0;
  let cuantos = 0;
  for (const p of pedidos) {
    if (p.status === "cancelado") continue;
    const t = Date.parse(p.createdAt);
    if (!Number.isFinite(t) || ahoraMs - t > PEDIDO_GRANDE_VENTANA_ACUMULADO_MS || t > ahoraMs + 60_000) continue;
    total += p.total;
    pesoKg += pesoTotalKg(p.items);
    cuantos += 1;
  }
  return { total: Math.round(total * 100) / 100, pesoKg, cuantos };
}

/** Pura: ¿el pedido es grande?, y por cual regla (la de mayor alcance primero). `null` = no es grande. */
export function evaluarPedidoGrande(args: {
  readonly total: number;
  readonly pesoKg: number;
  readonly pagaEfectivo: boolean;
  readonly sinHistorial: boolean;
}): MotivoPedidoGrande | null {
  if (args.total > PEDIDO_GRANDE_TOTAL_MXN) return "total";
  if (args.pesoKg > PEDIDO_GRANDE_KG) return "peso";
  if (args.sinHistorial && args.pagaEfectivo && args.total > PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN) return "sin_historial_efectivo";
  return null;
}

/** Lo lanza el gancho previo a la persistencia de `createOrder`; `crear_pedido` lo convierte en el aviso al equipo (nunca llega al modelo como error). */
export class PedidoGrandeRetenidoError extends Error {
  constructor(
    readonly motivo: MotivoPedidoGrande,
    readonly total: number,
    readonly pesoKg: number,
    readonly resumen: string,
  ) {
    super("Pedido grande: lo confirma la sucursal antes de mandarlo a cocina.");
    this.name = "PedidoGrandeRetenidoError";
  }
}

/** Texto (sin datos personales: solo renglones, importes y forma de pago) que ve el equipo en la bandeja de avisos. */
export function resumenPedidoGrande(args: {
  readonly motivo: MotivoPedidoGrande;
  readonly total: number;
  readonly pesoKg: number;
  readonly items: readonly Pick<PersistedOrderItem, "name" | "quantity">[];
  readonly canal: string | undefined;
  readonly paymentMethod: string | null | undefined;
  /** Pedidos recientes del mismo numero que se sumaron al umbral (0 = el pedido solo). */
  readonly pedidosPrevios?: number;
  /** Total de ESTE pedido cuando `total` ya incluye pedidos anteriores de la misma conversacion (pedido partido en dos). */
  readonly totalDeEstePedido?: number;
}): string {
  const motivo = args.motivo === "total" ? `total de $${args.total.toFixed(2)} (mas de $${PEDIDO_GRANDE_TOTAL_MXN})` : args.motivo === "peso" ? `${args.pesoKg} kg (mas de ${PEDIDO_GRANDE_KG} kg)` : `numero sin historial que paga en efectivo, total de $${args.total.toFixed(2)} (mas de $${PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN})`;
  const renglones = args.items.map((i) => `${i.quantity} x ${i.name}`).join("; ");
  const acumulado = args.pedidosPrevios && args.pedidosPrevios > 0 ? ` Suma ${args.pedidosPrevios} pedido(s) previo(s) del mismo numero en las ultimas ${PEDIDO_GRANDE_VENTANA_ACUMULADO_MS / 3_600_000} h.` : "";
  const previo = args.totalDeEstePedido !== undefined && args.totalDeEstePedido < args.total ? ` (este pedido: $${args.totalDeEstePedido.toFixed(2)}; el resto son pedidos anteriores del mismo numero)` : "";
  const texto = `Pedido grande por confirmar (NO se mando a cocina): ${motivo}.${acumulado} Total $${args.total.toFixed(2)}${previo}; pago ${args.paymentMethod ?? "sin definir"}; canal ${args.canal ?? "domicilio"}. Renglones: ${renglones}.`;
  return texto.length > 900 ? `${texto.slice(0, 897)}...` : texto;
}
