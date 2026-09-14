// Lógica de datos de Proveedores — lista + ficha (Fase 5) y, desde Fase 8, alta/
// edición real de un proveedor + el checkbox real de qué servicios ofrece
// (`provider_services`, ver admin.ts::PUT .../services/:serviceId). La única
// acción que la página seguía ofreciendo antes de Fase 8 era conectar Google
// Calendar (Fase 3, google-calendar-oauth.ts) — este archivo sigue pidiendo la
// `authorize_url` real ahí, sin cambios.
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

export interface ProviderSummary {
  readonly id: string;
  readonly propertyId: string | null;
  readonly displayName: string;
  readonly roleLabel: string;
  readonly isActive: boolean;
}

interface ProviderApiRow {
  readonly id: string;
  readonly property_id: string | null;
  readonly display_name: string;
  readonly role_label: string;
  readonly is_active: boolean;
}

function mapProvider(row: ProviderApiRow): ProviderSummary {
  return { id: row.id, propertyId: row.property_id, displayName: row.display_name, roleLabel: row.role_label, isActive: row.is_active };
}

export async function fetchProviders(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly ProviderSummary[]> {
  const body = await fetchJson<{ providers: readonly ProviderApiRow[] }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers`, token);
  return body.providers.map(mapProvider);
}

export interface NewProviderInput {
  readonly displayName: string;
  readonly roleLabel?: string;
  readonly propertyId?: string | null;
  readonly isActive?: boolean;
}

export interface ProviderPatch {
  readonly displayName?: string;
  readonly roleLabel?: string;
  readonly propertyId?: string | null;
  readonly isActive?: boolean;
}

export async function createProvider(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NewProviderInput): Promise<ProviderSummary> {
  const body = await sendJson<{ provider: ProviderApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers`, token, "POST", {
    display_name: input.displayName,
    role_label: input.roleLabel,
    property_id: input.propertyId,
    is_active: input.isActive,
  });
  return mapProvider(body.provider);
}

export async function updateProvider(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string, patch: ProviderPatch): Promise<ProviderSummary> {
  const body = await sendJson<{ provider: ProviderApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}`, token, "PATCH", {
    display_name: patch.displayName,
    role_label: patch.roleLabel,
    property_id: patch.propertyId,
    is_active: patch.isActive,
  });
  return mapProvider(body.provider);
}

/** Checkbox real de `FichaProveedor.tsx::toggleServicio` del origen — marca/quita
 * que este proveedor ofrezca `serviceId` (`citas.provider_services`). */
export async function setProviderServiceOffering(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string, serviceId: string, offered: boolean): Promise<void> {
  await sendJson(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/services/${serviceId}`, token, "PUT", { offered });
}

export interface AvailabilityRuleSummary {
  readonly id: string;
  readonly dayOfWeek: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly isActive: boolean;
}

export type GoogleCalendarSyncStatus = "disconnected" | "connected" | "error";

export interface GoogleCalendarStatus {
  readonly connected: boolean;
  readonly syncStatus: GoogleCalendarSyncStatus;
  readonly syncError: string | null;
}

export interface ProviderDetail {
  readonly provider: ProviderSummary;
  readonly availabilityRules: readonly AvailabilityRuleSummary[];
  readonly googleCalendar: GoogleCalendarStatus;
  /** Fase 8 — ids de los servicios (activos) que este proveedor ya ofrece hoy, ver
   * admin.ts::GET .../providers/:providerId. */
  readonly offeredServiceIds: readonly string[];
}

interface ProviderDetailApiBody {
  readonly provider: ProviderApiRow;
  readonly availability_rules: readonly { id: string; day_of_week: number; start_time: string; end_time: string; is_active: boolean }[];
  readonly google_calendar: { connected: boolean; sync_status: GoogleCalendarSyncStatus; sync_error: string | null };
  readonly offered_service_ids: readonly string[];
}

export async function fetchProviderDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<ProviderDetail> {
  const body = await fetchJson<ProviderDetailApiBody>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}`, token);
  return {
    provider: mapProvider(body.provider),
    availabilityRules: body.availability_rules.map((r) => ({ id: r.id, dayOfWeek: r.day_of_week, startTime: r.start_time, endTime: r.end_time, isActive: r.is_active })),
    googleCalendar: { connected: body.google_calendar.connected, syncStatus: body.google_calendar.sync_status, syncError: body.google_calendar.sync_error },
    offeredServiceIds: body.offered_service_ids,
  };
}

// ============================================================================
// Fase 10 — CRUD real de horarios/excepciones (ver admin.ts::POST/PATCH/DELETE
// .../availability-rules[/:ruleId] y .../availability-overrides[/:date]). Antes de
// esta fase, `AvailabilityRuleSummary` (arriba) solo se leía desde
// `fetchProviderDetail` — Disponibilidad.tsx era de solo lectura.
// ============================================================================

export interface NewAvailabilityRuleInput {
  readonly dayOfWeek: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly isActive?: boolean;
}

export interface AvailabilityRulePatch {
  readonly dayOfWeek?: number;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly isActive?: boolean;
}

interface AvailabilityRuleApiRow {
  readonly id: string;
  readonly day_of_week: number;
  readonly start_time: string;
  readonly end_time: string;
  readonly is_active: boolean;
}

function mapAvailabilityRule(row: AvailabilityRuleApiRow): AvailabilityRuleSummary {
  return { id: row.id, dayOfWeek: row.day_of_week, startTime: row.start_time, endTime: row.end_time, isActive: row.is_active };
}

export async function createAvailabilityRule(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  providerId: string,
  input: NewAvailabilityRuleInput,
): Promise<AvailabilityRuleSummary> {
  const body = await sendJson<{ availability_rule: AvailabilityRuleApiRow }>(
    fetchImpl,
    `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/availability-rules`,
    token,
    "POST",
    { day_of_week: input.dayOfWeek, start_time: input.startTime, end_time: input.endTime, is_active: input.isActive },
  );
  return mapAvailabilityRule(body.availability_rule);
}

export async function updateAvailabilityRule(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  providerId: string,
  ruleId: string,
  patch: AvailabilityRulePatch,
): Promise<AvailabilityRuleSummary> {
  const body = await sendJson<{ availability_rule: AvailabilityRuleApiRow }>(
    fetchImpl,
    `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/availability-rules/${ruleId}`,
    token,
    "PATCH",
    { day_of_week: patch.dayOfWeek, start_time: patch.startTime, end_time: patch.endTime, is_active: patch.isActive },
  );
  return mapAvailabilityRule(body.availability_rule);
}

export async function deleteAvailabilityRule(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string, ruleId: string): Promise<void> {
  await deleteJson(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/availability-rules/${ruleId}`, token);
}

export interface AvailabilityOverrideSummary {
  readonly overrideDate: string;
  readonly isClosed: boolean;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly reason: string | null;
}

export interface AvailabilityOverrideUpsertInput {
  readonly isClosed: boolean;
  readonly startTime?: string | null;
  readonly endTime?: string | null;
  readonly reason?: string | null;
}

interface AvailabilityOverrideApiRow {
  readonly override_date: string;
  readonly is_closed: boolean;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly reason: string | null;
}

function mapAvailabilityOverride(row: AvailabilityOverrideApiRow): AvailabilityOverrideSummary {
  return { overrideDate: row.override_date, isClosed: row.is_closed, startTime: row.start_time, endTime: row.end_time, reason: row.reason };
}

/** Lista solo excepciones de hoy en adelante (ver admin.ts::GET
 * .../availability-overrides) — el panel edita el futuro, nunca un cierre ya pasado. */
export async function fetchAvailabilityOverrides(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<readonly AvailabilityOverrideSummary[]> {
  const body = await fetchJson<{ availability_overrides: readonly AvailabilityOverrideApiRow[] }>(
    fetchImpl,
    `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/availability-overrides`,
    token,
  );
  return body.availability_overrides.map(mapAvailabilityOverride);
}

export async function upsertAvailabilityOverride(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  providerId: string,
  overrideDate: string,
  input: AvailabilityOverrideUpsertInput,
): Promise<AvailabilityOverrideSummary> {
  const body = await sendJson<{ availability_override: AvailabilityOverrideApiRow }>(
    fetchImpl,
    `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/availability-overrides/${overrideDate}`,
    token,
    "PUT",
    { is_closed: input.isClosed, start_time: input.startTime, end_time: input.endTime, reason: input.reason },
  );
  return mapAvailabilityOverride(body.availability_override);
}

export async function deleteAvailabilityOverride(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string, overrideDate: string): Promise<void> {
  await deleteJson(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/availability-overrides/${overrideDate}`, token);
}

/** Pide la URL real de consentimiento de Google (Fase 3, ver google-calendar-oauth.ts)
 * — el caller (Proveedores.tsx/Configuracion.tsx) navega ahí (`window.location.href`),
 * nunca la abre este módulo directamente (mantiene la lógica de red testeable sin DOM). */
export async function requestGoogleCalendarConnectUrl(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<string> {
  const res = await fetchImpl(`${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/google-calendar/connect`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `No se pudo iniciar la conexión con Google Calendar (${res.status}).`);
  }
  const body = (await res.json()) as { authorize_url: string };
  return body.authorize_url;
}
