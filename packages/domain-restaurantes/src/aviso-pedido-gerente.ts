// Aviso al gerente determinista (PM Ronda 16: T7-017, T7-021, T7-043). Hasta aqui el texto de `callback_requests.message` de una escalada lo escribia el MODELO
// (`escalar_a_humano.resumen`, registry.ts) y a veces omitia el folio, la direccion o lo que el cliente quiere agregar. Ahora el SERVIDOR antepone un bloque con los
// datos reales del pedido mas reciente del cliente; el resumen del modelo queda debajo como "Detalle". Sin PII innecesaria: nada de telefono ni nombre del cliente
// (el aviso ya lleva `customer_phone`/`customer_name` en sus propias columnas); la direccion de entrega SI va porque el gerente la necesita para reponer o enviar aparte.
import { recortarTexto } from "./callback-requests.ts";
import { normalizePhone } from "./phone.ts";
import type { RestaurantesRepository } from "./repository.ts";
import { VENTANA_PEDIDO_RECIENTE_MIN, estadoParaCliente } from "./pedido-reciente.ts";
import type { EstadoPedidoParaCliente } from "./pedido-reciente.ts";

/** Motivos de escalada que hablan de un pedido ya hecho: ahi el aviso lleva el bloque del pedido. */
export const MOTIVOS_AVISO_CON_PEDIDO: ReadonlySet<string> = new Set(["queja", "cancelacion_modificacion", "tiempos_entrega", "reposicion_descuento", "cobro_duplicado", "urgencia", "alergia_salud"]);

/** Tope del bloque del pedido: `registerCallbackRequest` recorta a 1,000 caracteres y el bloque va PRIMERO para que el recorte se lleve el detalle del modelo, no el folio. */
export const AVISO_BLOQUE_PEDIDO_MAX = 900
/** Renglones que se listan; el resto se resume como "+N mas" para que folio, total, pago y entrega (que van ANTES) nunca se pierdan. */
export const AVISO_RENGLONES_MAX = 8;
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
    const visibles = order.items.filter((i) => !i.courtesy);
    const lista = visibles.slice(0, AVISO_RENGLONES_MAX).map((i) => `${i.quantity}x ${limpio(i.name, 60)}`);
    if (visibles.length > AVISO_RENGLONES_MAX) lista.push(`+${visibles.length - AVISO_RENGLONES_MAX} mas`);
    // Orden: lo que no puede perderse (folio, total, pago, entrega) primero; los productos al final.
    const lineas = [
      `PEDIDO RECIENTE ${folio}${order.branch ? ` (${limpio(order.branch, 60)})` : ""}: ${ETIQUETA_ESTADO[estado]}${canal ? `, ${canal === "recoger" ? "para recoger" : "a domicilio"}` : ""}${hora ? `, confirmado ${hora}` : ""}.`,
      `Total: $${order.total.toFixed(2)}. Pago: ${order.paymentMethod ?? "sin definir"}.`,
      canal === "recoger" ? "Entrega: en sucursal." : order.customerAddress ? `Entrega: ${limpio(order.customerAddress, 200)}.` : "Entrega: direccion no registrada.",
      `Productos: ${lista.join(", ") || "sin renglones"}.`,
    ];
    return recortarTexto(lineas.join("\n"), AVISO_BLOQUE_PEDIDO_MAX);
  } catch {
    return null;
  }
}

/** PM R21 (T7-038): el modelo escribia «no se ha cotizado ni confirmado» en el aviso aunque ya habia una cotizacion vigente (la que dio al cliente despues). Con el total
 * cotizado que conoce el SERVIDOR la frase se corrige a lo cierto; sin cotizacion vigente el texto queda igual. */
const NO_COTIZADO = /\b(?:(?:todav[ií]a|a[uú]n)\s+)?no\s+(?:se\s+ha|ha\s+sido|est[aá]|fue)\s+cotizad[oa]\b(\s+ni\s+(?:confirmad[oa]|registrad[oa]|creado))?/gi;
export function corregirAvisoCotizado(detalle: string | undefined, totalCotizado: number | undefined): string | undefined {
  if (!detalle || typeof totalCotizado !== "number" || !Number.isFinite(totalCotizado) || totalCotizado <= 0) return detalle;
  return detalle.replace(NO_COTIZADO, (_m, ni: string | undefined) => `ya está cotizado por $${totalCotizado.toFixed(2)}${ni ? ", pendiente de confirmar por el cliente" : ""}`);
}

/** Une el bloque del servidor con el detalle que escribio el modelo (el bloque va primero). */
export function componerMensajeAviso(bloque: string | null, detalle: string | undefined, motivo: string): string | undefined {
  const d = detalle?.trim();
  if (!bloque) return d || undefined;
  const etiqueta = motivo === "cancelacion_modificacion" ? "Cambio pedido por el cliente" : "Detalle";
  return d ? `${bloque}\n${etiqueta}: ${d}` : bloque;
}
