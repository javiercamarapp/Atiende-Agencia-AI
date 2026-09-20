// FASE 3 (producto) — cliente real de admin-config.ts: configuración editable del
// panel (owner/admin) para el número de WhatsApp conectado y las zonas conocidas
// que usa el emparejamiento de sucursal más cercana. Ambas tablas ya existían sin
// ninguna ruta de escritura — ver el comentario de cabecera de
// packages/domain-restaurantes/migrations/
// 021_restaurantes_config_editable_y_search_path_fix.sql. Mismo criterio de
// `fetchImpl` inyectado que el resto de lib/*.ts de este vertical (ver
// admin-client.ts).
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

export interface WhatsappChannelConfig {
  readonly phoneNumberId: string | null;
}

export async function fetchWhatsappConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<WhatsappChannelConfig> {
  return fetchJson<WhatsappChannelConfig>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/whatsapp`, token);
}

export async function updateWhatsappConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, phoneNumberId: string): Promise<WhatsappChannelConfig> {
  return sendJson<WhatsappChannelConfig>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/whatsapp`, token, "PUT", { phoneNumberId });
}

export interface KnownZone {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly createdAt: string;
}

export async function fetchKnownZones(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly KnownZone[]> {
  const body = await fetchJson<{ zonas: KnownZone[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/zonas`, token);
  return body.zonas;
}

export async function createKnownZone(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly name: string; readonly lat: number; readonly lng: number },
): Promise<KnownZone> {
  return sendJson<KnownZone>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/zonas`, token, "POST", input);
}

export async function deleteKnownZone(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, zoneId: string): Promise<void> {
  await deleteJson<{ ok: true }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/zonas/${zoneId}`, token);
}

// FASE 3 (producto) -- zona horaria por negocio (migración 022,
// `restaurantes.branch_detail.zona_horaria`). A diferencia de whatsapp/zonas
// (organization-scoped), esto es POR SUCURSAL -- mismo grano que el resto del
// panel de admin-config.ts.
export interface BranchTimezoneConfig {
  readonly zonaHoraria: string | null;
}

export async function fetchBranchTimezone(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<BranchTimezoneConfig> {
  return fetchJson<BranchTimezoneConfig>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/zona-horaria`, token);
}

export async function updateBranchTimezone(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, zonaHoraria: string | null): Promise<BranchTimezoneConfig> {
  return sendJson<BranchTimezoneConfig>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/zona-horaria`, token, "PATCH", { zona_horaria: zonaHoraria });
}
