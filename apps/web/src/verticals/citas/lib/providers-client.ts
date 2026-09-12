// Lógica de datos de Proveedores (Fase 5) — lista + ficha, siempre de solo
// lectura: domain-citas todavía no expone ninguna operación de escritura para
// crear/editar un proveedor (el dominio solo sabe `findProvider`/
// `listActiveProviders`, ver packages/domain-citas/src/repository.ts) — inventar
// esa escritura sería lógica de negocio nueva, fuera de alcance de esta fase (ver
// README de este directorio). La única acción real que esta página SÍ ofrece es
// conectar Google Calendar, que ya existía desde Fase 3
// (google-calendar-oauth.ts) — este archivo solo pide la `authorize_url` real.
import { fetchJson } from "./admin-client.ts";

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
}

interface ProviderDetailApiBody {
  readonly provider: ProviderApiRow;
  readonly availability_rules: readonly { id: string; day_of_week: number; start_time: string; end_time: string; is_active: boolean }[];
  readonly google_calendar: { connected: boolean; sync_status: GoogleCalendarSyncStatus; sync_error: string | null };
}

export async function fetchProviderDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, providerId: string): Promise<ProviderDetail> {
  const body = await fetchJson<ProviderDetailApiBody>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/providers/${providerId}`, token);
  return {
    provider: mapProvider(body.provider),
    availabilityRules: body.availability_rules.map((r) => ({ id: r.id, dayOfWeek: r.day_of_week, startTime: r.start_time, endTime: r.end_time, isActive: r.is_active })),
    googleCalendar: { connected: body.google_calendar.connected, syncStatus: body.google_calendar.sync_status, syncError: body.google_calendar.sync_error },
  };
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
