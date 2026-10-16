// Port de "anotar el contacto" — cierra un hueco real: ambos agentes (voz y
// WhatsApp) siempre prometieron registrar el contacto cuando la llamada/mensaje no es
// para hacer un pedido (quejas, facturación, empleo), pero en el origen no existía
// tabla ni herramienta que de verdad lo guardara antes de
// 20260903010000_callback_requests.sql — se preserva tal cual.
import type { RestaurantesRepository } from "./repository.ts";
import type { CallbackRequest, CallbackRequestInput } from "./types.ts";

/** Topes del texto libre de un aviso (R11-13): el modelo puede copiar un mensaje enorme y la columna `text` no tiene CHECK; se conserva el inicio. */
export const AVISO_RESUMEN_MAX_CARACTERES = 1000;
export const AVISO_NOMBRE_MAX_CARACTERES = 120;

/** Corta a `max` unidades UTF-16 sin dejar un sustituto suelto (que jsonb/text de Postgres rechazaria) y sin NUL. */
function recortarTexto(texto: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const limpio = texto.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (limpio.length <= max) return limpio;
  let corte = limpio.slice(0, max);
  const ultimo = corte.charCodeAt(corte.length - 1);
  if (ultimo >= 0xd800 && ultimo <= 0xdbff) corte = corte.slice(0, -1);
  return corte.trimEnd();
}

export async function registerCallbackRequest(repo: RestaurantesRepository, input: CallbackRequestInput): Promise<CallbackRequest> {
  if (!input.customerName.trim() || !input.customerPhone.trim()) {
    throw new Error("customerName y customerPhone son requeridos para registrar un contacto");
  }
  return repo.createCallbackRequest({
    ...input,
    customerName: recortarTexto(input.customerName, AVISO_NOMBRE_MAX_CARACTERES).trim() || "Cliente",
    ...(typeof input.message === "string" ? { message: recortarTexto(input.message, AVISO_RESUMEN_MAX_CARACTERES) } : {}),
  });
}
