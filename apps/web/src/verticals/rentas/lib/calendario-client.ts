// Lógica de datos del calendario de reservas y bloqueos (Fase 13) — separada de
// pages/Calendario.tsx a propósito, mismo motivo que discovery-client.ts: probarla
// con vitest en entorno "node" (sin DOM) mientras el componente solo la conecta a
// estado/render real. Consume los 2 GET nuevos de esta fase
// (apps/api/src/routes/verticals/rentas/calendario.ts) + los endpoints de
// crear/modificar/cancelar reservas (reservas.ts, Fase 1) y crear/cancelar bloqueos
// (bloqueos.ts, Fase 4) que ya existían en el backend sin ningún cliente web que los
// consumiera -- el hallazgo de auditoría que cierra esta fase.
//
// `RangoFechas`/`CapaOcupacion`/etc. se REDECLARAN aquí (en vez de importarse de
// @atiende/domain-rentas) a propósito: apps/web no depende de ningún paquete
// domain-* (ver package.json — solo react/react-dom/react-router-dom), mismo
// aislamiento que ya mantiene reservas-client.ts del vertical hoteles.
import { fetchJson, sendJson } from "./admin-client.ts";

export interface RangoFechas {
  readonly inicio: string;
  readonly fin: string;
}

export interface UnidadOption {
  readonly id: string;
  readonly nombre: string;
  readonly duracionMinimaNoches: number;
}

export type CapaOcupacion = "reserva" | "bloqueo";
export type RazonOcupacion = "RESERVA_CANAL" | "BLOQUEO_PROPIETARIO" | "MANTENIMIENTO" | "BUFFER_LIMPIEZA";
export type RazonBloqueo = Extract<RazonOcupacion, "BLOQUEO_PROPIETARIO" | "MANTENIMIENTO" | "BUFFER_LIMPIEZA">;
export type EstadoOcupacion = "confirmado" | "provisional" | "cancelado" | "conflicto_pendiente";

export const RAZONES_BLOQUEO: readonly RazonBloqueo[] = ["BLOQUEO_PROPIETARIO", "MANTENIMIENTO", "BUFFER_LIMPIEZA"];

export const RAZON_LABELS: Record<RazonOcupacion, string> = {
  RESERVA_CANAL: "Reserva",
  BLOQUEO_PROPIETARIO: "Bloqueo del propietario",
  MANTENIMIENTO: "Mantenimiento",
  BUFFER_LIMPIEZA: "Buffer de limpieza",
};

export const ESTADO_LABELS: Record<EstadoOcupacion, string> = {
  confirmado: "Confirmado",
  provisional: "Provisional",
  cancelado: "Cancelado",
  conflicto_pendiente: "Conflicto pendiente",
};

export interface OcupacionCalendario {
  readonly id: string;
  readonly unidadId: string;
  readonly capa: CapaOcupacion;
  readonly rango: RangoFechas;
  readonly razon: RazonOcupacion;
  readonly estado: EstadoOcupacion;
  readonly canalCodigo: string | null;
  readonly huespedNombre: string | null;
  readonly huespedContacto: string | null;
  readonly createdAt: string;
}

export async function fetchUnidades(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly UnidadOption[]> {
  const body = await fetchJson<{ unidades: readonly UnidadOption[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades`, token);
  return body.unidades;
}

export async function fetchOcupaciones(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
): Promise<readonly OcupacionCalendario[]> {
  const body = await fetchJson<{ ocupaciones: readonly OcupacionCalendario[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/ocupaciones`, token);
  return body.ocupaciones;
}

export interface CrearReservaInput {
  readonly rango: RangoFechas;
  readonly huespedNombre?: string;
  readonly huespedContacto?: string;
}

export async function createReserva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  input: CrearReservaInput,
): Promise<{ id: string; conflictosCapaCruzada: number }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/reservas`, token, "POST", input);
}

export async function modificarFechasReserva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  ocupacionId: string,
  rango: RangoFechas,
): Promise<{ id: string; rango: RangoFechas; conflictosCapaCruzada: number }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/reservas/${ocupacionId}`, token, "PATCH", { rango });
}

export async function cancelarReserva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  ocupacionId: string,
): Promise<{ id: string; estado: string; estadoAnterior: string }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/reservas/${ocupacionId}/cancelar`, token, "POST", {});
}

export interface CrearBloqueoInput {
  readonly rango: RangoFechas;
  readonly razon: RazonBloqueo;
}

export async function crearBloqueo(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  input: CrearBloqueoInput,
): Promise<{ id: string; conflictosCapaCruzada: number }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/bloqueos`, token, "POST", input);
}

export async function cancelarBloqueo(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  ocupacionId: string,
): Promise<{ id: string; estado: string; estadoAnterior: string }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/bloqueos/${ocupacionId}/cancelar`, token, "POST", {});
}
