// Aviso al gerente determinista (PM Ronda 16: T7-017, T7-021, T7-043). Hasta aqui el texto de `callback_requests.message` de una escalada lo escribia el MODELO
// (`escalar_a_humano.resumen`, registry.ts) y a veces omitia el folio, la direccion o lo que el cliente quiere agregar. Ahora el SERVIDOR antepone un bloque con los
// datos reales del pedido mas reciente del cliente; el resumen del modelo queda debajo como "Detalle". Sin PII innecesaria: nada de telefono ni nombre del cliente
// (el aviso ya lleva `customer_phone`/`customer_name` en sus propias columnas); la direccion de entrega SI va porque el gerente la necesita para reponer o enviar aparte.
import { normalizePhone } from "./phone.ts";
import type { RestaurantesRepository } from "./repository.ts";
import { VENTANA_PEDIDO_RECIENTE_MIN, estadoParaCliente } from "./pedido-reciente.ts";
import type { EstadoPedidoParaCliente } from "./pedido-reciente.ts";

/** Motivos de escalada que hablan de un pedido ya hecho: ahi el aviso lleva el bloque del pedido. */
export const MOTIVOS_AVISO_CON_PEDIDO: ReadonlySet<string> = new Set(["queja", "cancelacion_modificacion", "tiempos_entrega", "reposicion_descuento", "cobro_duplicado", "urgencia", "alergia_salud"]);

/** Tope del bloque del pedido: `registerCallbackRequest` recorta a 1,000 caracteres y el bloque va PRIMERO para que el recorte se lleve el detalle del modelo, no el folio. */
export const AVISO_BLOQUE_PEDIDO_MAX = 600;
const ZONA_POR_OMISION = "America/Merida";

const ETIQUETA_ESTADO: Record<EstadoPedidoParaCliente, string> = {
  registrado: "registrado, aun sin marcar en preparacion",
  preparando: "en preparacion",
  salio: "YA SALIO a reparto",
  listo_para_recoger: "listo para recoger",
  entregado: "entregado",
  programado: "programado",
  con_problema: "con problema",
  no_recogido: "no recogido",
  por_confirmar: "por confirmar por la sucursal",
};

/** Una linea sin saltos ni espacios dobles (el texto viene de la base pero el domicilio lo escribio el cliente). */
function limpio(texto: string, max: number): string {
  const t = texto.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function horaLocal(iso: string, zona: string): string {
  try {
    return new Intl.DateTimeFormat("es-MX", { timeZone: zona, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  } catch {
    return "";
  }
}

/** Bloque de texto con folio, estado, canal, hora, renglones, total, pago y direccion del pedido mas reciente del telefono. `null` = no hay pedido reciente (o no se pudo leer): el aviso
 * queda solo con el detalle del modelo, como antes. Nunca lanza: una lectura que falla no puede tumbar el aviso. */
export async function armarBloquePedidoParaAviso(repo: RestaurantesRepository, organizationId: string, phone: string, now: Date = new Date()): Promise<string | null> {
  try {
    const desde = new Date(now.getTime() - VENTANA_PEDIDO_RECIENTE_MIN * 60_000).toISOString();
    const order = await repo.findLatestOrderByPhone(organizationId, normalizePhone(phone), desde);
    if (!order) return null;
    const estado = estadoParaCliente(order.status);
    if (!estado) return null;
    const zona = await repo.findBranchZonaHoraria(order.propertyId);
    const info = await repo.listOrderPickupInfo(organizationId, [order.id]);
    const canal = info[0]?.canal ?? null;
    const folio = typeof order.orderNumber === "number" && Number.isFinite(order.orderNumber) ? `#${order.orderNumber}` : "sin folio";
    const hora = horaLocal(order.createdAt, zona.zonaHoraria ?? ZONA_POR_OMISION);
    const renglones = order.items.filter((i) => !i.courtesy).map((i) => `${i.quantity}x ${limpio(i.name, 60)}`).join(", ");
    const lineas = [
      `PEDIDO RECIENTE ${folio}${order.branch ? ` (${limpio(order.branch, 60)})` : ""}: ${ETIQUETA_ESTADO[estado]}${canal ? `, ${canal === "recoger" ? "para recoger" : "a domicilio"}` : ""}${hora ? `, confirmado ${hora}` : ""}.`,
      `Productos: ${renglones || "sin renglones"}. Total: $${order.total.toFixed(2)}. Pago: ${order.paymentMethod ?? "sin definir"}.`,
      canal === "recoger" ? "Entrega: en sucursal." : order.customerAddress ? `Entrega: ${limpio(order.customerAddress, 200)}.` : "Entrega: direccion no registrada.",
    ];
    return lineas.join("\n").slice(0, AVISO_BLOQUE_PEDIDO_MAX).trimEnd();
  } catch {
    return null;
  }
}

/** Une el bloque del servidor con el detalle que escribio el modelo (el bloque va primero). */
export function componerMensajeAviso(bloque: string | null, detalle: string | undefined, motivo: string): string | undefined {
  const d = detalle?.trim();
  if (!bloque) return d || undefined;
  const etiqueta = motivo === "cancelacion_modificacion" ? "Cambio pedido por el cliente" : "Detalle";
  return d ? `${bloque}\n${etiqueta}: ${d}` : bloque;
}
