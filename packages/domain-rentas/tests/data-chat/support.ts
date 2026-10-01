import type { DataChatScope, VisibleProperty } from "@atiende/agent-core/data-chat";
import { RentasDataChatUnavailableError, type RentasDataChatReader, type RentasDataChatWindow } from "../../src/data-chat/index.ts";
import type {
  ChannelPayoutRow,
  IncomeByChannelRow,
  IncomeByOwnerRow,
  OpenConflictRow,
  OwnerStatementRow,
  PendingTaskRow,
  TaskKind,
  UnitOccupancyRow,
} from "../../src/data-chat/reader.ts";

export const ORG_A = "00000000-0000-0000-0000-0000000000a1";
export const PROP_PLAYA = "00000000-0000-0000-0000-0000000000c1";
export const PROP_CENTRO = "00000000-0000-0000-0000-0000000000c2";

export const ALL_PROPERTIES: readonly VisibleProperty[] = [
  { propertyId: PROP_PLAYA, name: "Casas de Playa", slug: "Casas de Playa" },
  { propertyId: PROP_CENTRO, name: "Edificio Centro", slug: "Edificio Centro" },
];

/** 29-sep-2026 23:30 en Mérida = 30-sep 05:30 UTC (en UTC ya es "mañana"). */
export const NOW = new Date("2026-09-30T05:30:00.000Z");

export const ADMIN_SCOPE: DataChatScope = {
  organizationId: ORG_A,
  userId: "user-admin",
  vertical: "rentas",
  verticalRole: "admin_gestora",
  allowedPropertyIds: null,
  timezone: "America/Merida",
};
export const ADMIN_CENTRO_SCOPE: DataChatScope = { ...ADMIN_SCOPE, userId: "user-centro", allowedPropertyIds: [PROP_CENTRO] };

export interface Call {
  readonly method: string;
  readonly window?: RentasDataChatWindow;
  readonly extra?: unknown;
}

/** Doble del lector: registra cada llamada y respeta el alcance igual que la base real (filtra propiedades visibles). */
export class FakeReader implements RentasDataChatReader {
  readonly calls: Call[] = [];
  occupancy: readonly UnitOccupancyRow[] = [
    { unitName: "Playa 1", bookedNights: 8, blockedNights: 2, periodNights: 30, totalBooked: 18, totalBlocked: 5, totalPeriod: 120, totalUnits: 4 },
    { unitName: "Playa 2", bookedNights: 5, blockedNights: 0, periodNights: 30, totalBooked: 18, totalBlocked: 5, totalPeriod: 120, totalUnits: 4 },
  ];
  byChannel: readonly IncomeByChannelRow[] = [
    { channel: "Airbnb", bookings: 3, nights: 10, grossCents: 130000, channelFeeCents: 19500, netCents: 90000, otherCurrency: 1 },
    { channel: "Booking.com", bookings: 1, nights: 3, grossCents: 60000, channelFeeCents: 9000, netCents: 40000, otherCurrency: 0 },
  ];
  byOwner: readonly IncomeByOwnerRow[] = [
    { ownerName: "Propietario Uno", bookings: 3, nights: 13, grossCents: 210000, feesCents: 45000, netCents: 150000, otherCurrency: 0 },
    { ownerName: "Sin propietario asignado", bookings: 1, nights: 2, grossCents: 10000, feesCents: 1000, netCents: 8000, otherCurrency: 0 },
  ];
  conflicts: readonly OpenConflictRow[] = [
    { unitName: "Playa 1", kind: "capa_cruzada", daysOpen: 10, total: 2 },
    { unitName: "Centro 1", kind: "overbooking_confirmado", daysOpen: 2, total: 2 },
  ];
  tasks: readonly PendingTaskRow[] = [
    { unitName: "Playa 2", kind: "limpieza", status: "asignada", priority: "media", scheduled: "2026-09-29", slaOverdue: false, total: 3 },
    { unitName: "Playa 1", kind: "limpieza", status: "pendiente", priority: "alta", scheduled: "2026-09-29", slaOverdue: true, total: 3 },
    { unitName: "Centro 1", kind: "limpieza", status: "en_progreso", priority: "urgente", scheduled: "2026-09-29", slaOverdue: false, total: 3 },
  ];
  statements: readonly OwnerStatementRow[] = [
    { ownerName: "Propietario Uno", periodStart: "2026-09-01", periodEnd: "2026-09-30", version: 2, currency: "MXN", grossCents: 110000, netCents: 80000, generatedOn: "2026-10-02" },
    { ownerName: "Propietario Uno", periodStart: "2026-09-01", periodEnd: "2026-09-30", version: 1, currency: "USD", grossCents: 5000, netCents: 4500, generatedOn: "2026-10-01" },
  ];
  payouts: readonly ChannelPayoutRow[] = [
    { channel: "Airbnb", payouts: 2, totalCents: 250000, pendingLines: 3, mismatchedLines: 1, otherCurrency: 0 },
    { channel: "Vrbo", payouts: 1, totalCents: 0, pendingLines: 0, mismatchedLines: 0, otherCurrency: 1 },
  ];
  failWith: Error | null = null;

  constructor(private readonly properties: readonly VisibleProperty[] = ALL_PROPERTIES) {}

  private enter(method: string, window?: RentasDataChatWindow, extra?: unknown): void {
    this.calls.push({ method, window, extra });
    if (this.failWith && method !== "listVisibleProperties") throw this.failWith;
  }

  async listVisibleProperties(organizationId: string, propertyIds: readonly string[] | null) {
    this.enter("listVisibleProperties", undefined, { organizationId, propertyIds });
    return propertyIds === null ? this.properties : this.properties.filter((b) => propertyIds.includes(b.propertyId));
  }
  async occupancyByUnit(w: RentasDataChatWindow) {
    this.enter("occupancyByUnit", w);
    return this.occupancy;
  }
  async incomeByChannel(w: RentasDataChatWindow) {
    this.enter("incomeByChannel", w);
    return this.byChannel;
  }
  async incomeByOwner(w: RentasDataChatWindow) {
    this.enter("incomeByOwner", w);
    return this.byOwner;
  }
  async openConflicts(organizationId: string, propertyIds: readonly string[] | null, now: Date, limit: number) {
    this.enter("openConflicts", undefined, { organizationId, propertyIds, now, limit });
    return this.conflicts;
  }
  async pendingTasks(organizationId: string, propertyIds: readonly string[] | null, range: { fromDate: string | null; toDate: string }, now: Date, kind: TaskKind | null, limit: number) {
    this.enter("pendingTasks", undefined, { organizationId, propertyIds, range, now, kind, limit });
    return this.tasks;
  }
  async ownerStatements(w: RentasDataChatWindow) {
    this.enter("ownerStatements", w);
    return this.statements;
  }
  async channelPayouts(w: RentasDataChatWindow) {
    this.enter("channelPayouts", w);
    return this.payouts;
  }
}

export const unavailable = (): RentasDataChatUnavailableError => new RentasDataChatUnavailableError("finanzas");
