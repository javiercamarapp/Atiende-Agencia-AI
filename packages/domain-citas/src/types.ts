// Tipos de dominio de citas — port de las formas reales de
// citas-reservaciones/supabase/functions/_shared/{availability-core,appointments-core}.ts,
// renombrando `tenant_id` -> `organizationId` y `branch_id` -> `propertyId` para
// integrar con @atiende/core-tenancy (Organization/Property) en vez del concepto de
// tenant aislado (`tenants`) del origen. Ver diseño Fase 1 §2/§3.

export interface AvailabilityRule {
  readonly id: string;
  readonly providerId: string;
  readonly dayOfWeek: number; // 0 = domingo .. 6 = sábado
  readonly startTime: string; // "HH:MM" o "HH:MM:SS"
  readonly endTime: string;
  readonly isActive: boolean;
}

export interface AvailabilityOverride {
  readonly providerId: string;
  readonly overrideDate: string; // "YYYY-MM-DD"
  readonly isClosed: boolean;
  readonly startTime: string | null;
  readonly endTime: string | null;
}

export interface BusyInterval {
  /** Instante UTC en que empieza la cita ya existente. */
  readonly start: Date;
  /** Instante UTC en que termina. */
  readonly end: Date;
}

export interface Slot {
  readonly startsAt: string; // ISO UTC
  readonly endsAt: string; // ISO UTC
}

export interface ProviderRecord {
  readonly id: string;
  readonly organizationId: string;
  /** Sucursal (core.property) del proveedor — null si el negocio es de una sola
   * ubicación (caso común, ver diseño Fase 1 §2). */
  readonly propertyId: string | null;
  readonly displayName: string;
  readonly roleLabel: string;
  readonly isActive: boolean;
}

/** Fase 8 — panel admin: alta real de un proveedor (ver diseño Fase 8 §1, port de
 * `ProveedoresSection.tsx::guardar` del origen). `propertyId`, si viene, debe ser
 * una sucursal real de la MISMA organización — el caller (admin.ts) lo valida
 * contra `listPropertiesForOrganization` antes de llamar aquí; el repositorio
 * mismo confía en ese id (mismo criterio que `NewProductInput.categoryId` de
 * domain-restaurantes: la FK real de Postgres es la última línea de defensa). */
export interface NewProviderInput {
  readonly organizationId: string;
  readonly propertyId?: string | null;
  readonly displayName: string;
  readonly roleLabel?: string;
  readonly isActive?: boolean;
}

/** Patch parcial — un campo ausente (`undefined`) deja el valor actual intacto,
 * mismo criterio que `ProductPatch` de domain-restaurantes (`coalesce` en SQL,
 * `??` en memoria). `propertyId: null` explícito SÍ desasigna la sucursal. */
export interface ProviderPatch {
  readonly displayName?: string;
  readonly roleLabel?: string;
  readonly propertyId?: string | null;
  readonly isActive?: boolean;
}

export interface ServiceRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferMinutesBefore: number;
  readonly bufferMinutesAfter: number;
  readonly priceCents: number | null;
  readonly isActive: boolean;
}

/** Fase 8 — panel admin: alta real de un servicio (port de
 * `ServiciosSection.tsx::guardar` del origen). `citas.services` (001_citas_schema.sql)
 * NO tiene columnas `description`/`requirements` como el origen (`services.description`/
 * `services.requirements`) — esa parte de la ficha del origen queda fuera de esta
 * fase a propósito (agregar las columnas es una migración nueva, decisión de
 * producto separada de "cerrar el gap de que no se puede ni crear un servicio",
 * ver resumen de la fase). */
export interface NewServiceInput {
  readonly organizationId: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferMinutesBefore?: number;
  readonly bufferMinutesAfter?: number;
  readonly priceCents?: number | null;
  readonly isActive?: boolean;
}

/** Patch parcial — mismo criterio que `ProviderPatch`. `priceCents: null` explícito
 * SÍ quita el precio fijo (servicio "a cotizar"). */
export interface ServicePatch {
  readonly name?: string;
  readonly durationMinutes?: number;
  readonly bufferMinutesBefore?: number;
  readonly bufferMinutesAfter?: number;
  readonly priceCents?: number | null;
  readonly isActive?: boolean;
}

export interface CustomerRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
}

export type AppointmentStatus = "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
export type AppointmentSource = "voice" | "whatsapp" | "web" | "manual";
export type AppointmentActorChannel = AppointmentSource | "panel";

/**
 * Fase 3 §3/§6 — estado de la sincronización unidireccional (software -> Google
 * Calendar, NUNCA al revés) de esta cita. `pending`/`pending_cancel` los escriben
 * ATÓMICAMENTE las mismas funciones plpgsql que ya cambian la cita real
 * (create/cancel/reschedule_appointment_idempotent, ver migrations/005) — nunca una
 * segunda transacción separada. `skipped` = el proveedor no tiene Google Calendar
 * conectado (no es un error a reintentar). `error` = se agotaron los reintentos
 * (`MAX_SYNC_ATTEMPTS`) o el refresh token quedó revocado — ver calendar-sync.ts.
 */
export type GoogleSyncStatus = "pending" | "synced" | "error" | "skipped" | "pending_cancel" | "deleted";

export interface AppointmentRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly providerId: string;
  readonly serviceId: string;
  readonly customerId: string;
  readonly startsAt: string; // ISO UTC
  readonly endsAt: string; // ISO UTC
  readonly status: AppointmentStatus;
  readonly source: AppointmentSource;
  readonly notes: string | null;
  readonly dedupeFingerprint: string | null;
  readonly idempotencyKey: string | null;
  readonly reminder24hSentAt: string | null;
  readonly createdAt: string;
  /** Id real del evento en Google Calendar una vez creado — null hasta el primer
   * `createEvent` exitoso (ver diseño Fase 3 §5/§6). */
  readonly googleEventId: string | null;
  readonly googleSyncStatus: GoogleSyncStatus;
  readonly googleSyncAttempts: number;
  /** ISO UTC o null — null significa "nunca se ha intentado todavía" (elegible de
   * inmediato para el cron de reconciliación, ver calendar-sync.ts). */
  readonly googleSyncNextRetryAt: string | null;
  readonly googleSyncError: string | null;
}

/** Fase 3 §3 — estado de la CONEXIÓN de un proveedor con su Google Calendar
 * personal (distinto del `GoogleSyncStatus` de una cita individual). */
export type CalendarAccountSyncStatus = "disconnected" | "connected" | "error";

export interface ProviderCalendarAccountRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  /** Normalmente "primary" o el email del profesional — ver diseño Fase 3 §3. */
  readonly googleCalendarId: string;
  readonly googleWatchChannelId: string | null;
  readonly googleWatchResourceId: string | null;
  readonly googleWatchExpiresAt: string | null;
  readonly syncStatus: CalendarAccountSyncStatus;
  readonly syncError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---- Flujo 1: crear cita ----

export interface CreateAppointmentPayload {
  readonly organizationId: string;
  readonly providerId: string;
  readonly serviceId: string;
  /** Si se manda, debe coincidir con la sucursal real del proveedor (ver §5.1). */
  readonly propertyId?: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerEmail?: string;
  /** ISO 8601 — debe ser EXACTAMENTE un slot real de disponibilidad. */
  readonly startsAt: string;
  readonly notes?: string;
  readonly source?: AppointmentSource;
  readonly idempotencyKey?: string;
  readonly conversationId?: string;
}

// ---- Flujo 2: cancelar / reagendar ----

export interface CancelAppointmentPayload {
  readonly organizationId: string;
  readonly appointmentId: string;
}

export interface RescheduleAppointmentPayload {
  readonly organizationId: string;
  readonly appointmentId: string;
  /** ISO 8601 — debe ser EXACTAMENTE uno de los slots reales de disponibilidad para
   * el MISMO provider_id/service_id de la cita. */
  readonly newStartsAt: string;
  readonly actorChannel?: AppointmentActorChannel;
  readonly actorNote?: string;
}

/** Fase 4 -- "modificar-cita": cambio de proveedor y/o servicio de una cita
 * existente SIN tocar `startsAt`. Al menos uno de los dos campos debe venir
 * distinto del actual -- ver validateReassignAppointmentPayload. */
export interface ReassignAppointmentPayload {
  readonly organizationId: string;
  readonly appointmentId: string;
  readonly newProviderId?: string;
  readonly newServiceId?: string;
  readonly actorChannel?: AppointmentActorChannel;
  readonly actorNote?: string;
}
