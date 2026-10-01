// Puerto de lectura del catalogo de HOTELES de "Chatea con tus datos": el catalogo (catalog.ts) solo habla
// con esto, nunca con SQL. Implementaciones: Postgres (postgres-reader.ts, sesion RLS del usuario) y dobles
// de prueba.
import type { VisibleProperty } from "@atiende/agent-core/data-chat";

export interface HotelesDataChatWindow {
  readonly organizationId: string;
  /** null = todos los hoteles de la organizacion. Lo fija el SERVIDOR (membership), no el modelo. */
  readonly propertyIds: readonly string[] | null;
  /** Instante de inicio (inclusive) y de fin (exclusivo) del periodo en la zona del negocio. */
  readonly start: Date;
  readonly end: Date;
  /** Primer y ultimo dia local (AAAA-MM-DD, inclusive): para columnas de tipo `date` (estancias, llegadas). */
  readonly fromDate: string;
  readonly toDate: string;
  readonly timezone: string;
  /** Tope de filas (el catalogo pide maxRows + 1 para detectar truncamiento). */
  readonly limit: number;
}

export type Granularity = "day" | "week" | "month";

export interface OccupancyRow { readonly bucket: string; readonly availableNights: number; readonly occupiedNights: number; readonly roomRevenue: number }
export interface RevenueRow { readonly bucket: string; readonly rooms: number; readonly foodBeverage: number; readonly other: number }
export interface ArrivalsDeparturesRow { readonly bucket: string; readonly arrivals: number; readonly departures: number }
export interface CancellationRow { readonly bucket: string; readonly cancelled: number; readonly bookedValue: number; readonly penalties: number }
export interface OpenTicketsRow {
  readonly department: string;
  readonly priority: string;
  readonly openTickets: number;
  readonly overdue: number;
  readonly dueSoon: number;
  readonly escalated: number;
}
export interface HousekeepingPendingRow {
  readonly taskType: string;
  readonly pending: number;
  readonly inProgress: number;
  /** De dias de trabajo anteriores a hoy (subconjunto de pending + inProgress). */
  readonly backlog: number;
  readonly highPriority: number;
}

/** La base todavia no tiene la tabla/columna/funcion (migracion pendiente): honesto, no un 500. */
export class DataChatUnavailableError extends Error {
  constructor(readonly what: string) {
    super(`data_chat_unavailable:${what}`);
    this.name = "DataChatUnavailableError";
  }
}

export interface HotelesDataChatReader {
  listVisibleHotels(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleProperty[]>;
  occupancy(w: HotelesDataChatWindow, unit: Granularity): Promise<readonly OccupancyRow[]>;
  revenue(w: HotelesDataChatWindow, unit: Granularity): Promise<readonly RevenueRow[]>;
  arrivalsDepartures(w: HotelesDataChatWindow, unit: Granularity): Promise<readonly ArrivalsDeparturesRow[]>;
  cancellations(w: HotelesDataChatWindow, unit: Granularity): Promise<readonly CancellationRow[]>;
  openTickets(organizationId: string, propertyIds: readonly string[] | null, now: Date, limit: number): Promise<readonly OpenTicketsRow[]>;
  housekeepingPending(organizationId: string, propertyIds: readonly string[] | null, today: string, limit: number): Promise<readonly HousekeepingPendingRow[]>;
}
