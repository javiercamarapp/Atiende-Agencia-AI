// H-35 -- cliente del cotizador (POST /hoteles/:propertyId/quotes). El servidor SIEMPRE calcula: el body solo lleva el tipo de
// habitacion y las fechas (jamas un precio) y la respuesta trae neto, IVA, ISH, total y el desglose por noche en pesos MXN.
import { sendJson } from "./admin-client.ts";

export interface CotizacionNoche {
  readonly date: string;
  readonly price: number;
}

export interface Cotizacion {
  readonly roomTypeId: string;
  readonly nights: number;
  readonly currency: string;
  readonly netAmount: number;
  readonly ivaAmount: number;
  readonly ishAmount: number;
  readonly totalAmount: number;
  readonly nightlyBreakdown: readonly CotizacionNoche[];
}

export function cotizar(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { readonly roomTypeId: string; readonly checkInDate: string; readonly checkOutDate: string }): Promise<Cotizacion> {
  return sendJson<Cotizacion>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/quotes`, token, "POST", input);
}

/** Validacion previa al envio (el servidor vuelve a validar): tipo elegido y salida posterior a la llegada. */
export function validarCotizacion(roomTypeId: string, entrada: string, salida: string): string | null {
  if (!roomTypeId) return "Elige un tipo de habitación.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entrada) || !/^\d{4}-\d{2}-\d{2}$/.test(salida)) return "Elige las fechas de llegada y salida.";
  if (salida <= entrada) return "La salida debe ser posterior a la llegada.";
  return null;
}
