// H-P3-04 -- cliente de la configuracion del hotel (`apps/api/src/routes/verticals/hoteles/configuracion.ts`): impuestos, politica de
// cancelacion, sobreventa por tipo, tarifas por noche y bitacora de cambios. Nada se calcula aqui: cada valor sale del servidor.
import { fetchJson, sendJson } from "./admin-client.ts";

/** Roles que ven la pantalla Configuracion (accountant solo lee). */
export const CONFIGURACION_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "accountant"]);
export const CONFIGURACION_ESCRITURA_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);

export interface Impuestos {
  readonly ivaRate: number;
  readonly ishRate: number;
  readonly discountThreshold: number;
  readonly dsaPerNight: number;
  readonly configurado: boolean;
  readonly aviso: string;
}

export interface PoliticaCancelacion {
  readonly freeUntilHours: number;
  readonly penaltyPct: number;
  readonly guestText: string | null;
  readonly configurado: boolean;
}

export interface SobreventaTipo {
  readonly roomTypeId: string;
  readonly name: string;
  readonly maxOverbookRooms: number;
  readonly thresholdPct: number;
}

export interface Tarifa {
  readonly id: string;
  readonly roomTypeId: string;
  readonly roomTypeName: string;
  readonly date: string;
  readonly price: number;
  readonly currency: string;
  readonly minStay: number;
  readonly closedToArrival: boolean;
  readonly closedToDeparture: boolean;
  /** Cuando un humano fijo el precio (el motor de revenue no lo sobreescribe). `null` = nunca fijado a mano. */
  readonly manualPriceAt: string | null;
}

export interface TarifasRespuesta {
  readonly desde: string;
  readonly hasta: string;
  readonly tarifas: readonly Tarifa[];
  readonly truncado: boolean;
}

export interface EntradaBitacora {
  readonly id: string;
  readonly area: "impuestos" | "politica_cancelacion" | "sobreventa" | "tarifa" | "onboarding_omitido";
  readonly entityId: string | null;
  readonly actorUserId: string | null;
  readonly valorAnterior: Record<string, unknown> | null;
  readonly valorNuevo: Record<string, unknown>;
  readonly createdAt: string;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}`;

export function fetchImpuestos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<Impuestos> {
  return fetchJson<Impuestos>(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion/impuestos`, token);
}

export function guardarImpuestos(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly ivaRate: number; readonly ishRate: number; readonly discountThreshold: number; readonly dsaPerNight: number },
): Promise<Impuestos> {
  return sendJson<Impuestos>(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion/impuestos`, token, "PUT", input);
}

export function fetchPoliticaCancelacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<PoliticaCancelacion> {
  return fetchJson<PoliticaCancelacion>(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion/politica-cancelacion`, token);
}

export function guardarPoliticaCancelacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly freeUntilHours: number; readonly penaltyPct: number; readonly guestText: string | null },
): Promise<PoliticaCancelacion> {
  return sendJson<PoliticaCancelacion>(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion/politica-cancelacion`, token, "PUT", input);
}

export async function fetchSobreventa(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly SobreventaTipo[]> {
  return (await fetchJson<{ tipos: SobreventaTipo[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion/sobreventa`, token)).tipos;
}

export function guardarSobreventa(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  roomTypeId: string,
  input: { readonly maxOverbookRooms: number; readonly thresholdPct?: number },
): Promise<SobreventaTipo> {
  return sendJson<SobreventaTipo>(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion/sobreventa/${roomTypeId}`, token, "PUT", input);
}

export function fetchTarifas(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  filtros: { readonly desde?: string; readonly hasta?: string; readonly roomTypeId?: string },
): Promise<TarifasRespuesta> {
  const q = new URLSearchParams();
  if (filtros.desde) q.set("desde", filtros.desde);
  if (filtros.hasta) q.set("hasta", filtros.hasta);
  if (filtros.roomTypeId) q.set("roomTypeId", filtros.roomTypeId);
  const qs = q.toString();
  return fetchJson<TarifasRespuesta>(fetchImpl, `${base(apiBaseUrl, propertyId)}/tarifas${qs ? `?${qs}` : ""}`, token);
}

export function guardarPrecioTarifa(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  rateId: string,
  input: { readonly precio: number; readonly estanciaMinima?: number },
): Promise<Tarifa> {
  return sendJson<Tarifa>(fetchImpl, `${base(apiBaseUrl, propertyId)}/tarifas/${rateId}`, token, "PUT", input);
}

export async function fetchBitacoraConfiguracion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly EntradaBitacora[]> {
  return (await fetchJson<{ entradas: EntradaBitacora[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion/bitacora?limit=100`, token)).entradas;
}
