// Confirmacion de un pedido YA creado, redactada solo con datos del servidor (folio, renglones, total, pago, sucursal, hora). Se usa cuando el modelo no
// alcanza a redactar la respuesta final (agoto sus vueltas de herramientas, el proveedor cayo o contesto vacio) DESPUES de que `crear_pedido` tuvo exito:
// el cliente nunca debe leer un texto de fallo ni «ya avise al equipo» sobre un pedido que si existe. No inventa nada: cada linea sale de un dato presente.
import { FOLIO_PREVIEW_PREFIJO } from "../agent-tools/registry.ts";

export interface OpcionesConfirmacion {
  /** Zona horaria de la sucursal (IANA) para mostrar la hora de recogida / programada. */
  readonly timezone: string;
}

const esTexto = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function dinero(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function horaLocal(iso: unknown, timezone: string): string | null {
  if (!esTexto(iso)) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat("es-MX", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  } catch {
    return null;
  }
}

/**
 * Texto de confirmacion de un pedido creado (real: `Order`; preview: el pedido simulado de `crear_pedido`). `null` si el dato no es un pedido utilizable
 * (0, '', null, false, [], {} o sin id / total / renglones): el llamador conserva su respaldo de siempre.
 */
export function confirmacionDePedido(pedido: unknown, opciones: OpcionesConfirmacion): string | null {
  if (typeof pedido !== "object" || pedido === null || Array.isArray(pedido)) return null;
  const p = pedido as Record<string, unknown>;
  if (!esTexto(p.id)) return null;
  const total = p.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return null;
  const items = Array.isArray(p.items)
    ? p.items.flatMap((i: unknown) => {
        const it = i as Record<string, unknown> | null;
        return it && esTexto(it.name) && typeof it.quantity === "number" && Number.isFinite(it.quantity) && it.quantity > 0 ? [{ name: it.name.trim(), quantity: it.quantity }] : [];
      })
    : [];
  if (items.length === 0) return null;

  const simulado = p.simulado === true || p.id.startsWith(FOLIO_PREVIEW_PREFIJO);
  const folio = simulado ? p.id : typeof p.orderNumber === "number" && Number.isInteger(p.orderNumber) && p.orderNumber > 0 ? `#${p.orderNumber}` : null;
  const pago = p.paymentMethod ?? p.payment_method;
  const programado = horaLocal(p.programadoPara ?? p.programado_para, opciones.timezone);
  const recoger = programado ? null : horaLocal(p.horaRecogida ?? p.hora_recogida, opciones.timezone);

  const lineas = [simulado ? "¡Listo! Su pedido de prueba quedó registrado (es una simulación: no se mandó a cocina)." : programado ? "¡Listo! Su pedido ya quedó registrado y programado." : p.status === "pending" ? "¡Listo! Su pedido ya quedó registrado y se mandó a cocina." : "¡Listo! Su pedido ya quedó registrado."];
  if (folio) lineas.push(`*Folio:* ${folio}`);
  for (const it of items) lineas.push(`${it.quantity} × ${it.name}`);
  lineas.push(`*Total:* ${dinero(total)}`);
  if (pago === "efectivo" || pago === "tarjeta") lineas.push(`*Pago:* ${pago}`);
  if (esTexto(p.branch)) lineas.push(`*Sucursal:* ${p.branch.trim()}`);
  if (programado) lineas.push(`*Programado para:* ${programado}`);
  else if (recoger) lineas.push(`*Recoger a las:* ${recoger}`);
  return lineas.join("\n");
}
