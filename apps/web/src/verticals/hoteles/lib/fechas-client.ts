// H-28 -- cliente del cambio de fechas con recotizacion. Consume apps/api/src/routes/verticals/hoteles/reservas-fechas.ts.
// `fetchImpl` inyectado (mismo criterio que el resto de lib/*.ts). El total SIEMPRE lo calcula el servidor: el cliente solo
// reenvia el total que vio en la previsualizacion (`totalEsperado`) como guardia de precio.
import { sendJson } from "./admin-client.ts";

export interface DesgloseEstancia {
  readonly entrada: string;
  readonly salida: string;
  readonly noches: number;
  readonly neto: number;
  readonly iva: number;
  readonly ish: number;
  readonly total: number;
}

export interface PrevisualizacionFechas {
  readonly reservaId: string;
  readonly estado: string;
  readonly moneda: string;
  readonly puedeCambiar: boolean;
  readonly bloqueos: readonly { readonly codigo: string; readonly mensaje: string }[];
  readonly actual: DesgloseEstancia;
  readonly nueva: DesgloseEstancia | null;
  readonly diferenciaTotal: number | null;
  readonly nochesAgregadas: readonly string[];
  readonly nochesQuitadas: readonly string[];
  readonly nochesSinCupo: readonly string[];
  readonly penalidad: { readonly monto: number; readonly porcentaje: number; readonly horasParaLaNoche: number | null };
}

export interface CambioFechasResultado {
  readonly reserva: { readonly id: string; readonly checkInDate: string; readonly checkOutDate: string; readonly estado: string; readonly montoTotal: number } | null;
  readonly cambio: { readonly entradaAnterior: string; readonly salidaAnterior: string; readonly nochesLiberadas: number; readonly nochesReservadas: number };
  readonly totalAnterior: number;
  readonly totalNuevo: number;
  readonly penalidad: { readonly monto: number; readonly porcentaje: number };
  readonly ofertasListaEspera: number;
}

/** Estados en los que el servidor acepta un cambio de fechas (espejo cosmetico de `MODIFICABLES` en domain-hoteles). */
export const ESTADOS_CON_CAMBIO_DE_FECHAS: ReadonlySet<string> = new Set(["confirmada", "check_in", "en_estancia"]);
/** Roles que cambian fechas (espejo cosmetico de MANAGE_RESERVATIONS_ROLES): el servidor es la unica barrera real (403). */
export const FECHAS_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);
export const ESTADOS_EN_CASA: ReadonlySet<string> = new Set(["check_in", "en_estancia"]);

const base = (apiBaseUrl: string, propertyId: string, reservaId: string) => `${apiBaseUrl}/hoteles/${propertyId}/reservas/${reservaId}/fechas`;

export function previsualizarFechas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reservaId: string, checkInDate: string, checkOutDate: string): Promise<PrevisualizacionFechas> {
  return sendJson<PrevisualizacionFechas>(fetchImpl, `${base(apiBaseUrl, propertyId, reservaId)}/previsualizar`, token, "POST", { checkInDate, checkOutDate });
}

export function cambiarFechas(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  reservaId: string,
  input: { readonly checkInDate: string; readonly checkOutDate: string; readonly totalEsperado: number; readonly motivo?: string },
  idempotencyKey: string,
): Promise<CambioFechasResultado> {
  return sendJson<CambioFechasResultado>(fetchImpl, base(apiBaseUrl, propertyId, reservaId), token, "PATCH", input, idempotencyKey);
}
