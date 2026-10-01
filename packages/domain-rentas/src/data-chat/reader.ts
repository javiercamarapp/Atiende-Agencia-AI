// Puerto de lectura del catalogo de RENTAS de "Chatea con tus datos": el catalogo (catalog.ts) solo habla con
// esto, nunca con SQL. Implementaciones: Postgres (postgres-reader.ts, sesion RLS del usuario) y dobles de prueba.
// Los importes llegan en CENTAVOS (como los guarda la base); el catalogo los convierte a MXN.
import type { VisibleProperty } from "@atiende/agent-core/data-chat";

export interface RentasDataChatWindow {
  readonly organizationId: string;
  /** null = todas las propiedades de la organizacion. Lo fija el SERVIDOR (membership), no el modelo. */
  readonly propertyIds: readonly string[] | null;
  /** Primer y ultimo dia local (AAAA-MM-DD, inclusive). */
  readonly fromDate: string;
  readonly toDate: string;
  readonly timezone: string;
  /** Tope de filas (el catalogo pide maxRows + 1 para detectar truncamiento). */
  readonly limit: number;
}

export interface UnitOccupancyRow {
  readonly unitName: string;
  readonly bookedNights: number;
  /** Noches bloqueadas (propietario/mantenimiento) en las que NO hay reserva. */
  readonly blockedNights: number;
  readonly periodNights: number;
  /** Totales de TODAS las unidades del alcance, aunque el tope recorte la lista. */
  readonly totalBooked: number;
  readonly totalBlocked: number;
  readonly totalPeriod: number;
  readonly totalUnits: number;
}
export interface IncomeByChannelRow {
  readonly channel: string;
  readonly bookings: number;
  readonly nights: number;
  readonly grossCents: number;
  readonly channelFeeCents: number;
  readonly netCents: number;
  /** Reservas en otra moneda: se cuentan pero NO se suman. */
  readonly otherCurrency: number;
}
export interface IncomeByOwnerRow {
  readonly ownerName: string;
  readonly bookings: number;
  readonly nights: number;
  readonly grossCents: number;
  readonly feesCents: number;
  readonly netCents: number;
  readonly otherCurrency: number;
}
export interface OpenConflictRow { readonly unitName: string; readonly kind: string; readonly daysOpen: number; readonly total: number }
export interface PendingTaskRow {
  readonly unitName: string;
  readonly kind: string;
  readonly status: string;
  readonly priority: string;
  readonly scheduled: string;
  readonly slaOverdue: boolean;
  readonly total: number;
}
export interface OwnerStatementRow {
  readonly ownerName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly version: number;
  readonly currency: string;
  readonly grossCents: number;
  readonly netCents: number;
  readonly generatedOn: string;
}
export interface ChannelPayoutRow {
  readonly channel: string;
  readonly payouts: number;
  readonly totalCents: number;
  readonly pendingLines: number;
  readonly mismatchedLines: number;
  readonly otherCurrency: number;
}

/** La base todavia no tiene la tabla/columna/funcion (migracion pendiente): honesto, no un 500. */
export class DataChatUnavailableError extends Error {
  constructor(readonly what: string) {
    super(`data_chat_unavailable:${what}`);
    this.name = "DataChatUnavailableError";
  }
}

export type TaskKind = "limpieza" | "mantenimiento" | "inspeccion";

export interface RentasDataChatReader {
  listVisibleProperties(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleProperty[]>;
  occupancyByUnit(w: RentasDataChatWindow): Promise<readonly UnitOccupancyRow[]>;
  incomeByChannel(w: RentasDataChatWindow): Promise<readonly IncomeByChannelRow[]>;
  incomeByOwner(w: RentasDataChatWindow): Promise<readonly IncomeByOwnerRow[]>;
  openConflicts(organizationId: string, propertyIds: readonly string[] | null, now: Date, limit: number): Promise<readonly OpenConflictRow[]>;
  /** `fromDate` null = sin limite inferior (incluye el rezago). `kind` null = todos los tipos. */
  pendingTasks(
    organizationId: string,
    propertyIds: readonly string[] | null,
    range: { readonly fromDate: string | null; readonly toDate: string },
    now: Date,
    kind: TaskKind | null,
    limit: number,
  ): Promise<readonly PendingTaskRow[]>;
  ownerStatements(w: RentasDataChatWindow): Promise<readonly OwnerStatementRow[]>;
  channelPayouts(w: RentasDataChatWindow): Promise<readonly ChannelPayoutRow[]>;
}
