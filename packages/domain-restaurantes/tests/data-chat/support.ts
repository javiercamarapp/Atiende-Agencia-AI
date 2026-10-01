import type { DataChatScope } from "@atiende/agent-core/data-chat";
import {
  DataChatUnavailableError,
  type DataChatWindow,
  type RestaurantesDataChatReader,
  type SalesGranularity,
  type VisibleBranch,
} from "../../src/data-chat/index.ts";
import type { ChannelRow, OrderStatsRow, PeakHourRow, PromotionRow, RecurringRow, SalesByBranchRow, SalesByPeriodRow, TopProductRow } from "../../src/data-chat/reader.ts";

export const ORG_A = "00000000-0000-0000-0000-0000000000a1";
export const BRANCH_CENTRO = "00000000-0000-0000-0000-0000000000c1";
export const BRANCH_NORTE = "00000000-0000-0000-0000-0000000000c2";
export const BRANCH_ORIENTE = "00000000-0000-0000-0000-0000000000c3";

export const ALL_BRANCHES: readonly VisibleBranch[] = [
  { propertyId: BRANCH_CENTRO, name: "Centro", slug: "centro" },
  { propertyId: BRANCH_NORTE, name: "Norte", slug: "norte" },
  { propertyId: BRANCH_ORIENTE, name: "Oriente Mérida", slug: "oriente-merida" },
];

/** 29-sep-2026 23:30 en Mérida = 30-sep 05:30 UTC. */
export const NOW = new Date("2026-09-30T05:30:00.000Z");

export const OWNER_SCOPE: DataChatScope = {
  organizationId: ORG_A,
  userId: "user-owner",
  vertical: "restaurantes",
  verticalRole: "owner",
  allowedPropertyIds: null,
  timezone: "America/Merida",
};

export const GERENTE_CENTRO_SCOPE: DataChatScope = { ...OWNER_SCOPE, userId: "user-gerente", verticalRole: "staff", allowedPropertyIds: [BRANCH_CENTRO] };

export interface Call {
  readonly method: string;
  readonly window?: DataChatWindow;
  readonly extra?: unknown;
}

/** Doble del lector: registra cada llamada y respeta el alcance igual que la base real (filtra sucursales visibles). */
export class FakeReader implements RestaurantesDataChatReader {
  readonly calls: Call[] = [];
  salesRows: readonly SalesByPeriodRow[] = [
    { bucket: "2026-09-28", revenue: 1500.5, orders: 12 },
    { bucket: "2026-09-29", revenue: 980.25, orders: 8 },
  ];
  branchRows: readonly SalesByBranchRow[] = [
    { branch: "Centro", revenue: 3000, orders: 20 },
    { branch: "Norte", revenue: 1000, orders: 10 },
  ];
  productRows: readonly TopProductRow[] = [
    { product: "Taco de cochinita", quantity: 120, revenue: 4800 },
    { product: "Panucho", quantity: 80, revenue: 2400 },
  ];
  stats: OrderStatsRow = { orders: 20, revenue: 2480.75, cancelled: 2 };
  channelRows: readonly ChannelRow[] = [
    { channel: "whatsapp", orders: 15, revenue: 1800 },
    { channel: "voice", orders: 5, revenue: 680.75 },
  ];
  hourRows: readonly PeakHourRow[] = [
    { hour: 14, orders: 9, revenue: 1100 },
    { hour: 20, orders: 6, revenue: 800 },
  ];
  recurring: RecurringRow = { customers: 40, recurring: 18, newCustomers: 22 };
  promos: readonly PromotionRow[] = [
    { code: "BIENVENIDA10", name: "Bienvenida", type: "percentage", value: 10, isActive: true, timesUsed: 33, maxUses: null },
    { code: "MENOS50", name: "Menos 50", type: "fixed", value: 50, isActive: false, timesUsed: 4, maxUses: 100 },
  ];
  failWith: Error | null = null;

  constructor(private readonly branches: readonly VisibleBranch[] = ALL_BRANCHES) {}

  private enter(method: string, window?: DataChatWindow, extra?: unknown): void {
    this.calls.push({ method, window, extra });
    if (this.failWith && method !== "listVisibleBranches") throw this.failWith;
  }

  async listVisibleBranches(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleBranch[]> {
    this.enter("listVisibleBranches", undefined, { organizationId, propertyIds });
    return propertyIds === null ? this.branches : this.branches.filter((b) => propertyIds.includes(b.propertyId));
  }
  async salesByPeriod(w: DataChatWindow, unit: SalesGranularity) {
    this.enter("salesByPeriod", w, unit);
    return this.salesRows;
  }
  async salesByBranch(w: DataChatWindow) {
    this.enter("salesByBranch", w);
    return this.branchRows;
  }
  async topProducts(w: DataChatWindow, by: "cantidad" | "ventas") {
    this.enter("topProducts", w, by);
    return this.productRows;
  }
  async orderStats(w: DataChatWindow) {
    this.enter("orderStats", w);
    return this.stats;
  }
  async ordersByChannel(w: DataChatWindow) {
    this.enter("ordersByChannel", w);
    return this.channelRows;
  }
  async peakHours(w: DataChatWindow) {
    this.enter("peakHours", w);
    return this.hourRows;
  }
  async recurringCustomers(w: DataChatWindow) {
    this.enter("recurringCustomers", w);
    return this.recurring;
  }
  async promotions(organizationId: string, limit: number) {
    this.enter("promotions", undefined, { organizationId, limit });
    return this.promos;
  }
}

export const unavailable = (): DataChatUnavailableError => new DataChatUnavailableError("pedidos");
