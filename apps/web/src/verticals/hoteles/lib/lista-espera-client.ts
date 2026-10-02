// H-12 -- cliente de la lista de espera. Consume apps/api/src/routes/verticals/hoteles/lista-espera.ts.
import { fetchJson, sendJson } from "./admin-client.ts";

export type EstadoListaEspera = "activa" | "ofrecida" | "aceptada" | "expirada" | "cancelada";

export const ESTADO_LISTA_ESPERA_LABELS: Record<EstadoListaEspera, string> = {
  activa: "En espera",
  ofrecida: "Ofrecida",
  aceptada: "Aceptada",
  expirada: "Vencida",
  cancelada: "Cancelada",
};

export interface EntradaListaEspera {
  readonly id: string;
  readonly tipoHabitacionId: string;
  readonly entrada: string;
  readonly salida: string;
  readonly huespedes: number;
  readonly nombre: string;
  readonly telefono: string | null;
  readonly email: string | null;
  readonly notas: string | null;
  readonly estado: EstadoListaEspera;
  readonly ofrecidaEn: string | null;
  readonly ofertaVenceEn: string | null;
  readonly reservaId: string | null;
  readonly creadaEn: string;
  /** Solo en ofertas vigentes: lo que costaria hoy (con impuestos); null si no se pudo cotizar. */
  readonly cotizacionVigente: { readonly total: number; readonly noches: number; readonly moneda: string } | null;
}

export interface ListadoListaEspera {
  /** false = la base aun no tiene la migracion 041: lista vacia + estado honesto. */
  readonly disponible: boolean;
  readonly entradas: readonly EntradaListaEspera[];
}

export interface NuevaEntradaInput {
  readonly roomTypeId: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly huespedes: number;
  readonly nombre: string;
  readonly telefono?: string;
  readonly email?: string;
  readonly notas?: string;
}

/** Espejo cosmetico de MANAGE_RESERVATIONS_ROLES: el servidor es la unica barrera real (403). */
export const LISTA_ESPERA_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/lista-espera`;

export function fetchListaEspera(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ListadoListaEspera> {
  return fetchJson<ListadoListaEspera>(fetchImpl, base(apiBaseUrl, propertyId), token);
}

export function agregarAListaEspera(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NuevaEntradaInput): Promise<EntradaListaEspera> {
  return sendJson<EntradaListaEspera>(fetchImpl, base(apiBaseUrl, propertyId), token, "POST", input);
}

export function cancelarEntrada(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<EntradaListaEspera> {
  return sendJson<EntradaListaEspera>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/cancelar`, token, "POST", {});
}

export function ofrecerEntrada(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, horas?: number): Promise<EntradaListaEspera> {
  return sendJson<EntradaListaEspera>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/ofrecer`, token, "POST", horas ? { horas } : {});
}

export function aceptarEntrada(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  id: string,
  totalEsperado: number,
  idempotencyKey: string,
): Promise<{ readonly entrada: EntradaListaEspera; readonly reserva: { readonly id: string; readonly checkInDate: string; readonly checkOutDate: string } }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/aceptar`, token, "POST", { totalEsperado }, idempotencyKey);
}
