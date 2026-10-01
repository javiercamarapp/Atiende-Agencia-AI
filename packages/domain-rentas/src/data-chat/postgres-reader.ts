// Lector Postgres del catalogo de rentas. Corre sobre la sesion RLS del USUARIO (la misma de la request,
// `dbSession`): nunca una sesion de sistema ni service_role. Cada consulta va en un SAVEPOINT
// (`runWithSavepointFallback`): si la base real todavia no tiene una tabla/columna/funcion (SQLSTATE
// 42P01/42703/42883) se hace ROLLBACK TO SAVEPOINT y se lanza DataChatUnavailableError -- la transaccion
// compartida de la request NUNCA queda abortada (25P02) y el COMMIT no se convierte en ROLLBACK.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isUndefinedColumnError, isUndefinedFunctionError, isUndefinedTableError, runWithSavepointFallback } from "@atiende/db";
import type { VisibleProperty } from "@atiende/agent-core/data-chat";
import {
  DataChatUnavailableError,
  type ChannelPayoutRow,
  type IncomeByChannelRow,
  type IncomeByOwnerRow,
  type OpenConflictRow,
  type OwnerStatementRow,
  type PendingTaskRow,
  type RentasDataChatReader,
  type RentasDataChatWindow,
  type TaskKind,
  type UnitOccupancyRow,
} from "./reader.ts";
import {
  SQL_CHANNEL_PAYOUTS,
  SQL_INCOME_BY_CHANNEL,
  SQL_INCOME_BY_OWNER,
  SQL_OCCUPANCY_BY_UNIT,
  SQL_OPEN_CALENDAR_CONFLICTS,
  SQL_OWNER_STATEMENTS,
  SQL_PENDING_TASKS,
  SQL_VISIBLE_PROPERTIES,
} from "./sql.ts";

function isMissingSchemaObject(err: unknown): boolean {
  return isUndefinedTableError(err) || isUndefinedColumnError(err) || isUndefinedFunctionError(err);
}

const num = (v: unknown): number => Number(v ?? 0);

/** Tope de tiempo de cada consulta del chat (aplica al resto de la transaccion de la request). */
export const RENTAS_DATA_CHAT_STATEMENT_TIMEOUT_MS = 8_000;

export class PostgresRentasDataChatReader implements RentasDataChatReader {
  private timeoutApplied = false;

  constructor(private readonly db: TenantDbSession) {}

  private async query<R>(what: string, sql: string, params: unknown[]): Promise<R[]> {
    if (!this.timeoutApplied) {
      this.timeoutApplied = true;
      // `set local`: solo vive en la transaccion de esta request; un tope de tiempo real en la base,
      // ademas del timeout del motor (que cancela la espera pero no la consulta).
      await this.db.exec(`set local statement_timeout = ${RENTAS_DATA_CHAT_STATEMENT_TIMEOUT_MS}`);
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

  async listVisibleProperties(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleProperty[]> {
    const rows = await this.query<{ property_id: string; name: string; slug: string }>("propiedades", SQL_VISIBLE_PROPERTIES, [organizationId, this.ids(propertyIds)]);
    return rows.map((r) => ({ propertyId: r.property_id, name: r.name, slug: r.slug }));
  }

  async occupancyByUnit(w: RentasDataChatWindow): Promise<readonly UnitOccupancyRow[]> {
    const rows = await this.query<{
      unit_name: string;
      booked_nights: string;
      blocked_nights: string;
      period_nights: string;
      total_booked: string;
      total_blocked: string;
      total_period: string;
      total_units: string;
    }>("ocupaciones", SQL_OCCUPANCY_BY_UNIT, [w.organizationId, this.ids(w.propertyIds), w.fromDate, w.toDate, w.limit]);
    return rows.map((r) => ({
      unitName: r.unit_name,
      bookedNights: num(r.booked_nights),
      blockedNights: num(r.blocked_nights),
      periodNights: num(r.period_nights),
      totalBooked: num(r.total_booked),
      totalBlocked: num(r.total_blocked),
      totalPeriod: num(r.total_period),
      totalUnits: num(r.total_units),
    }));
  }

  async incomeByChannel(w: RentasDataChatWindow): Promise<readonly IncomeByChannelRow[]> {
    const rows = await this.query<{ channel: string; bookings: string; nights: string; gross_cents: string; channel_fee_cents: string; net_cents: string; other_currency: string }>(
      "finanzas",
      SQL_INCOME_BY_CHANNEL,
      [w.organizationId, this.ids(w.propertyIds), w.fromDate, w.toDate, w.limit],
    );
    return rows.map((r) => ({
      channel: r.channel,
      bookings: num(r.bookings),
      nights: num(r.nights),
      grossCents: num(r.gross_cents),
      channelFeeCents: num(r.channel_fee_cents),
      netCents: num(r.net_cents),
      otherCurrency: num(r.other_currency),
    }));
  }

  async incomeByOwner(w: RentasDataChatWindow): Promise<readonly IncomeByOwnerRow[]> {
    const rows = await this.query<{ owner_name: string; bookings: string; nights: string; gross_cents: string; fees_cents: string; net_cents: string; other_currency: string }>(
      "finanzas",
      SQL_INCOME_BY_OWNER,
      [w.organizationId, this.ids(w.propertyIds), w.fromDate, w.toDate, w.limit],
    );
    return rows.map((r) => ({
      ownerName: r.owner_name,
      bookings: num(r.bookings),
      nights: num(r.nights),
      grossCents: num(r.gross_cents),
      feesCents: num(r.fees_cents),
      netCents: num(r.net_cents),
      otherCurrency: num(r.other_currency),
    }));
  }

  async openConflicts(organizationId: string, propertyIds: readonly string[] | null, now: Date, limit: number): Promise<readonly OpenConflictRow[]> {
    const rows = await this.query<{ unit_name: string; kind: string; days_open: number; total: string }>("conflictos", SQL_OPEN_CALENDAR_CONFLICTS, [
      organizationId,
      this.ids(propertyIds),
      now.toISOString(),
      limit,
    ]);
    return rows.map((r) => ({ unitName: r.unit_name, kind: r.kind, daysOpen: num(r.days_open), total: num(r.total) }));
  }

  async pendingTasks(
    organizationId: string,
    propertyIds: readonly string[] | null,
    range: { readonly fromDate: string | null; readonly toDate: string },
    now: Date,
    kind: TaskKind | null,
    limit: number,
  ): Promise<readonly PendingTaskRow[]> {
    const rows = await this.query<{ unit_name: string; kind: string; status: string; priority: string; scheduled: string; sla_overdue: boolean; total: string }>(
      "tareas",
      SQL_PENDING_TASKS,
      [organizationId, this.ids(propertyIds), range.fromDate, range.toDate, now.toISOString(), kind, limit],
    );
    return rows.map((r) => ({ unitName: r.unit_name, kind: r.kind, status: r.status, priority: r.priority, scheduled: r.scheduled, slaOverdue: r.sla_overdue === true, total: num(r.total) }));
  }

  async ownerStatements(w: RentasDataChatWindow): Promise<readonly OwnerStatementRow[]> {
    const rows = await this.query<{
      owner_name: string;
      period_start: string;
      period_end: string;
      version: number;
      currency: string;
      gross_cents: string;
      net_cents: string;
      generated_on: string;
    }>("liquidaciones", SQL_OWNER_STATEMENTS, [w.organizationId, this.ids(w.propertyIds), w.fromDate, w.toDate, w.limit]);
    return rows.map((r) => ({
      ownerName: r.owner_name,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      version: num(r.version),
      currency: r.currency,
      grossCents: num(r.gross_cents),
      netCents: num(r.net_cents),
      generatedOn: r.generated_on,
    }));
  }

  async channelPayouts(w: RentasDataChatWindow): Promise<readonly ChannelPayoutRow[]> {
    const rows = await this.query<{ channel: string; payouts: string; total_cents: string; pending_lines: string; mismatched_lines: string; other_currency: string }>(
      "pagos",
      SQL_CHANNEL_PAYOUTS,
      [w.organizationId, this.ids(w.propertyIds), w.fromDate, w.toDate, w.limit],
    );
    return rows.map((r) => ({
      channel: r.channel,
      payouts: num(r.payouts),
      totalCents: num(r.total_cents),
      pendingLines: num(r.pending_lines),
      mismatchedLines: num(r.mismatched_lines),
      otherCurrency: num(r.other_currency),
    }));
  }
}
