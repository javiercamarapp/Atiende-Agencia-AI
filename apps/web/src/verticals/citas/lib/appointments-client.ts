// Lógica de datos de la Agenda (Fase 5/7) — separada de pages/Agenda.tsx a
// propósito, mismo motivo que el resto de lib/*.ts de este panel: probarla con
// vitest en entorno "node" sin DOM. Llama a
// GET /v1/citas/properties/:propertyId/appointments (listado real, Fase 5 —
// apps/api/src/routes/verticals/citas/admin.ts) y reusa
// POST /v1/citas/properties/:propertyId/appointments/:appointmentId/cancel, que YA
// existía desde Fase 1 (appointments-lifecycle.ts) — el panel nunca reagenda ni
// reasigna (esas dos solo las ejecuta el agente hoy, ver ese mismo archivo).
// Fase 7 agrega confirm/complete/no-show — mismas 3 rutas de panel, mismo shape de
// respuesta ({ appointment }) que cancel.
import { fetchJson, postJson } from "./admin-client.ts";

export type AppointmentStatus = "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
export type AppointmentSource = "voice" | "whatsapp" | "web" | "manual";

export interface AppointmentSummary {
  readonly id: string;
  readonly propertyId: string | null;
  readonly providerId: string;
  readonly serviceId: string;
  readonly customerId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: AppointmentStatus;
  readonly source: AppointmentSource;
  readonly notes: string | null;
  readonly googleSyncStatus: string | null;
  /** Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — motivo NORMALIZADO
   * del último rechazo (ver @atiende/domain-citas::sanitizeProviderSyncReason),
   * solo tiene contenido real cuando `googleSyncStatus` es 'invalid' o 'error'. */
  readonly googleSyncError: string | null;
  /** Solo vienen en el listado de agenda (admin.ts los enriquece) — `cancelAppointment`
   * responde con la cita "pelona" (serializeAppointment de appointments-lifecycle.ts,
   * sin enriquecer), así que estos 4 campos quedan `null` en esa respuesta. */
  readonly providerName: string | null;
  readonly serviceName: string | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
}

export interface AppointmentApiRow {
  readonly id: string;
  readonly property_id: string | null;
  readonly provider_id: string;
  readonly service_id: string;
  readonly customer_id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly status: AppointmentStatus;
  readonly source: AppointmentSource;
  readonly notes: string | null;
  readonly google_sync_status?: string;
  readonly google_sync_error?: string | null;
  readonly provider_name?: string | null;
  readonly service_name?: string | null;
  readonly customer_name?: string | null;
  readonly customer_phone?: string | null;
}

/** Exportado para que customers-client.ts pueda mapear las citas próximas que
 * vienen incrustadas en la ficha de un cliente (`upcoming_appointments`) sin
 * duplicar el mapeo. */
export function mapAppointmentRow(row: AppointmentApiRow): AppointmentSummary {
  return {
    id: row.id,
    propertyId: row.property_id,
    providerId: row.provider_id,
    serviceId: row.service_id,
    customerId: row.customer_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    source: row.source,
    notes: row.notes,
    googleSyncStatus: row.google_sync_status ?? null,
    googleSyncError: row.google_sync_error ?? null,
    providerName: row.provider_name ?? null,
    serviceName: row.service_name ?? null,
    customerName: row.customer_name ?? null,
    customerPhone: row.customer_phone ?? null,
  };
}

export interface AppointmentsRange {
  readonly fromIso: string;
  readonly toIso: string;
  readonly providerId?: string;
}

export async function fetchAppointments(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, range: AppointmentsRange): Promise<readonly AppointmentSummary[]> {
  const params = new URLSearchParams({ from: range.fromIso, to: range.toIso });
  if (range.providerId) params.set("provider_id", range.providerId);
  const body = await fetchJson<{ appointments: readonly AppointmentApiRow[] }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/appointments?${params.toString()}`, token);
  return body.appointments.map(mapAppointmentRow);
}

export async function cancelAppointment(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, appointmentId: string): Promise<AppointmentSummary> {
  const body = await postJson<{ appointment: AppointmentApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/appointments/${appointmentId}/cancel`, token);
  return mapAppointmentRow(body.appointment);
}

export async function confirmAppointment(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, appointmentId: string): Promise<AppointmentSummary> {
  const body = await postJson<{ appointment: AppointmentApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/appointments/${appointmentId}/confirm`, token);
  return mapAppointmentRow(body.appointment);
}

export async function completeAppointment(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, appointmentId: string): Promise<AppointmentSummary> {
  const body = await postJson<{ appointment: AppointmentApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/appointments/${appointmentId}/complete`, token);
  return mapAppointmentRow(body.appointment);
}

export async function markAppointmentNoShow(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, appointmentId: string): Promise<AppointmentSummary> {
  const body = await postJson<{ appointment: AppointmentApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/appointments/${appointmentId}/no-show`, token);
  return mapAppointmentRow(body.appointment);
}

/** Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — botón "Reintentar
 * sincronización": solo tiene efecto sobre una cita que quedó
 * `googleSyncStatus === 'invalid'` (rechazo permanente de validación, p.ej. Cal.com
 * exige el correo del cliente y esta cita no lo tenía) — cualquier otro estado
 * responde 409 (ver apps/api/.../citas/appointments-lifecycle.ts). */
export async function retryAppointmentCalendarSync(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, appointmentId: string): Promise<AppointmentSummary> {
  const body = await postJson<{ appointment: AppointmentApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/appointments/${appointmentId}/retry-sync`, token);
  return mapAppointmentRow(body.appointment);
}

/** Fase 12 — hallazgo de auditoría (ALTO, "Staff no puede crear citas manualmente
 * desde la Agenda"): POST .../appointments (admin.ts, staff panel) -- a diferencia
 * de `fetchAppointments`/las 4 transiciones de arriba (ya existían desde Fase 5/7),
 * este endpoint es nuevo. `endsAt` lo calcula el servidor a partir de la duración
 * del servicio -- el panel nunca lo manda. */
export interface NewAppointmentInput {
  readonly providerId: string;
  readonly serviceId: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerEmail?: string;
  readonly startsAt: string;
  readonly notes?: string;
}

export async function createAppointment(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NewAppointmentInput): Promise<AppointmentSummary> {
  const body = await postJson<{ appointment: AppointmentApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/appointments`, token, {
    provider_id: input.providerId,
    service_id: input.serviceId,
    customer_name: input.customerName,
    customer_phone: input.customerPhone,
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    starts_at: input.startsAt,
    ...(input.notes ? { notes: input.notes } : {}),
  });
  return mapAppointmentRow(body.appointment);
}
