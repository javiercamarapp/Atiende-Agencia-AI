// Lector Postgres del catalogo. Corre sobre la sesion RLS del USUARIO (la misma de la request,
// `dbSession`): nunca una sesion de sistema ni service_role. Cada consulta va en un SAVEPOINT
// (`runWithSavepointFallback`): si la base real todavia no tiene una tabla/columna/funcion
// (SQLSTATE 42P01/42703/42883) se hace ROLLBACK TO SAVEPOINT y se lanza DataChatUnavailableError
// -- la transaccion compartida de la request NUNCA queda abortada (25P02) y el COMMIT no se
// convierte en ROLLBACK.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isUndefinedColumnError, isUndefinedTableError, isUndefinedFunctionError, runWithSavepointFallback } from "@atiende/db";
import { ServicioCfo, type EntradaServicioCfo } from "../cfo/servicio.ts";
import { PostgresCfoRepository } from "../cfo/repositorio-postgres.ts";
import {
  DataChatUnavailableError,
  type ChannelRow,
  type DataChatWindow,
  type OrderStatsRow,
  type PeakHourRow,
  type PromotionRow,
  type RecurringRow,
  type RestaurantesDataChatReader,
  type SalesByBranchRow,
  type SalesByPeriodRow,
  type SalesGranularity,
  type TopProductRow,
  type VisibleBranch,
} from "./reader.ts";
import {
  SQL_ORDERS_BY_CHANNEL,
  SQL_ORDER_STATS,
  SQL_PEAK_HOURS,
  SQL_PROMOTIONS,
  SQL_RECURRING_CUSTOMERS,
  SQL_SALES_BY_BRANCH,
  SQL_SALES_BY_PERIOD,
  SQL_TOP_PRODUCTS_BY_QUANTITY,
  SQL_TOP_PRODUCTS_BY_REVENUE,
  SQL_VISIBLE_BRANCHES,
  FECHA_PEDIDO,
  FECHA_PEDIDO_LEGADA,
} from "./sql.ts";

function isMissingSchemaObject(err: unknown): boolean {
  return isUndefinedTableError(err) || isUndefinedColumnError(err) || isUndefinedFunctionError(err);
}

const num = (v: unknown): number => Number(v ?? 0);

/** Tope de tiempo de cada consulta del chat (aplica al resto de la transaccion de la request). */
export const DATA_CHAT_STATEMENT_TIMEOUT_MS = 8_000;

export class PostgresRestaurantesDataChatReader implements RestaurantesDataChatReader {
  private timeoutApplied = false;

  constructor(private readonly db: TenantDbSession) {}

  private async aplicarTope(): Promise<void> {
    if (this.timeoutApplied) return;
    this.timeoutApplied = true;
    // `set local`: solo vive en la transaccion de esta request; un tope de tiempo real en la base,
    // ademas del timeout del motor (que cancela la espera pero no la consulta).
    await this.db.exec(`set local statement_timeout = ${DATA_CHAT_STATEMENT_TIMEOUT_MS}`);
  }

  private async query<R>(what: string, sql: string, params: unknown[]): Promise<R[]> {
    await this.aplicarTope();
    return runWithSavepointFallback<R[]>({
      session: this.db,
      primary: async () => (await this.db.query<R>(sql, params)).rows,
      isRecoverable: isMissingSchemaObject,
      fallback: async (err) => {
        // Base sin la migracion 034 (no existe `promovido_at`): el dia del pedido vuelve a ser `created_at` (comportamiento
        // anterior) en vez de dejar el chat "no disponible". Corre tras el ROLLBACK TO SAVEPOINT de runWithSavepointFallback.
        if (sql.includes(FECHA_PEDIDO) && isUndefinedColumnError(err)) {
          const legacy = sql.split(FECHA_PEDIDO).join(FECHA_PEDIDO_LEGADA);
          return runWithSavepointFallback<R[]>({
            session: this.db,
            savepointName: "sp_data_chat_legado",
            primary: async () => (await this.db.query<R>(legacy, params)).rows,
            isRecoverable: isMissingSchemaObject,
            fallback: async () => {
              throw new DataChatUnavailableError(what);
            },
          });
        }
        throw new DataChatUnavailableError(what);
      },
    });
  }

  /** $1..$4 alcance + $5 tope (consultas sin zona horaria). */
  private windowParams(w: DataChatWindow): unknown[] {
    return [w.organizationId, w.propertyIds ? [...w.propertyIds] : null, w.start.toISOString(), w.end.toISOString(), w.limit];
  }

  /** $1..$4 alcance + $5 zona horaria + $6 tope (consultas que agrupan por dia/hora local). */
  private windowParamsTz(w: DataChatWindow): unknown[] {
    return [w.organizationId, w.propertyIds ? [...w.propertyIds] : null, w.start.toISOString(), w.end.toISOString(), w.timezone, w.limit];
  }

  async listVisibleBranches(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleBranch[]> {
    const rows = await this.query<{ property_id: string; name: string; slug: string }>("sucursales", SQL_VISIBLE_BRANCHES, [organizationId, propertyIds ? [...propertyIds] : null]);
    return rows.map((r) => ({ propertyId: r.property_id, name: r.name, slug: r.slug }));
  }

  async salesByPeriod(w: DataChatWindow, unit: SalesGranularity): Promise<readonly SalesByPeriodRow[]> {
    const rows = await this.query<{ bucket: string; revenue: string; orders: string }>("pedidos", SQL_SALES_BY_PERIOD, [...this.windowParamsTz(w), unit]);
    return rows.map((r) => ({ bucket: r.bucket, revenue: num(r.revenue), orders: num(r.orders) }));
  }

  async salesByBranch(w: DataChatWindow): Promise<readonly SalesByBranchRow[]> {
    const rows = await this.query<{ branch: string; revenue: string; orders: string }>("pedidos", SQL_SALES_BY_BRANCH, this.windowParams(w));
    return rows.map((r) => ({ branch: r.branch, revenue: num(r.revenue), orders: num(r.orders) }));
  }

  async topProducts(w: DataChatWindow, by: "cantidad" | "ventas"): Promise<readonly TopProductRow[]> {
    const rows = await this.query<{ product: string; quantity: string; revenue: string }>(
      "pedidos",
      by === "cantidad" ? SQL_TOP_PRODUCTS_BY_QUANTITY : SQL_TOP_PRODUCTS_BY_REVENUE,
      this.windowParams(w),
    );
    return rows.map((r) => ({ product: r.product, quantity: num(r.quantity), revenue: num(r.revenue) }));
  }

  async orderStats(w: DataChatWindow): Promise<OrderStatsRow> {
    const rows = await this.query<{ orders: string; revenue: string; cancelled: string }>("pedidos", SQL_ORDER_STATS, this.windowParams(w));
    const r = rows[0];
    return { orders: num(r?.orders), revenue: num(r?.revenue), cancelled: num(r?.cancelled) };
  }

  async ordersByChannel(w: DataChatWindow): Promise<readonly ChannelRow[]> {
    const rows = await this.query<{ channel: string; orders: string; revenue: string }>("pedidos", SQL_ORDERS_BY_CHANNEL, this.windowParams(w));
    return rows.map((r) => ({ channel: r.channel, orders: num(r.orders), revenue: num(r.revenue) }));
  }

  async peakHours(w: DataChatWindow): Promise<readonly PeakHourRow[]> {
    const rows = await this.query<{ hour: number; orders: string; revenue: string }>("pedidos", SQL_PEAK_HOURS, this.windowParamsTz(w));
    return rows.map((r) => ({ hour: num(r.hour), orders: num(r.orders), revenue: num(r.revenue) }));
  }

  async recurringCustomers(w: DataChatWindow): Promise<RecurringRow> {
    const rows = await this.query<{ customers: string; recurring: string; new_customers: string }>("pedidos", SQL_RECURRING_CUSTOMERS, this.windowParams(w));
    const r = rows[0];
    return { customers: num(r?.customers), recurring: num(r?.recurring), newCustomers: num(r?.new_customers) };
  }

  async promotions(organizationId: string, limit: number): Promise<readonly PromotionRow[]> {
    const rows = await this.query<{ code: string; name: string; type: string; value: string; is_active: boolean; times_used: number; max_uses: number | null }>("promociones", SQL_PROMOTIONS, [organizationId, limit]);
    return rows.map((r) => ({ code: r.code, name: r.name, type: r.type, value: num(r.value), isActive: r.is_active, timesUsed: num(r.times_used), maxUses: r.max_uses }));
  }

  /** CFO-09: el servicio del CFO sobre la sesion RLS del usuario (cada lectura del adaptador abre su SAVEPOINT; base sin migrar = `disponible: false`). */
  async cfo(entrada: Omit<EntradaServicioCfo, "repo">): Promise<ServicioCfo> {
    await this.aplicarTope();
    return new ServicioCfo({ ...entrada, repo: new PostgresCfoRepository(this.db) });
  }
}
