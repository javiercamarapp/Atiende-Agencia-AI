// Puerto de lectura del catalogo de "Chatea con tus datos" de CITAS: el catalogo (catalog.ts) solo habla con esto,
// nunca con SQL. Implementaciones: Postgres (postgres-reader.ts, sesion RLS del usuario) y dobles de prueba.
import type { VisibleProperty } from "@atiende/agent-core/data-chat";

export interface CitasDataChatWindow {
  readonly organizationId: string;
  /** null = todas las sucursales de la organizacion. Lo fija el SERVIDOR (membership), no el modelo. */
  readonly propertyIds: readonly string[] | null;
  /** Instantes [start, end) del periodo, ya resueltos en la zona del negocio. */
  readonly start: Date;
  readonly end: Date;
  /** Dias locales inclusivos AAAA-MM-DD (para el horario de atencion, que se define por dia local). */
  readonly fromDate: string;
  readonly toDate: string;
  readonly timezone: string;
  /** Tope de filas (el catalogo pide maxRows + 1 para detectar truncamiento). */
  readonly limit: number;
}

export type Granularity = "day" | "week" | "month";

export interface AppointmentsByPeriodRow {
  readonly bucket: string;
  readonly total: number;
  readonly scheduled: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly noShow: number;
}
/** Minutos de horario de atencion y minutos ocupados; los `total*` son de TODO el alcance (no solo de las filas devueltas). */
export interface OccupancyRow {
  readonly provider: string;
  readonly branch: string;
  readonly availableMinutes: number;
  readonly bookedMinutes: number;
  readonly totalAvailable: number;
  readonly totalBooked: number;
  readonly totalProviders: number;
}
export interface BranchOccupancyRow {
  readonly branch: string;
  readonly providers: number;
  readonly availableMinutes: number;
  readonly bookedMinutes: number;
  readonly totalAvailable: number;
  readonly totalBooked: number;
  readonly totalProviders: number;
}
export interface AttendanceRow {
  readonly provider: string;
  readonly total: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly noShow: number;
  readonly grandTotal: number;
  readonly grandCancelled: number;
  readonly grandNoShow: number;
}
export interface RevenueByPeriodRow {
  readonly bucket: string;
  readonly appointments: number;
  readonly revenueCents: number;
  readonly withoutPrice: number;
}
export interface RevenueByServiceRow {
  readonly service: string;
  readonly appointments: number;
  readonly revenueCents: number;
  readonly withoutPrice: number;
  readonly totalRevenueCents: number;
}
export interface CustomersRow {
  readonly customers: number;
  readonly newCustomers: number;
  readonly recurring: number;
}
export interface FreeSlotRow {
  readonly day: string;
  readonly provider: string;
  readonly branch: string;
  readonly freeMinutes: number;
  readonly totalFree: number;
}
export interface PendingRemindersRow {
  /** Citas por atender (pendientes o confirmadas, de ahora en adelante) cuyo recordatorio aun no se marca como enviado. */
  readonly pending: number;
  /** De esas, las que empiezan en menos de 24 horas. */
  readonly next24h: number;
}
export interface ReminderDeliveryRow {
  readonly channel: string;
  readonly status: string;
  readonly total: number;
}

/** La base todavia no tiene la tabla/columna/funcion (migracion pendiente): honesto, no un 500. */
export class DataChatUnavailableError extends Error {
  constructor(readonly what: string) {
    super(`data_chat_unavailable:${what}`);
    this.name = "DataChatUnavailableError";
  }
}

export interface CitasDataChatReader {
  listVisibleBranches(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleProperty[]>;
  appointmentsByPeriod(w: CitasDataChatWindow, unit: Granularity): Promise<readonly AppointmentsByPeriodRow[]>;
  occupancyByProvider(w: CitasDataChatWindow): Promise<readonly OccupancyRow[]>;
  occupancyByBranch(w: CitasDataChatWindow): Promise<readonly BranchOccupancyRow[]>;
  attendanceByProvider(w: CitasDataChatWindow): Promise<readonly AttendanceRow[]>;
  revenueByPeriod(w: CitasDataChatWindow, unit: Granularity): Promise<readonly RevenueByPeriodRow[]>;
  revenueByService(w: CitasDataChatWindow): Promise<readonly RevenueByServiceRow[]>;
  customers(w: CitasDataChatWindow): Promise<CustomersRow>;
  /** Horas libres (horario de atencion menos citas) de `now` en adelante, por profesional y dia. */
  freeSlots(w: CitasDataChatWindow, now: Date): Promise<readonly FreeSlotRow[]>;
  pendingReminders(w: CitasDataChatWindow, now: Date): Promise<PendingRemindersRow>;
  /** Estado de envio por canal. Lanza DataChatUnavailableError si la base aun no tiene la funcion (migracion 027). */
  reminderDelivery(w: CitasDataChatWindow): Promise<readonly ReminderDeliveryRow[]>;
}
