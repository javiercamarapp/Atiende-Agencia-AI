// Cliente real de apps/api/src/routes/verticals/restaurantes/admin-modelo-pm.ts (modelo PM,
// migración 023): política por sucursal (horario / pedido mínimo por canal / propina),
// cobertura de entrega, número de WhatsApp por sucursal y marcas "no se vende a domicilio".
// Mismo criterio de `fetchImpl` inyectado que el resto de lib/*.ts (ver admin-client.ts).
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

export type PropinaPolitica = "nunca" | "siempre" | "solo_tarjeta";

export interface TurnoHorario {
  /** 0 = domingo .. 6 = sábado. */
  readonly dias: readonly number[];
  readonly abre: string;
  /** Si es menor o igual a `abre`, el turno termina pasada la medianoche. */
  readonly cierra: string;
}

export interface PoliticaSucursal {
  readonly horario: readonly TurnoHorario[] | null;
  readonly pedidoMinimoDomicilio: number | null;
  readonly pedidoMinimoRecoger: number | null;
  readonly propinaPolitica: PropinaPolitica | null;
}

const branchBase = (apiBaseUrl: string, propertyId: string, branchId: string) => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/sucursales/${branchId}`;

export async function fetchPoliticaSucursal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string): Promise<PoliticaSucursal> {
  return fetchJson<PoliticaSucursal>(fetchImpl, `${branchBase(apiBaseUrl, propertyId, branchId)}/politica`, token);
}

/** Reemplaza la política COMPLETA (todos los campos, valor o null). */
export async function updatePoliticaSucursal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string, politica: PoliticaSucursal): Promise<PoliticaSucursal> {
  return sendJson<PoliticaSucursal>(fetchImpl, `${branchBase(apiBaseUrl, propertyId, branchId)}/politica`, token, "PUT", politica);
}

export async function fetchZonasReparto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string): Promise<readonly string[]> {
  const body = await fetchJson<{ zoneIds: string[] }>(fetchImpl, `${branchBase(apiBaseUrl, propertyId, branchId)}/zonas-reparto`, token);
  return body.zoneIds;
}

export async function updateZonasReparto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string, zoneIds: readonly string[]): Promise<readonly string[]> {
  const body = await sendJson<{ zoneIds: string[] }>(fetchImpl, `${branchBase(apiBaseUrl, propertyId, branchId)}/zonas-reparto`, token, "PUT", { zoneIds });
  return body.zoneIds;
}

export async function fetchWhatsappSucursal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string): Promise<string | null> {
  const body = await fetchJson<{ phoneNumberId: string | null }>(fetchImpl, `${branchBase(apiBaseUrl, propertyId, branchId)}/whatsapp`, token);
  return body.phoneNumberId;
}

export async function updateWhatsappSucursal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string, phoneNumberId: string): Promise<string | null> {
  const body = await sendJson<{ phoneNumberId: string | null }>(fetchImpl, `${branchBase(apiBaseUrl, propertyId, branchId)}/whatsapp`, token, "PUT", { phoneNumberId });
  return body.phoneNumberId;
}

export async function deleteWhatsappSucursal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string): Promise<void> {
  await deleteJson<{ ok: true }>(fetchImpl, `${branchBase(apiBaseUrl, propertyId, branchId)}/whatsapp`, token);
}

export interface NoDomicilioMarks {
  readonly productIds: readonly string[];
  readonly categoryIds: readonly string[];
}

export async function fetchNoDomicilio(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<NoDomicilioMarks> {
  return fetchJson<NoDomicilioMarks>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/no-domicilio`, token);
}

export async function setNoDomicilio(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, kind: "productos" | "categorias", id: string, noDomicilio: boolean): Promise<void> {
  await sendJson<{ id: string; noDomicilio: boolean }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/no-domicilio/${kind}/${id}`, token, "PUT", { noDomicilio });
}

// ---- puentes (migración 031): excepciones de horario por fecha ----

export interface Puente {
  readonly id: string;
  readonly branchId: string;
  readonly fechaDesde: string;
  readonly fechaHasta: string;
  readonly horario: readonly TurnoHorario[];
  readonly motivo: string | null;
}

export interface TurnoPuente {
  readonly abre: string;
  readonly cierra: string;
}

const puentesUrl = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/puentes`;

export async function fetchPuentes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly Puente[]> {
  const body = await fetchJson<{ puentes: Puente[] }>(fetchImpl, puentesUrl(apiBaseUrl, propertyId), token);
  return body.puentes;
}

/** Crea el MISMO puente para una o varias sucursales; `turnos` rigen todos los días del rango. */
export async function createPuente(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly branchIds: readonly string[]; readonly fechaDesde: string; readonly fechaHasta: string; readonly turnos?: readonly TurnoPuente[]; /** `true` = cierre de fecha completa (sin turnos). */ readonly cerrado?: boolean; readonly motivo?: string },
): Promise<readonly Puente[]> {
  const body = await sendJson<{ puentes: Puente[] }>(fetchImpl, puentesUrl(apiBaseUrl, propertyId), token, "POST", input);
  return body.puentes;
}

export async function deletePuente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, exceptionId: string): Promise<void> {
  await deleteJson<{ ok: true }>(fetchImpl, `${puentesUrl(apiBaseUrl, propertyId)}/${exceptionId}`, token);
}

// ---- helpers de formulario (puros, con test) ----

export const NOMBRES_DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;

/** "" -> null (sin mínimo); número >= 0 -> número; cualquier otra cosa -> undefined (inválido). */
export function parseMontoOpcional(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Texto legible de un turno: "Lun–Vie 12:00 a 01:00 (+1 día)". */
export function describirTurno(turno: TurnoHorario): string {
  const dias = turno.dias.length === 7 ? "Todos los días" : turno.dias.map((d) => NOMBRES_DIAS[d]).join(", ");
  const cruza = turno.cierra <= turno.abre ? " (cierra al día siguiente)" : "";
  return `${dias} ${turno.abre} a ${turno.cierra}${cruza}`;
}

// ---- reporte de colonias ambiguas (X42): solo lectura, GET .../admin/config/colonias-ambiguas ----

export type MotivoRevisionColonia = "ambigua" | "sin_asignar" | "contradice_distancia" | "reasignada_desde_galerias" | "distancia_de_otra_direccion_de_pensiones";

export interface FilaColoniaAmbigua {
  readonly zoneId: string;
  readonly colonia: string;
  readonly sucursalAsignada: { readonly slug: string; readonly nombre: string } | null;
  readonly variasSucursales: boolean;
  readonly kmAsignada: number | null;
  readonly segundaSucursal: { readonly slug: string; readonly nombre: string } | null;
  readonly segundaKm: number | null;
  readonly diferenciaKm: number | null;
  readonly origenKm: "piloto_original" | "calculada" | null;
  readonly procedencia: string | null;
  readonly revisar: boolean;
  readonly motivos: readonly MotivoRevisionColonia[];
}

export interface ReporteColoniasAmbiguas {
  /** `false` = la base todavía no tiene la migración 056. */
  readonly disponible: boolean;
  readonly total: number;
  readonly paraRevisar: number;
  readonly sinAsignar: number;
  readonly ambiguas: number;
  readonly filas: readonly FilaColoniaAmbigua[];
}

export const ETIQUETA_MOTIVO_COLONIA: Readonly<Record<MotivoRevisionColonia, string>> = {
  ambigua: "Las dos sucursales más cercanas quedan a menos de 1 km",
  sin_asignar: "Ninguna sucursal la cubre todavía: el agente la pasa a una persona",
  contradice_distancia: "La sucursal asignada no es la más cercana según el piloto",
  reasignada_desde_galerias: "La más cercana (Galerías) no reparte: se asignó la siguiente",
  distancia_de_otra_direccion_de_pensiones: "La distancia del piloto a Pensiones se calculó desde otra dirección",
};

export async function fetchColoniasAmbiguas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ReporteColoniasAmbiguas> {
  return fetchJson<ReporteColoniasAmbiguas>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/colonias-ambiguas`, token);
}
