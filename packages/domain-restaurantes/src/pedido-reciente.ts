// Estado del pedido para "¿ya salio?" (chats reales de T7: 15 consultas en 8 semanas; la cajera contesta "permitame checo... ya salio a
// reparto" porque ve a los repartidores). El agente no ve al repartidor: SOLO sabe lo que la sucursal marco en el pedido
// (`en_camino`, `listo_para_recoger`...). Sin esa marca no inventa un estado ni una hora.
import { normalizePhone } from "./phone.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { CanalPedido, OrderStatus } from "./types.ts";

/** Un pedido de hace mas de esto ya no es "el pedido de ahora": se trata como cliente que vuelve a pedir. */
export const VENTANA_PEDIDO_RECIENTE_MIN = 12 * 60;
/** Sucursal sin zona horaria propia (`branch_detail.zona_horaria` nula): la del negocio (Los Taquitos de PM es de Merida). */
const ZONA_POR_OMISION = "America/Merida";

export type EstadoPedidoParaCliente = "preparando" | "salio" | "listo_para_recoger" | "entregado" | "programado" | "con_problema" | "no_recogido" | "por_confirmar";

export interface PedidoReciente {
  readonly estado: EstadoPedidoParaCliente;
  readonly canal: CanalPedido | null;
  readonly sucursal: string | null;
  /** Hora local de la sucursal a la que se confirmo el pedido ("19:42"). */
  readonly confirmadoHoraLocal: string;
  readonly minutosDesdeConfirmacion: number;
}

/** Lo que el cliente puede entender de cada estado interno; `cancelado` no es un pedido vigente (devuelve null). */
export function estadoParaCliente(status: OrderStatus): EstadoPedidoParaCliente | null {
  switch (status) {
    case "pending":
    case "preparando":
      return "preparando";
    case "en_camino":
      return "salio";
    case "listo_para_recoger":
      return "listo_para_recoger";
    case "entregado":
    case "completado":
      return "entregado";
    case "programado":
      return "programado";
    case "problema":
      return "con_problema";
    case "no_recogido":
      return "no_recogido";
    case "por_aprobar":
      return "por_confirmar";
    case "cancelado":
      return null;
  }
}

function horaLocal(iso: string, zona: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: zona, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** Pedido mas reciente de este telefono dentro de la ventana; null = no hay; undefined = no se pudo leer (base sin migrar). Solo lee columnas de `orders` de las migraciones 001, 003 y 008
 * y `canal` por el camino que ya degrada contra la base sin migrar (`listOrderPickupInfo`). */
export async function buscarPedidoRecienteConSucursal(repo: RestaurantesRepository, organizationId: string, phone: string, now: Date = new Date()): Promise<{ readonly reciente: PedidoReciente; readonly propertyId: string | null } | null | undefined> {
  const desde = new Date(now.getTime() - VENTANA_PEDIDO_RECIENTE_MIN * 60_000).toISOString();
  const order = await repo.findLatestOrderByPhone(organizationId, normalizePhone(phone), desde);
  if (order === undefined) return undefined; // la lectura no estuvo disponible: estado desconocido
  if (!order) return null;
  const estado = estadoParaCliente(order.status);
  if (!estado) return null;
  const [zona, info] = await Promise.all([repo.findBranchZonaHoraria(order.propertyId), repo.listOrderPickupInfo(organizationId, [order.id])]);
  return {
    propertyId: order.propertyId ?? null,
    reciente: {
      estado,
      canal: info[0]?.canal ?? null,
      sucursal: order.branch,
      confirmadoHoraLocal: horaLocal(order.createdAt, zona.zonaHoraria ?? ZONA_POR_OMISION),
      minutosDesdeConfirmacion: Math.max(0, Math.round((now.getTime() - Date.parse(order.createdAt)) / 60_000)),
    },
  };
}

/** Igual que `buscarPedidoRecienteConSucursal` pero solo con lo que ve el cliente (sin el id de la sucursal). */
export async function buscarPedidoReciente(repo: RestaurantesRepository, organizationId: string, phone: string, now: Date = new Date()): Promise<PedidoReciente | null | undefined> {
  const r = await buscarPedidoRecienteConSucursal(repo, organizationId, phone, now);
  return r === undefined || r === null ? r : r.reciente;
}
