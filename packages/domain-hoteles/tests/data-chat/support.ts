import type { DataChatScope, VisibleProperty } from "@atiende/agent-core/data-chat";
import {
  HotelesDataChatUnavailableError,
  type HotelesDataChatReader,
  type HotelesDataChatWindow,
} from "../../src/data-chat/index.ts";
import type {
  ArrivalsDeparturesRow,
  CancellationRow,
  Granularity,
  HousekeepingPendingRow,
  OccupancyRow,
  OpenTicketsRow,
  RevenueRow,
} from "../../src/data-chat/reader.ts";

export const ORG_A = "00000000-0000-0000-0000-0000000000a1";
export const HOTEL_CENTRO = "00000000-0000-0000-0000-0000000000c1";
export const HOTEL_PLAYA = "00000000-0000-0000-0000-0000000000c2";

export const ALL_HOTELS: readonly VisibleProperty[] = [
  { propertyId: HOTEL_CENTRO, name: "Hotel Centro", slug: "Hotel Centro" },
  { propertyId: HOTEL_PLAYA, name: "Hotel Playa del Carmen", slug: "Hotel Playa del Carmen" },
];

/** 29-sep-2026 23:30 en Mérida = 30-sep 05:30 UTC (en UTC ya es "mañana"). */
export const NOW = new Date("2026-09-30T05:30:00.000Z");

export const OWNER_SCOPE: DataChatScope = {
  organizationId: ORG_A,
  userId: "user-owner",
  vertical: "hoteles",
  verticalRole: "owner",
  allowedPropertyIds: null,
  timezone: "America/Merida",
};

export const GM_CENTRO_SCOPE: DataChatScope = { ...OWNER_SCOPE, userId: "user-gm", verticalRole: "gm", allowedPropertyIds: [HOTEL_CENTRO] };

export interface Call {
  readonly method: string;
  readonly window?: HotelesDataChatWindow;
  readonly extra?: unknown;
}

/** Doble del lector: registra cada llamada y respeta el alcance igual que la base real (filtra hoteles visibles). */
export class FakeReader implements HotelesDataChatReader {
  readonly calls: Call[] = [];
  occupancyRows: readonly OccupancyRow[] = [
    { bucket: "2026-09-28", availableNights: 35, occupiedNights: 10, roomRevenue: 9200 },
    { bucket: "2026-09-29", availableNights: 35, occupiedNights: 13, roomRevenue: 12000 },
  ];
  revenueRows: readonly RevenueRow[] = [
    { bucket: "2026-09-28", rooms: 6000, foodBeverage: 0, other: 0 },
    { bucket: "2026-09-29", rooms: 7800.1, foodBeverage: 500, other: 300.05 },
  ];
  movementRows: readonly ArrivalsDeparturesRow[] = [
    { bucket: "2026-09-29", arrivals: 2, departures: 0 },
    { bucket: "2026-09-30", arrivals: 0, departures: 2 },
  ];
  cancelRows: readonly CancellationRow[] = [{ bucket: "2026-09-29", cancelled: 1, bookedValue: 1500, penalties: 300 }];
  ticketRows: readonly OpenTicketsRow[] = [
    { department: "frontdesk", priority: "alta", openTickets: 2, overdue: 2, dueSoon: 0, escalated: 1 },
    { department: "housekeeping", priority: "media", openTickets: 1, overdue: 0, dueSoon: 1, escalated: 0 },
  ];
  hkRows: readonly HousekeepingPendingRow[] = [
    { taskType: "salida", pending: 2, inProgress: 0, backlog: 1, highPriority: 1 },
    { taskType: "estancia", pending: 0, inProgress: 1, backlog: 0, highPriority: 0 },
  ];
  failWith: Error | null = null;

  constructor(private readonly hotels: readonly VisibleProperty[] = ALL_HOTELS) {}

  private enter(method: string, window?: HotelesDataChatWindow, extra?: unknown): void {
    this.calls.push({ method, window, extra });
    if (this.failWith && method !== "listVisibleHotels") throw this.failWith;
  }

  async listVisibleHotels(organizationId: string, propertyIds: readonly string[] | null) {
    this.enter("listVisibleHotels", undefined, { organizationId, propertyIds });
    return propertyIds === null ? this.hotels : this.hotels.filter((b) => propertyIds.includes(b.propertyId));
  }
  async occupancy(w: HotelesDataChatWindow, unit: Granularity) {
    this.enter("occupancy", w, unit);
    return this.occupancyRows;
  }
  async revenue(w: HotelesDataChatWindow, unit: Granularity) {
    this.enter("revenue", w, unit);
    return this.revenueRows;
  }
  async arrivalsDepartures(w: HotelesDataChatWindow, unit: Granularity) {
    this.enter("arrivalsDepartures", w, unit);
    return this.movementRows;
  }
  async cancellations(w: HotelesDataChatWindow, unit: Granularity) {
    this.enter("cancellations", w, unit);
    return this.cancelRows;
  }
  async openTickets(organizationId: string, propertyIds: readonly string[] | null, now: Date, limit: number) {
    this.enter("openTickets", undefined, { organizationId, propertyIds, now, limit });
    return this.ticketRows;
  }
  async housekeepingPending(organizationId: string, propertyIds: readonly string[] | null, today: string, limit: number) {
    this.enter("housekeepingPending", undefined, { organizationId, propertyIds, today, limit });
    return this.hkRows;
  }
}

export const unavailable = (): HotelesDataChatUnavailableError => new HotelesDataChatUnavailableError("cargos");
