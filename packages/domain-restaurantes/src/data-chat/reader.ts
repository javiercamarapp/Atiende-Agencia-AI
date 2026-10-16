// Puerto de lectura del catalogo de restaurantes: el catalogo (catalog.ts) solo habla con
// esto, nunca con SQL. Las implementaciones: Postgres (postgres-reader.ts, sesion RLS del
// usuario) y dobles de prueba.
import type { EntradaServicioCfo, ServicioCfo } from "../cfo/servicio.ts";

export interface DataChatWindow {
  readonly organizationId: string;
  /** null = todas las sucursales de la organizacion. Lo fija el SERVIDOR (membership), no el modelo. */
  readonly propertyIds: readonly string[] | null;
  readonly start: Date;
  readonly end: Date;
  readonly timezone: string;
  /** Tope de filas (el catalogo pide maxRows + 1 para detectar truncamiento). */
  readonly limit: number;
}

export interface VisibleBranch {
  readonly propertyId: string;
  readonly name: string;
  readonly slug: string;
}

export type SalesGranularity = "day" | "week" | "month";
export interface SalesByPeriodRow { readonly bucket: string; readonly revenue: number; readonly orders: number }
export interface SalesByBranchRow { readonly branch: string; readonly revenue: number; readonly orders: number }
export interface TopProductRow { readonly product: string; readonly quantity: number; readonly revenue: number }
export interface OrderStatsRow { readonly orders: number; readonly revenue: number; readonly cancelled: number }
export interface ChannelRow { readonly channel: string; readonly orders: number; readonly revenue: number }
export interface PeakHourRow { readonly hour: number; readonly orders: number; readonly revenue: number }
export interface RecurringRow { readonly customers: number; readonly recurring: number; readonly newCustomers: number }
export interface PromotionRow {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly value: number;
  readonly isActive: boolean;
  readonly timesUsed: number;
  readonly maxUses: number | null;
}

/** La base todavia no tiene la tabla/columna/funcion (migracion pendiente): honesto, no un 500. */
export class DataChatUnavailableError extends Error {
  constructor(readonly what: string) {
    super(`data_chat_unavailable:${what}`);
    this.name = "DataChatUnavailableError";
  }
}

export interface RestaurantesDataChatReader {
  listVisibleBranches(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleBranch[]>;
  salesByPeriod(w: DataChatWindow, unit: SalesGranularity): Promise<readonly SalesByPeriodRow[]>;
  salesByBranch(w: DataChatWindow): Promise<readonly SalesByBranchRow[]>;
  topProducts(w: DataChatWindow, by: "cantidad" | "ventas"): Promise<readonly TopProductRow[]>;
  orderStats(w: DataChatWindow): Promise<OrderStatsRow>;
  ordersByChannel(w: DataChatWindow): Promise<readonly ChannelRow[]>;
  peakHours(w: DataChatWindow): Promise<readonly PeakHourRow[]>;
  recurringCustomers(w: DataChatWindow): Promise<RecurringRow>;
  promotions(organizationId: string, limit: number): Promise<readonly PromotionRow[]>;
  /**
   * CFO-09: servicio del CFO (CFO-05) sobre la MISMA sesion del lector. Las herramientas `cfo_*` delegan en el: no hay SQL propia de
   * CFO aqui. OPCIONAL: un doble sin CFO hace que esas herramientas respondan "no disponible". Contra una base sin las migraciones
   * 081-084 el servicio degrada con `disponible: false` (nunca 500).
   */
  cfo?(entrada: Omit<EntradaServicioCfo, "repo">): Promise<ServicioCfo>;
}
