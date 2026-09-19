// Lógica de datos de Proveedores — lista + ficha (Fase 5) y, desde Fase 8, alta/
// edición real de un proveedor + el checkbox real de qué servicios ofrece
// (`provider_services`, ver admin.ts::PUT .../services/:serviceId). La única
// acción que la página seguía ofreciendo antes de Fase 8 era conectar Google
// Calendar (Fase 3, google-calendar-oauth.ts) — este archivo sigue pidiendo la
// `authorize_url` real ahí, sin cambios.
import { deleteJson, fetchJson, postJson, sendJson } from "./admin-client.ts";

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

// ============================================================================
// Fase 6 §2 (seguimiento) — Cal.com/CalDAV, "Calendarios conectados" (mismo
// estado que Google: connected/sync_status/sync_error) más la metadata pública
// de la conexión (event_type_id/base_url de Cal.com, calendar_collection_url/
// username de CalDAV) — el secreto (api_key/contraseña de aplicación) NUNCA
// viaja en ninguna de estas respuestas.
// ============================================================================

export type CalendarProviderSyncStatus = "disconnected" | "connected" | "error";

// Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — resumen de
// "sincronizaciones con problema" de ESTE proveedor (nunca por plataforma, ver
// @atiende/domain-citas::CalendarSyncIssuesSummary): número de citas actualmente
// con rechazo PERMANENTE de validación + el motivo normalizado de la más
// reciente. Se autolimpia solo (en cuanto el staff corrige el dato y reintenta,
// esa cita deja de contar) — nunca marca la cuenta entera en error por esto, ver
// Proveedores.tsx para la advertencia ámbar.
export interface CalendarSyncIssuesSummary {
  readonly count: number;
  readonly lastReason: string | null;
}

interface CalendarSyncIssuesApiBody {
  readonly count: number;
  readonly last_reason: string | null;
}

const EMPTY_SYNC_ISSUES: CalendarSyncIssuesSummary = { count: 0, lastReason: null };

function mapSyncIssues(row: CalendarSyncIssuesApiBody | undefined): CalendarSyncIssuesSummary {
  return row ? { count: row.count, lastReason: row.last_reason } : EMPTY_SYNC_ISSUES;
}

export interface CalComStatus {
  readonly connected: boolean;
  readonly syncStatus: CalendarProviderSyncStatus;
  readonly syncError: string | null;
  readonly eventTypeId: string | null;
  readonly baseUrl: string | null;
  readonly syncIssues: CalendarSyncIssuesSummary;
}

export interface CalDavStatus {
  readonly connected: boolean;
  readonly syncStatus: CalendarProviderSyncStatus;
  readonly syncError: string | null;
  readonly calendarCollectionUrl: string | null;
  readonly username: string | null;
  readonly syncIssues: CalendarSyncIssuesSummary;
}

interface CalComStatusApiBody {
  readonly connected: boolean;
  readonly sync_status: CalendarProviderSyncStatus;
  readonly sync_error: string | null;
  readonly calcom_event_type_id: string | null;
  readonly calcom_base_url: string | null;
  readonly sync_issues?: CalendarSyncIssuesApiBody;
}

interface CalDavStatusApiBody {
  readonly connected: boolean;
  readonly sync_status: CalendarProviderSyncStatus;
  readonly sync_error: string | null;
  readonly calendar_collection_url: string | null;
  readonly username: string | null;
  readonly sync_issues?: CalendarSyncIssuesApiBody;
}

function mapCalComStatus(row: CalComStatusApiBody): CalComStatus {
  return { connected: row.connected, syncStatus: row.sync_status, syncError: row.sync_error, eventTypeId: row.calcom_event_type_id, baseUrl: row.calcom_base_url, syncIssues: mapSyncIssues(row.sync_issues) };
}

function mapCalDavStatus(row: CalDavStatusApiBody): CalDavStatus {
  return { connected: row.connected, syncStatus: row.sync_status, syncError: row.sync_error, calendarCollectionUrl: row.calendar_collection_url, username: row.username, syncIssues: mapSyncIssues(row.sync_issues) };
}

export interface ProviderDetail {
  readonly provider: ProviderSummary;
  readonly availabilityRules: readonly AvailabilityRuleSummary[];
  readonly googleCalendar: GoogleCalendarStatus;
  readonly calcom: CalComStatus;
  readonly caldav: CalDavStatus;
  /** Fase 6 §2 (seguimiento) — UN solo resumen por proveedor (nunca por
   * plataforma), ver `CalendarSyncIssuesSummary`. */
  readonly calendarSyncIssues: CalendarSyncIssuesSummary;
  /** Fase 8 — ids de los servicios (activos) que este proveedor ya ofrece hoy, ver
   * admin.ts::GET .../providers/:providerId. */
  readonly offeredServiceIds: readonly string[];
}

interface ProviderDetailApiBody {
  readonly provider: ProviderApiRow;
  readonly availability_rules: readonly { id: string; day_of_week: number; start_time: string; end_time: string; is_active: boolean }[];
  readonly google_calendar: { connected: boolean; sync_status: GoogleCalendarSyncStatus; sync_error: string | null };
  readonly calcom: CalComStatusApiBody;
  readonly caldav: CalDavStatusApiBody;
  readonly calendar_sync_issues?: CalendarSyncIssuesApiBody;
  readonly offered_service_ids: readonly string[];
}

export async function fetchProviderDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<ProviderDetail> {
  const body = await fetchJson<ProviderDetailApiBody>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}`, token);
  return {
    provider: mapProvider(body.provider),
    availabilityRules: body.availability_rules.map((r) => ({ id: r.id, dayOfWeek: r.day_of_week, startTime: r.start_time, endTime: r.end_time, isActive: r.is_active })),
    googleCalendar: { connected: body.google_calendar.connected, syncStatus: body.google_calendar.sync_status, syncError: body.google_calendar.sync_error },
    calcom: mapCalComStatus(body.calcom),
    caldav: mapCalDavStatus(body.caldav),
    calendarSyncIssues: mapSyncIssues(body.calendar_sync_issues),
    offeredServiceIds: body.offered_service_ids,
  };
}

export interface ConnectCalComInput {
  readonly apiKey: string;
  readonly eventTypeId: string;
  /** URL base de una instancia Cal.com self-hosted -- vacío/omitido = SaaS oficial. */
  readonly baseUrl?: string;
}

export async function connectCalCom(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string, input: ConnectCalComInput): Promise<CalComStatus> {
  const body = await sendJson<{ connected: boolean; provider_id: string; calcom_event_type_id: string; calcom_base_url: string | null; sync_status: CalendarProviderSyncStatus }>(
    fetchImpl,
    `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/calcom/connect`,
    token,
    "POST",
    { api_key: input.apiKey, event_type_id: input.eventTypeId, ...(input.baseUrl ? { base_url: input.baseUrl } : {}) },
  );
  return { connected: body.connected, syncStatus: body.sync_status, syncError: null, eventTypeId: body.calcom_event_type_id, baseUrl: body.calcom_base_url, syncIssues: EMPTY_SYNC_ISSUES };
}

export async function disconnectCalCom(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<void> {
  await sendJson(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/calcom/disconnect`, token, "POST", {});
}

export async function fetchCalComStatus(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<CalComStatus> {
  const body = await fetchJson<CalComStatusApiBody>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/calcom/status`, token);
  return mapCalComStatus(body);
}

/** Prueba de conexión real contra la cuenta YA conectada (nunca pide credenciales
 * de nuevo) -- ver apps/api/.../citas/calendar-providers.ts::POST .../calcom/test-connection. */
export async function testCalComConnection(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<{ readonly ok: boolean; readonly checkedAt: string }> {
  const body = await postJson<{ ok: boolean; checked_at: string }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/calcom/test-connection`, token);
  return { ok: body.ok, checkedAt: body.checked_at };
}

export interface ConnectCalDavInput {
  readonly calendarCollectionUrl: string;
  readonly username: string;
  readonly password: string;
}

export async function connectCalDav(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string, input: ConnectCalDavInput): Promise<CalDavStatus> {
  const body = await sendJson<{ connected: boolean; provider_id: string; calendar_collection_url: string; username: string; sync_status: CalendarProviderSyncStatus }>(
    fetchImpl,
    `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/caldav/connect`,
    token,
    "POST",
    { calendar_collection_url: input.calendarCollectionUrl, username: input.username, password: input.password },
  );
  return { connected: body.connected, syncStatus: body.sync_status, syncError: null, calendarCollectionUrl: body.calendar_collection_url, username: body.username, syncIssues: EMPTY_SYNC_ISSUES };
}

export async function disconnectCalDav(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<void> {
  await sendJson(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/caldav/disconnect`, token, "POST", {});
}

export async function fetchCalDavStatus(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<CalDavStatus> {
  const body = await fetchJson<CalDavStatusApiBody>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/caldav/status`, token);
  return mapCalDavStatus(body);
}

export async function testCalDavConnection(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<{ readonly ok: boolean; readonly checkedAt: string }> {
  const body = await postJson<{ ok: boolean; checked_at: string }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/caldav/test-connection`, token);
  return { ok: body.ok, checkedAt: body.checked_at };
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
  const body = await fetchJson<{ authorize_url: string }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}/google-calendar/connect`, token);
  return body.authorize_url;
}
