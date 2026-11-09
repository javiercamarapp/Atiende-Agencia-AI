// REGLA DE PEDIDO GRANDE. Original (decision de Javier, 2-oct-2026): un pedido de mas de $4,000, o de mas de 5 kg (o de mas de $2,500 si el numero no tiene
// historial y paga en efectivo) no entraba directo a cocina. DESDE EL 9-NOV-2026 (decision de Omar) no hay espera por omision: ver `umbralesPedidoGrande`.
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

// DECISION DE OMAR (9-nov-2026): NO hay limite de pedido grande. Por omision NINGUN pedido queda en espera (ni por monto, ni por kilos, ni por ser de un
// numero sin historial que paga en efectivo): entra normal a cocina. Lo que si queda es un AVISO informativo a la sucursal (notificacion in-app
// `restaurantes.pedido.grande`) cuando un numero sin historial paga en efectivo por arriba de un monto (por omision $2,500). Cada espera se activa solo
// si se configura su umbral por entorno (vacio = sin umbral). Valores de antes, para quien quiera volver a la regla: total 4000, kg 5, sin historial 2500.

/** Valores de referencia de la regla anterior (2-oct): ya NO se aplican por omision. */
export const PEDIDO_GRANDE_TOTAL_MXN = 4000;
export const PEDIDO_GRANDE_KG = 5;
export const PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN = 2500;
/** Monto informativo por omision del aviso (sin espera). */
export const PEDIDO_GRANDE_AVISO_MXN_POR_OMISION = 2500;

export const PEDIDO_GRANDE_ENV = {
  totalMxn: "PM_PEDIDO_GRANDE_TOTAL_MXN",
  kg: "PM_PEDIDO_GRANDE_KG",
  sinHistorialEfectivoMxn: "PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN",
  avisoSinHistorialEfectivoMxn: "PM_PEDIDO_GRANDE_AVISO_MXN",
} as const;

export interface UmbralesPedidoGrande {
  /** Espera por total (MXN); null = sin umbral. */
  readonly totalMxn: number | null;
  /** Espera por kilos; null = sin umbral. */
  readonly kg: number | null;
  /** Espera por total si el numero no tiene historial y paga en efectivo; null = sin umbral. */
  readonly sinHistorialEfectivoMxn: number | null;
  /** Aviso informativo (sin espera) si el numero no tiene historial y paga en efectivo; null = sin aviso. */
  readonly avisoSinHistorialEfectivoMxn: number | null;
}

function enteroEnRango(crudo: string | undefined, min: number, max: number): number | null {
  const t = String(crudo ?? "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** Umbrales vigentes (entorno). Vacio o invalido = sin umbral; el aviso usa $2,500 si no se configura y se apaga con «off» / «0» / «no». Pura sobre `env`. */
export function umbralesPedidoGrande(env: Readonly<Record<string, string | undefined>> = process.env): UmbralesPedidoGrande {
  const aviso = String(env[PEDIDO_GRANDE_ENV.avisoSinHistorialEfectivoMxn] ?? "").trim();
  return {
    totalMxn: enteroEnRango(env[PEDIDO_GRANDE_ENV.totalMxn], 500, 20000),
    kg: enteroEnRango(env[PEDIDO_GRANDE_ENV.kg], 1, 500),
    sinHistorialEfectivoMxn: enteroEnRango(env[PEDIDO_GRANDE_ENV.sinHistorialEfectivoMxn], 500, 20000),
    avisoSinHistorialEfectivoMxn: aviso === "" ? PEDIDO_GRANDE_AVISO_MXN_POR_OMISION : /^(?:off|no|0|apagado)$/i.test(aviso) ? null : enteroEnRango(aviso, 500, 20000) ?? PEDIDO_GRANDE_AVISO_MXN_POR_OMISION,
  };
}

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
export function evaluarPedidoGrande(
  args: {
    readonly total: number;
    readonly pesoKg: number;
    readonly pagaEfectivo: boolean;
    readonly sinHistorial: boolean;
  },
  u: UmbralesPedidoGrande = umbralesPedidoGrande(),
): MotivoPedidoGrande | null {
  if (u.totalMxn !== null && args.total > u.totalMxn) return "total";
  if (u.kg !== null && args.pesoKg > u.kg) return "peso";
  if (u.sinHistorialEfectivoMxn !== null && args.sinHistorial && args.pagaEfectivo && args.total > u.sinHistorialEfectivoMxn) return "sin_historial_efectivo";
  return null;
}

/** Pura: ¿el pedido (que entra NORMAL a cocina) amerita el aviso informativo de pedido grande? `null` = no. */
export function motivoAvisoPedidoGrande(
  args: { readonly total: number; readonly pagaEfectivo: boolean; readonly sinHistorial: boolean },
  u: UmbralesPedidoGrande = umbralesPedidoGrande(),
): MotivoPedidoGrande | null {
  return u.avisoSinHistorialEfectivoMxn !== null && args.sinHistorial && args.pagaEfectivo && args.total > u.avisoSinHistorialEfectivoMxn ? "sin_historial_efectivo" : null;
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
  const u = umbralesPedidoGrande();
  const motivo = args.motivo === "total" ? `total de $${args.total.toFixed(2)} (mas de $${u.totalMxn ?? PEDIDO_GRANDE_TOTAL_MXN})` : args.motivo === "peso" ? `${args.pesoKg} kg (mas de ${u.kg ?? PEDIDO_GRANDE_KG} kg)` : `numero sin historial que paga en efectivo, total de $${args.total.toFixed(2)} (mas de $${u.sinHistorialEfectivoMxn ?? PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN})`;
  const renglones = args.items.map((i) => `${i.quantity} x ${i.name}`).join("; ");
  const acumulado = args.pedidosPrevios && args.pedidosPrevios > 0 ? ` Suma ${args.pedidosPrevios} pedido(s) previo(s) del mismo numero en las ultimas ${PEDIDO_GRANDE_VENTANA_ACUMULADO_MS / 3_600_000} h.` : "";
  const previo = args.totalDeEstePedido !== undefined && args.totalDeEstePedido < args.total ? ` (este pedido: $${args.totalDeEstePedido.toFixed(2)}; el resto son pedidos anteriores del mismo numero)` : "";
  const texto = `Pedido grande por confirmar (NO se mando a cocina): ${motivo}.${acumulado} Total $${args.total.toFixed(2)}${previo}; pago ${args.paymentMethod ?? "sin definir"}; canal ${args.canal ?? "domicilio"}. Renglones: ${renglones}.`;
  return texto.length > 900 ? `${texto.slice(0, 897)}...` : texto;
}
