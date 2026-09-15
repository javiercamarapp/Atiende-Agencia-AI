// Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
// tarifas/huéspedes imposible sin SQL directo -- POST /reservas depende de
// tarifas sembradas manualmente"): consume
// apps/api/src/routes/verticals/hoteles/admin-catalogo.ts. Alta de HUÉSPED y
// asignación de habitación viven en reservas-client.ts (acciones de
// front-of-house, no de catálogo) -- ver el comentario de cabecera de
// admin-catalogo.ts para por qué están separadas.
import { fetchJson, sendJson } from "./admin-client.ts";
import type { RoomOption, RoomTypeOption } from "./reservas-client.ts";

export async function createRoomType(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, nombre: string, capacidadMaxima?: number): Promise<RoomTypeOption> {
  return sendJson<RoomTypeOption>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/tipos-habitacion`, token, "POST", { nombre, capacidadMaxima });
}

export async function fetchAllRooms(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly RoomOption[]> {
  return fetchJson<readonly RoomOption[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/habitaciones`, token);
}

export async function createRoom(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, roomTypeId: string, codigo: string): Promise<RoomOption> {
  return sendJson<RoomOption>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/tipos-habitacion/${roomTypeId}/habitaciones`, token, "POST", { codigo });
}

export interface CreateRateRangeInput {
  readonly roomTypeId: string;
  readonly fechaInicio: string;
  readonly fechaFin: string;
  readonly precio: number;
  readonly moneda?: string;
  readonly estanciaMinima?: number;
  readonly cerradoLlegada?: boolean;
  readonly cerradoSalida?: boolean;
}

export interface CreateRateRangeResult {
  readonly roomTypeId: string;
  readonly fechaInicio: string;
  readonly fechaFin: string;
  readonly precio: number;
  readonly moneda: string;
  readonly nochesSembradas: number;
}

export async function createRateRange(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: CreateRateRangeInput): Promise<CreateRateRangeResult> {
  return sendJson<CreateRateRangeResult>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/tarifas`, token, "POST", input);
}
