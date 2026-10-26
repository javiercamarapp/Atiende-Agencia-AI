// Serializacion de una solicitud al contrato del panel (`TarjetaAgregado`, ver operacion/agregados.ts). El telefono del cliente solo viaja mientras la solicitud
// sigue abierta (permiso derivado: el operador necesita llamar). El estado EFECTIVO sale del reloj, sin escribir nada.
import type { TarjetaAgregado } from "../operacion/agregados.ts";
import { ESTADOS_PEDIDO_AGREGABLES, calcularSla } from "./tipos.ts";
import type { AgregadoVista } from "./tipos.ts";

const EN_COCINA: readonly string[] = ["preparando", "listo_para_recoger"];

export function aTarjetaAgregado(a: AgregadoVista, ahora: Date): TarjetaAgregado {
  const sla = calcularSla(a.estado, a.requestedAt, ahora);
  return {
    id: a.id,
    propertyId: a.propertyId,
    sucursal: a.sucursal,
    canal: a.channel === "voice" ? "llamada" : "whatsapp",
    estado: a.estado,
    estadoEfectivo: a.estado === "pendiente" && sla.nivel === "vencido" ? "vencido" : a.estado,
    sla,
    pedido: {
      id: a.orderId,
      numero: a.orderNumber,
      estado: a.orderStatus,
      yaEnCocina: EN_COCINA.includes(a.orderStatus) || !ESTADOS_PEDIDO_AGREGABLES.includes(a.orderStatus),
      creadoEn: a.orderCreatedAt,
      renglones: a.orderItems.map((i) => ({ nombre: i.name, cantidad: i.quantity })),
      total: a.orderTotal,
    },
    agregado: {
      renglones: a.itemsAdded.map((i) => ({ nombre: i.name, cantidad: i.quantity, precio: i.price, subtotal: Math.round(i.price * i.quantity * 100) / 100 })),
      total: a.totalAdded,
      nuevoTotal: a.totalAfter,
      nota: a.customerNote,
      version: a.version,
    },
    cliente: { nombre: a.customerName, telefono: a.estado === "pendiente" ? a.customerPhone || null : null },
    solicitadoEn: a.requestedAt,
    vistoEn: a.firstSeenAt,
    resueltoEn: a.decidedAt,
    resueltoPor: a.decidedByName,
    motivoRechazo: a.rejectReason,
    notaRechazo: a.rejectNote,
    escalamiento: a.escalationLevel,
  };
}
