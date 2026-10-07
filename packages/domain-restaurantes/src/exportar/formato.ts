// R-17: formato de las exportaciones de Historial y Clientes. Fechas en la ZONA HORARIA DE LA SUCURSAL (nunca la del servidor ni la de quien
// descarga), dinero como numero plano con dos decimales (sin simbolo ni separador de miles) y etiquetas en espanol de estado y canal.
import type { Customer, Order, OrderStatus } from "../types.ts";
import type { ColumnaCsv } from "./csv.ts";

export const ORDEN_ESTADO_ETIQUETAS: Readonly<Record<OrderStatus, string>> = {
  pending: "Recibido",
  preparando: "Preparando",
  en_camino: "En camino",
  entregado: "Entregado",
  completado: "Completado",
  cancelado: "Cancelado",
  problema: "Incidencia",
  listo_para_recoger: "Listo para recoger",
  no_recogido: "No recogido",
  programado: "Programado",
  por_aprobar: "Por aprobar",
};

export const ORDEN_CANAL_ETIQUETAS: Readonly<Record<Order["source"], string>> = { web: "Pedido en línea", whatsapp: "WhatsApp", voice: "Llamada", admin: "Capturado por el equipo" };

/** "2026-10-03 12:30" en la zona IANA dada (UTC si la zona es invalida). Vacio si el instante no es una fecha valida. */
export function fechaHoraLocal(iso: string, zonaHoraria: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const formatear = (zona: string): string => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]),
    ) as Record<string, string>;
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  };
  try {
    return formatear(zonaHoraria);
  } catch {
    return formatear("UTC");
  }
}

/** Pesos con 2 decimales, punto decimal, sin simbolo ni separador de miles. */
export function dineroPlano(pesos: number): string {
  return (Math.round(pesos * 100) / 100).toFixed(2);
}

export interface FilaHistorial {
  readonly order: Order;
  /** Zona horaria de la sucursal del pedido. */
  readonly zonaHoraria: string;
  readonly sucursal: string;
}

/** Columnas del Historial (mismo orden en CSV y PDF). El telefono sale COMPLETO: la exportacion es solo owner/admin. */
export const COLUMNAS_HISTORIAL: readonly ColumnaCsv<FilaHistorial>[] = [
  { titulo: "Pedido", valor: (f) => f.order.id.slice(0, 8).toUpperCase() },
  { titulo: "Fecha", valor: (f) => fechaHoraLocal(f.order.createdAt, f.zonaHoraria) },
  { titulo: "Sucursal", valor: (f) => f.sucursal },
  { titulo: "Cliente", valor: (f) => f.order.customerName },
  { titulo: "Teléfono", valor: (f) => f.order.customerPhone, telefono: true },
  { titulo: "Canal", valor: (f) => ORDEN_CANAL_ETIQUETAS[f.order.source] ?? f.order.source },
  { titulo: "Estado", valor: (f) => ORDEN_ESTADO_ETIQUETAS[f.order.status] ?? f.order.status },
  { titulo: "Pago", valor: (f) => (f.order.paymentMethod === "efectivo" ? "Efectivo" : f.order.paymentMethod === "tarjeta" ? "Tarjeta" : "") },
  { titulo: "Total", valor: (f) => dineroPlano(f.order.total), numerica: true },
];

export const COLUMNAS_CLIENTES: readonly ColumnaCsv<Customer>[] = [
  { titulo: "Nombre", valor: (c) => c.name ?? "" },
  { titulo: "Teléfono", valor: (c) => c.phone, telefono: true },
  { titulo: "Pedidos", valor: (c) => c.orderCount, numerica: true },
];
