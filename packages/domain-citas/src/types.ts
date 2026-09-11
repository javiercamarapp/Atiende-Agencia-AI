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
