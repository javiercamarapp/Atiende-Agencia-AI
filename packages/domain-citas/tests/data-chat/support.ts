import type { DataChatScope, VisibleProperty } from "@atiende/agent-core/data-chat";
import {
  CitasDataChatUnavailableError,
  type CitasDataChatReader,
  type CitasDataChatWindow,
} from "../../src/data-chat/index.ts";
import type {
  AppointmentsByPeriodRow,
  AttendanceRow,
  BranchOccupancyRow,
  CustomersRow,
  FreeSlotRow,
  Granularity,
  OccupancyRow,
  PendingRemindersRow,
  ReminderDeliveryRow,
  RevenueByPeriodRow,
  RevenueByServiceRow,
} from "../../src/data-chat/reader.ts";

export const ORG_A = "00000000-0000-0000-0000-0000000000a1";
export const BRANCH_CENTRO = "00000000-0000-0000-0000-0000000000c1";
export const BRANCH_NORTE = "00000000-0000-0000-0000-0000000000c2";

export const ALL_BRANCHES: readonly VisibleProperty[] = [
  { propertyId: BRANCH_CENTRO, name: "Centro", slug: "Centro" },
  { propertyId: BRANCH_NORTE, name: "Norte", slug: "Norte" },
];

/** 29-sep-2026 23:30 en Mérida = 30-sep 05:30 UTC (en UTC ya es "mañana"). */
export const NOW = new Date("2026-09-30T05:30:00.000Z");

export const OWNER_SCOPE: DataChatScope = {
  organizationId: ORG_A,
  userId: "user-owner",
  vertical: "citas",
  verticalRole: "owner",
  allowedPropertyIds: null,
  timezone: "America/Merida",
};
export const ADMIN_CENTRO_SCOPE: DataChatScope = { ...OWNER_SCOPE, userId: "user-centro", verticalRole: "admin", allowedPropertyIds: [BRANCH_CENTRO] };

export interface Call {
  readonly method: string;
  readonly window?: CitasDataChatWindow;
  readonly extra?: unknown;
}

/** Doble del lector: registra cada llamada y respeta el alcance igual que la base real (filtra sucursales visibles). */
export class FakeReader implements CitasDataChatReader {
  readonly calls: Call[] = [];
  byPeriod: readonly AppointmentsByPeriodRow[] = [
    { bucket: "2026-09-28", total: 5, scheduled: 1, completed: 3, cancelled: 1, noShow: 0 },
    { bucket: "2026-09-29", total: 4, scheduled: 2, completed: 1, cancelled: 0, noShow: 1 },
  ];
  occupancy: readonly OccupancyRow[] = [
    { provider: "Ana Pérez", branch: "Centro", availableMinutes: 960, bookedMinutes: 150, totalAvailable: 2100, totalBooked: 360, totalProviders: 3 },
    { provider: "Beto Ruiz", branch: "Norte", availableMinutes: 1080, bookedMinutes: 180, totalAvailable: 2100, totalBooked: 360, totalProviders: 3 },
  ];
  branchOccupancy: readonly BranchOccupancyRow[] = [
    { branch: "Centro", providers: 1, availableMinutes: 960, bookedMinutes: 150, totalAvailable: 2100, totalBooked: 360, totalProviders: 3 },
    { branch: "Norte", providers: 1, availableMinutes: 1080, bookedMinutes: 180, totalAvailable: 2100, totalBooked: 360, totalProviders: 3 },
  ];
  attendance: readonly AttendanceRow[] = [
    { provider: "Ana Pérez", total: 6, completed: 3, cancelled: 1, noShow: 1, grandTotal: 11, grandCancelled: 1, grandNoShow: 1 },
    { provider: "Beto Ruiz", total: 4, completed: 3, cancelled: 0, noShow: 0, grandTotal: 11, grandCancelled: 1, grandNoShow: 1 },
  ];
  revenuePeriodRows: readonly RevenueByPeriodRow[] = [
    { bucket: "2026-09-28", appointments: 5, revenueCents: 160000, withoutPrice: 1 },
    { bucket: "2026-09-29", appointments: 1, revenueCents: 50000, withoutPrice: 0 },
  ];
  revenueServiceRows: readonly RevenueByServiceRow[] = [
    { service: "Consulta", appointments: 4, revenueCents: 200000, withoutPrice: 0, totalRevenueCents: 260000 },
    { service: "Limpieza", appointments: 2, revenueCents: 60000, withoutPrice: 0, totalRevenueCents: 260000 },
  ];
  customerCounts: CustomersRow = { customers: 3, newCustomers: 2, recurring: 1 };
  free: readonly FreeSlotRow[] = [
    { day: "2026-09-30", provider: "Ana Pérez", branch: "Centro", freeMinutes: 90, totalFree: 705 },
    { day: "2026-09-30", provider: "Beto Ruiz", branch: "Norte", freeMinutes: 195, totalFree: 705 },
  ];
  pending: PendingRemindersRow = { pending: 3, next24h: 2 };
  delivery: readonly ReminderDeliveryRow[] = [
    { channel: "email", status: "sent", total: 1 },
    { channel: "whatsapp", status: "dead", total: 1 },
    { channel: "whatsapp", status: "failed", total: 2 },
    { channel: "whatsapp", status: "pending", total: 1 },
    { channel: "whatsapp", status: "sent", total: 4 },
  ];
  failWith: Error | null = null;
  /** Falla solo el detalle de envío (la migración 027 aún no está aplicada). */
  deliveryUnavailable = false;

  constructor(private readonly branches: readonly VisibleProperty[] = ALL_BRANCHES) {}

  private enter(method: string, window?: CitasDataChatWindow, extra?: unknown): void {
    this.calls.push({ method, window, extra });
    if (this.failWith && method !== "listVisibleBranches") throw this.failWith;
  }

  async listVisibleBranches(organizationId: string, propertyIds: readonly string[] | null) {
    this.enter("listVisibleBranches", undefined, { organizationId, propertyIds });
    return propertyIds === null ? this.branches : this.branches.filter((b) => propertyIds.includes(b.propertyId));
  }
  async appointmentsByPeriod(w: CitasDataChatWindow, unit: Granularity) {
    this.enter("appointmentsByPeriod", w, { unit });
    return this.byPeriod;
  }
  async occupancyByProvider(w: CitasDataChatWindow) {
    this.enter("occupancyByProvider", w);
    return this.occupancy;
  }
  async occupancyByBranch(w: CitasDataChatWindow) {
    this.enter("occupancyByBranch", w);
    return this.branchOccupancy;
  }
  async attendanceByProvider(w: CitasDataChatWindow) {
    this.enter("attendanceByProvider", w);
    return this.attendance;
  }
  async revenueByPeriod(w: CitasDataChatWindow, unit: Granularity) {
    this.enter("revenueByPeriod", w, { unit });
    return this.revenuePeriodRows;
  }
  async revenueByService(w: CitasDataChatWindow) {
    this.enter("revenueByService", w);
    return this.revenueServiceRows;
  }
  async customers(w: CitasDataChatWindow) {
    this.enter("customers", w);
    return this.customerCounts;
  }
  async freeSlots(w: CitasDataChatWindow, now: Date) {
    this.enter("freeSlots", w, { now });
    return this.free;
  }
  async pendingReminders(w: CitasDataChatWindow, now: Date) {
    this.enter("pendingReminders", w, { now });
    return this.pending;
  }
  async reminderDelivery(w: CitasDataChatWindow) {
    this.enter("reminderDelivery", w);
    if (this.deliveryUnavailable) throw unavailable("recordatorios");
    return this.delivery;
  }
}

export const unavailable = (what = "citas"): CitasDataChatUnavailableError => new CitasDataChatUnavailableError(what);
