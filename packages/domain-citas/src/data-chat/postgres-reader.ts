// Lector Postgres del catalogo de citas. Corre sobre la sesion RLS del USUARIO (la misma de la request,
// `dbSession`): nunca una sesion de sistema ni service_role. Cada consulta va en un SAVEPOINT
// (`runWithSavepointFallback`): si la base real todavia no tiene una tabla/columna/funcion (SQLSTATE
// 42P01/42703/42883) se hace ROLLBACK TO SAVEPOINT y se lanza DataChatUnavailableError -- la transaccion
// compartida de la request NUNCA queda abortada (25P02) y el COMMIT no se convierte en ROLLBACK.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isUndefinedColumnError, isUndefinedFunctionError, isUndefinedTableError, runWithSavepointFallback } from "@atiende/db";
import type { VisibleProperty } from "@atiende/agent-core/data-chat";
import {
  DataChatUnavailableError,
  type AppointmentsByPeriodRow,
  type AttendanceRow,
  type BranchOccupancyRow,
  type CitasDataChatReader,
  type CitasDataChatWindow,
  type CustomersRow,
  type FreeSlotRow,
  type Granularity,
  type OccupancyRow,
  type PendingRemindersRow,
  type ReminderDeliveryRow,
  type RevenueByPeriodRow,
  type RevenueByServiceRow,
} from "./reader.ts";
import {
  SQL_APPOINTMENTS_BY_PERIOD,
  SQL_ATTENDANCE_BY_PROVIDER,
  SQL_CUSTOMERS,
  SQL_FREE_SLOTS,
  SQL_OCCUPANCY_BY_BRANCH,
  SQL_OCCUPANCY_BY_PROVIDER,
  SQL_PENDING_REMINDERS,
  SQL_REMINDER_DELIVERY,
  SQL_REVENUE_BY_PERIOD,
  SQL_REVENUE_BY_SERVICE,
  SQL_VISIBLE_BRANCHES,
} from "./sql.ts";

function isMissingSchemaObject(err: unknown): boolean {
  return isUndefinedTableError(err) || isUndefinedColumnError(err) || isUndefinedFunctionError(err);
}

const num = (v: unknown): number => Number(v ?? 0);

/** Tope de tiempo de cada consulta del chat (aplica al resto de la transaccion de la request). */
export const CITAS_DATA_CHAT_STATEMENT_TIMEOUT_MS = 8_000;

export class PostgresCitasDataChatReader implements CitasDataChatReader {
  private timeoutApplied = false;

  constructor(private readonly db: TenantDbSession) {}

  private async query<R>(what: string, sql: string, params: unknown[]): Promise<R[]> {
    if (!this.timeoutApplied) {
      this.timeoutApplied = true;
      // `set local`: solo vive en la transaccion de esta request; un tope de tiempo real en la base,
      // ademas del timeout del motor (que cancela la espera pero no la consulta).
      await this.db.exec(`set local statement_timeout = ${CITAS_DATA_CHAT_STATEMENT_TIMEOUT_MS}`);
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

  private scope(w: CitasDataChatWindow): unknown[] {
    return [w.organizationId, w.propertyIds ? [...w.propertyIds] : null];
  }
  /** $1..$4 alcance + instantes + $5 tope. */
  private instants(w: CitasDataChatWindow): unknown[] {
    return [...this.scope(w), w.start.toISOString(), w.end.toISOString(), w.limit];
  }
  /** $1..$4 alcance + instantes + $5 zona + $6 tope + $7 unidad. */
  private instantsTz(w: CitasDataChatWindow, unit: Granularity): unknown[] {
    return [...this.scope(w), w.start.toISOString(), w.end.toISOString(), w.timezone, w.limit, unit];
  }
  /** $1..$2 alcance + $3/$4 dias locales + $5 zona + $6 tope (horario de atencion). */
  private days(w: CitasDataChatWindow): unknown[] {
    return [...this.scope(w), w.fromDate, w.toDate, w.timezone, w.limit];
  }

  async listVisibleBranches(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleProperty[]> {
    const rows = await this.query<{ property_id: string; name: string; slug: string }>("sucursales", SQL_VISIBLE_BRANCHES, [organizationId, propertyIds ? [...propertyIds] : null]);
    return rows.map((r) => ({ propertyId: r.property_id, name: r.name, slug: r.slug }));
  }

  async appointmentsByPeriod(w: CitasDataChatWindow, unit: Granularity): Promise<readonly AppointmentsByPeriodRow[]> {
    const rows = await this.query<{ bucket: string; total: string; scheduled: string; completed: string; cancelled: string; no_show: string }>("citas", SQL_APPOINTMENTS_BY_PERIOD, this.instantsTz(w, unit));
    return rows.map((r) => ({ bucket: r.bucket, total: num(r.total), scheduled: num(r.scheduled), completed: num(r.completed), cancelled: num(r.cancelled), noShow: num(r.no_show) }));
  }

  async occupancyByProvider(w: CitasDataChatWindow): Promise<readonly OccupancyRow[]> {
    const rows = await this.query<{ provider: string; branch: string; available_minutes: string; booked_minutes: string; total_available: string; total_booked: string; total_providers: string }>("horarios", SQL_OCCUPANCY_BY_PROVIDER, this.days(w));
    return rows.map((r) => ({
      provider: r.provider,
      branch: r.branch,
      availableMinutes: num(r.available_minutes),
      bookedMinutes: num(r.booked_minutes),
      totalAvailable: num(r.total_available),
      totalBooked: num(r.total_booked),
      totalProviders: num(r.total_providers),
    }));
  }

  async occupancyByBranch(w: CitasDataChatWindow): Promise<readonly BranchOccupancyRow[]> {
    const rows = await this.query<{ branch: string; providers: string; available_minutes: string; booked_minutes: string; total_available: string; total_booked: string; total_providers: string }>("horarios", SQL_OCCUPANCY_BY_BRANCH, this.days(w));
    return rows.map((r) => ({
      branch: r.branch,
      providers: num(r.providers),
      availableMinutes: num(r.available_minutes),
      bookedMinutes: num(r.booked_minutes),
      totalAvailable: num(r.total_available),
      totalBooked: num(r.total_booked),
      totalProviders: num(r.total_providers),
    }));
  }

  async attendanceByProvider(w: CitasDataChatWindow): Promise<readonly AttendanceRow[]> {
    const rows = await this.query<{ provider: string; total: string; completed: string; cancelled: string; no_show: string; grand_total: string; grand_cancelled: string; grand_no_show: string }>("citas", SQL_ATTENDANCE_BY_PROVIDER, this.instants(w));
    return rows.map((r) => ({
      provider: r.provider,
      total: num(r.total),
      completed: num(r.completed),
      cancelled: num(r.cancelled),
      noShow: num(r.no_show),
      grandTotal: num(r.grand_total),
      grandCancelled: num(r.grand_cancelled),
      grandNoShow: num(r.grand_no_show),
    }));
  }

  async revenueByPeriod(w: CitasDataChatWindow, unit: Granularity): Promise<readonly RevenueByPeriodRow[]> {
    const rows = await this.query<{ bucket: string; appointments: string; revenue_cents: string; without_price: string }>("citas", SQL_REVENUE_BY_PERIOD, this.instantsTz(w, unit));
    return rows.map((r) => ({ bucket: r.bucket, appointments: num(r.appointments), revenueCents: num(r.revenue_cents), withoutPrice: num(r.without_price) }));
  }

  async revenueByService(w: CitasDataChatWindow): Promise<readonly RevenueByServiceRow[]> {
    const rows = await this.query<{ service: string; appointments: string; revenue_cents: string; without_price: string; total_revenue_cents: string }>("citas", SQL_REVENUE_BY_SERVICE, this.instants(w));
    return rows.map((r) => ({ service: r.service, appointments: num(r.appointments), revenueCents: num(r.revenue_cents), withoutPrice: num(r.without_price), totalRevenueCents: num(r.total_revenue_cents) }));
  }

  async customers(w: CitasDataChatWindow): Promise<CustomersRow> {
    const rows = await this.query<{ customers: string; new_customers: string; recurring: string }>("citas", SQL_CUSTOMERS, this.instants(w));
    const r = rows[0];
    return { customers: num(r?.customers), newCustomers: num(r?.new_customers), recurring: num(r?.recurring) };
  }

  async freeSlots(w: CitasDataChatWindow, now: Date): Promise<readonly FreeSlotRow[]> {
    const [org, props, from, to, tz] = this.days(w);
    const rows = await this.query<{ day: string; provider: string; branch: string; free_minutes: string; total_free: string }>("horarios", SQL_FREE_SLOTS, [org, props, from, to, tz, now.toISOString(), w.limit]);
    return rows.map((r) => ({ day: r.day, provider: r.provider, branch: r.branch, freeMinutes: num(r.free_minutes), totalFree: num(r.total_free) }));
  }

  async pendingReminders(w: CitasDataChatWindow, now: Date): Promise<PendingRemindersRow> {
    const rows = await this.query<{ pending: string; next_24h: string }>("citas", SQL_PENDING_REMINDERS, [...this.scope(w), w.start.toISOString(), w.end.toISOString(), now.toISOString(), w.limit]);
    return { pending: num(rows[0]?.pending), next24h: num(rows[0]?.next_24h) };
  }

  async reminderDelivery(w: CitasDataChatWindow): Promise<readonly ReminderDeliveryRow[]> {
    const rows = await this.query<{ channel: string; status: string; total: string }>("recordatorios", SQL_REMINDER_DELIVERY, this.instants(w));
    return rows.map((r) => ({ channel: r.channel, status: r.status, total: num(r.total) }));
  }
}
