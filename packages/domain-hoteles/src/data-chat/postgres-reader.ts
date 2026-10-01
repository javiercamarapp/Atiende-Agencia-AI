// Lector Postgres del catalogo de hoteles. Corre sobre la sesion RLS del USUARIO (la misma de la request,
// `dbSession`): nunca una sesion de sistema ni service_role. Cada consulta va en un SAVEPOINT
// (`runWithSavepointFallback`): si la base real todavia no tiene una tabla/columna/funcion (SQLSTATE
// 42P01/42703/42883) se hace ROLLBACK TO SAVEPOINT y se lanza DataChatUnavailableError -- la transaccion
// compartida de la request NUNCA queda abortada (25P02) y el COMMIT no se convierte en ROLLBACK.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isUndefinedColumnError, isUndefinedFunctionError, isUndefinedTableError, runWithSavepointFallback } from "@atiende/db";
import type { VisibleProperty } from "@atiende/agent-core/data-chat";
import {
  DataChatUnavailableError,
  type ArrivalsDeparturesRow,
  type CancellationRow,
  type Granularity,
  type HotelesDataChatReader,
  type HotelesDataChatWindow,
  type HousekeepingPendingRow,
  type OccupancyRow,
  type OpenTicketsRow,
  type RevenueRow,
} from "./reader.ts";
import {
  SQL_ARRIVALS_DEPARTURES,
  SQL_CANCELLATIONS,
  SQL_HOUSEKEEPING_PENDING,
  SQL_OCCUPANCY_ADR_REVPAR,
  SQL_OPEN_TICKETS_SLA,
  SQL_REVENUE_BY_PERIOD,
  SQL_VISIBLE_HOTELS,
} from "./sql.ts";

function isMissingSchemaObject(err: unknown): boolean {
  return isUndefinedTableError(err) || isUndefinedColumnError(err) || isUndefinedFunctionError(err);
}

const num = (v: unknown): number => Number(v ?? 0);

/** Tope de tiempo de cada consulta del chat (aplica al resto de la transaccion de la request). */
export const HOTELES_DATA_CHAT_STATEMENT_TIMEOUT_MS = 8_000;

export class PostgresHotelesDataChatReader implements HotelesDataChatReader {
  private timeoutApplied = false;

  constructor(private readonly db: TenantDbSession) {}

  private async query<R>(what: string, sql: string, params: unknown[]): Promise<R[]> {
    if (!this.timeoutApplied) {
      this.timeoutApplied = true;
      // `set local`: solo vive en la transaccion de esta request; un tope de tiempo real en la base,
      // ademas del timeout del motor (que cancela la espera pero no la consulta).
      await this.db.exec(`set local statement_timeout = ${HOTELES_DATA_CHAT_STATEMENT_TIMEOUT_MS}`);
    }
    return runWithSavepointFallback<R[]>({
      session: this.db,
      primary: async () => (await this.db.query<R>(sql, params)).rows,
      isRecoverable: isMissingSchemaObject,
      fallback: async () => {
        throw new DataChatUnavailableError(what);
      },
    });
  }

  private ids(propertyIds: readonly string[] | null): string[] | null {
    return propertyIds ? [...propertyIds] : null;
  }

  async listVisibleHotels(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleProperty[]> {
    const rows = await this.query<{ property_id: string; name: string; slug: string }>("hoteles", SQL_VISIBLE_HOTELS, [organizationId, this.ids(propertyIds)]);
    return rows.map((r) => ({ propertyId: r.property_id, name: r.name, slug: r.slug }));
  }

  async occupancy(w: HotelesDataChatWindow, unit: Granularity): Promise<readonly OccupancyRow[]> {
    const rows = await this.query<{ bucket: string; available_nights: string; occupied_nights: string; room_revenue: string }>(
      "ocupacion",
      SQL_OCCUPANCY_ADR_REVPAR,
      [w.organizationId, this.ids(w.propertyIds), w.fromDate, w.toDate, unit, w.limit],
    );
    return rows.map((r) => ({ bucket: r.bucket, availableNights: num(r.available_nights), occupiedNights: num(r.occupied_nights), roomRevenue: num(r.room_revenue) }));
  }

  async revenue(w: HotelesDataChatWindow, unit: Granularity): Promise<readonly RevenueRow[]> {
    const rows = await this.query<{ bucket: string; rooms: string; food_beverage: string; other: string }>(
      "cargos",
      SQL_REVENUE_BY_PERIOD,
      [w.organizationId, this.ids(w.propertyIds), w.fromDate, w.toDate, unit, w.timezone, w.limit],
    );
    return rows.map((r) => ({ bucket: r.bucket, rooms: num(r.rooms), foodBeverage: num(r.food_beverage), other: num(r.other) }));
  }

  async arrivalsDepartures(w: HotelesDataChatWindow, unit: Granularity): Promise<readonly ArrivalsDeparturesRow[]> {
    const rows = await this.query<{ bucket: string; arrivals: string; departures: string }>(
      "reservas",
      SQL_ARRIVALS_DEPARTURES,
      [w.organizationId, this.ids(w.propertyIds), w.fromDate, w.toDate, unit, w.limit],
    );
    return rows.map((r) => ({ bucket: r.bucket, arrivals: num(r.arrivals), departures: num(r.departures) }));
  }

  async cancellations(w: HotelesDataChatWindow, unit: Granularity): Promise<readonly CancellationRow[]> {
    const rows = await this.query<{ bucket: string; cancelled: string; booked_value: string; penalties: string }>(
      "reservas",
      SQL_CANCELLATIONS,
      [w.organizationId, this.ids(w.propertyIds), w.start.toISOString(), w.end.toISOString(), unit, w.timezone, w.limit],
    );
    return rows.map((r) => ({ bucket: r.bucket, cancelled: num(r.cancelled), bookedValue: num(r.booked_value), penalties: num(r.penalties) }));
  }

  async openTickets(organizationId: string, propertyIds: readonly string[] | null, now: Date, limit: number): Promise<readonly OpenTicketsRow[]> {
    const rows = await this.query<{ department: string; priority: string; open_tickets: string; overdue: string; due_soon: string; escalated: string }>(
      "tickets",
      SQL_OPEN_TICKETS_SLA,
      [organizationId, this.ids(propertyIds), now.toISOString(), limit],
    );
    return rows.map((r) => ({
      department: r.department,
      priority: r.priority,
      openTickets: num(r.open_tickets),
      overdue: num(r.overdue),
      dueSoon: num(r.due_soon),
      escalated: num(r.escalated),
    }));
  }

  async housekeepingPending(organizationId: string, propertyIds: readonly string[] | null, today: string, limit: number): Promise<readonly HousekeepingPendingRow[]> {
    const rows = await this.query<{ task_type: string; pending: string; in_progress: string; backlog: string; high_priority: string }>(
      "housekeeping",
      SQL_HOUSEKEEPING_PENDING,
      [organizationId, this.ids(propertyIds), today, limit],
    );
    return rows.map((r) => ({ taskType: r.task_type, pending: num(r.pending), inProgress: num(r.in_progress), backlog: num(r.backlog), highPriority: num(r.high_priority) }));
  }
}
