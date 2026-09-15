// Plantilla de correo de confirmación de pedido, construida sobre el marco de
// layout.ts. GAP QUE CIERRA (hallazgo de auditoría, severidad MEDIA):
// restaurantes es voz/WhatsApp-first — `enqueueMessagingOutbox` solo se
// invocaba con `channel: 'whatsapp'` en todo este dominio (ver
// ../order-notifications.ts) — cuando un cliente SÍ deja un correo real (hoy
// solo posible desde el canal `web`, ver migrations/011 y
// orders.ts::validateCreateOrderPayload), nunca recibía ninguna confirmación
// por ese medio, aunque `restaurantes.messaging_outbox` ya soportaba
// `channel='email'` desde el día uno (migrations/007).
//
// Todo dato dinámico (nombre del cliente, dirección, nombre de producto) pasa
// por escapeHtml antes de entrar al HTML — llega tal cual lo tecleó el cliente
// en el panel web, nunca es un dato de confianza.
import { escapeHtml, renderCorreo } from "./layout.ts";

export interface PedidoCorreoItem {
  readonly name: string;
  readonly price: number;
  readonly quantity: number;
}

export interface PedidoCorreo {
  readonly clienteNombre: string;
  /** Nombre de sucursal desnormalizado (`orders.branch`) — este dominio no
   * expone un "nombre de marca" separado de la sucursal en `Order` (ver
   * types.ts), mismo dato que ya usa el WhatsApp de confirmación
   * (order-notifications.ts::branchSuffix). */
  readonly branch: string | null;
  readonly items: readonly PedidoCorreoItem[];
  readonly total: number;
  readonly customerAddress: string | null;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
}

export interface Correo {
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

function formatMxn(amount: number): string {
  return `$${amount.toFixed(2)} MXN`;
}

function itemLineaTexto(item: PedidoCorreoItem): string {
  return `${item.quantity}x ${item.name} (${formatMxn(item.price * item.quantity)})`;
}

const PAYMENT_LABEL: Record<"efectivo" | "tarjeta", string> = { efectivo: "Efectivo", tarjeta: "Tarjeta" };

export function correoConfirmacionPedido(c: PedidoCorreo): Correo {
  const nombre = escapeHtml(c.clienteNombre);
  const itemsHtml = c.items.map((item) => `${escapeHtml(String(item.quantity))}&times; ${escapeHtml(item.name)} — ${escapeHtml(formatMxn(item.price * item.quantity))}`).join("<br>");
  const branchSuffix = c.branch ? ` en <strong>${escapeHtml(c.branch)}</strong>` : "";

  const filas = [{ etiqueta: "Total", valor: formatMxn(c.total) }];
  if (c.customerAddress) filas.push({ etiqueta: "Entrega", valor: c.customerAddress });
  if (c.paymentMethod) filas.push({ etiqueta: "Pago", valor: PAYMENT_LABEL[c.paymentMethod] });

  const html = renderCorreo({
    titulo: "Tu pedido quedó confirmado",
    preheader: `Tu pedido${c.branch ? ` en ${c.branch}` : ""} (${formatMxn(c.total)}) fue recibido`,
    etiqueta: { texto: "Pedido confirmado", color: "#1D4ED8" },
    parrafosHtml: [`Hola ${nombre}, recibimos tu pedido${branchSuffix}. Aquí el detalle:`, itemsHtml],
    tabla: { filas },
    nota: "Si necesitas cambiar o cancelar tu pedido, contáctanos por el mismo medio por el que lo hiciste.",
    piePorQueLlego: "Recibes este correo porque dejaste tu correo al hacer un pedido en atiende.",
  });

  const textoItems = c.items.map(itemLineaTexto).join("\n");
  return {
    asunto: `Pedido confirmado${c.branch ? ` · ${c.branch}` : ""} · ${formatMxn(c.total)}`,
    html,
    texto: `Hola ${c.clienteNombre}, recibimos tu pedido${c.branch ? ` en ${c.branch}` : ""}.\n${textoItems}\nTotal: ${formatMxn(c.total)}${c.customerAddress ? `\nEntrega: ${c.customerAddress}` : ""}`,
  };
}
