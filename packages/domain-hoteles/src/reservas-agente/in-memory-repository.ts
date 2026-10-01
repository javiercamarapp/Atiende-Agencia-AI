// Repositorio en memoria del agente de reservas (H-25). Espejo de la logica de la migracion 037 para pruebas de dominio y la
// integracion HTTP rapida; NO sustituye la verificacion contra Postgres real (RLS, GRANT, triggers, funciones definer,
// concurrencia real: scripts/verify-hoteles-reservas-agente). El codigo es sincrono entre la comprobacion de cupo y la
// retencion, asi que dos `createHold` concurrentes (Promise.all) se serializan igual que el advisory lock de la base.
import { randomUUID } from "node:crypto";
import type { ReservasAgenteRepository } from "./repository.ts";
import { nightsBetweenDates } from "./validacion.ts";
import {
  DEFAULT_BOOKING_POLICY,
  HOLD_DECISION_ROLES,
  HOLD_OPEN_STATUSES,
  HOLD_POLICY_ROLES,
  HOLD_VIEW_ROLES,
  ReservasAgenteError,
  ReservasAgenteUnavailableError,
} from "./tipos.ts";
import type {
  BookingPolicyInput,
  BookingPolicyRecord,
  BookingPolicyResult,
  CreateHoldInput,
  HoldListResult,
  HoldRecord,
  HoldStatus,
  NightlyPrice,
  StayOption,
  StayOptionsResult,
} from "./tipos.ts";

interface RateRow {
  priceCents: number;
  minStay: number;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  currency: string;
}
interface InvRow {
  total: number;
  booked: number;
}
interface PropertyState {
  organizationId: string;
  timezone: string;
  ivaBps: number;
  ishBps: number;
  policy: BookingPolicyRecord;
  roomTypes: Map<string, { name: string; maxOccupancy: number }>;
  inventory: Map<string, InvRow>;
  rates: Map<string, RateRow>;
  guard: Map<string, { floorCents: number; ceilingCents: number }>;
}

interface StoredHold extends HoldRecord {
  idempotencyKey: string;
  nightly: readonly NightlyPrice[];
}

export interface HoldEventRecord {
  readonly holdId: string;
  readonly eventType: string;
  readonly actorId: string | null;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function eachNight(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) out.push(d);
  return out;
}

function localToday(timezone: string, now: Date): string {
  let tz = timezone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    tz = "America/Mexico_City";
  }
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface InMemoryActor {
  readonly userId: string | null;
  readonly role: string | null;
}

export class InMemoryReservasAgenteRepository implements ReservasAgenteRepository {
  private readonly properties = new Map<string, PropertyState>();
  private readonly holds: StoredHold[] = [];
  readonly events: HoldEventRecord[] = [];
  /** null userId = sesion de sistema (agente). */
  actor: InMemoryActor = { userId: null, role: null };
  /** Simula la base sin la migracion 037. */
  migrationApplied = true;
  clock: () => Date = () => new Date();

  // ---- siembra (solo pruebas) ----
  seedProperty(propertyId: string, opts: { organizationId?: string; timezone?: string; ivaBps?: number; ishBps?: number } = {}): void {
    this.properties.set(propertyId, {
      organizationId: opts.organizationId ?? randomUUID(),
      timezone: opts.timezone ?? "America/Mexico_City",
      ivaBps: opts.ivaBps ?? 1600,
      ishBps: opts.ishBps ?? 300,
      policy: { propertyId, ...DEFAULT_BOOKING_POLICY, configured: false },
      roomTypes: new Map(),
      inventory: new Map(),
      rates: new Map(),
      guard: new Map(),
    });
  }
  private prop(propertyId: string): PropertyState {
    const p = this.properties.get(propertyId);
    if (!p) throw new ReservasAgenteError("no_encontrada", "property no encontrada");
    return p;
  }
  seedRoomType(propertyId: string, roomTypeId: string, name: string, maxOccupancy = 2): void {
    this.prop(propertyId).roomTypes.set(roomTypeId, { name, maxOccupancy });
  }
  seedInventory(propertyId: string, roomTypeId: string, fromDate: string, toDate: string, total: number, priceCents: number, extra: Partial<RateRow> = {}): void {
    const p = this.prop(propertyId);
    for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
      p.inventory.set(`${roomTypeId}|${d}`, { total, booked: 0 });
      p.rates.set(`${roomTypeId}|${d}`, { priceCents, minStay: 1, closedToArrival: false, closedToDeparture: false, currency: "MXN", ...extra });
    }
  }
  setRate(propertyId: string, roomTypeId: string, date: string, patch: Partial<RateRow>): void {
    const p = this.prop(propertyId);
    const cur = p.rates.get(`${roomTypeId}|${date}`);
    if (cur) p.rates.set(`${roomTypeId}|${date}`, { ...cur, ...patch });
  }
  setPriceGuard(propertyId: string, roomTypeId: string, floorCents: number, ceilingCents: number): void {
    this.prop(propertyId).guard.set(roomTypeId, { floorCents, ceilingCents });
  }
  setPolicy(propertyId: string, patch: Partial<BookingPolicyInput>): void {
    const p = this.prop(propertyId);
    p.policy = { ...p.policy, ...patch, configured: true };
  }
  booked(propertyId: string, roomTypeId: string, date: string): number {
    return this.prop(propertyId).inventory.get(`${roomTypeId}|${date}`)?.booked ?? 0;
  }
  allHolds(): readonly HoldRecord[] {
    return this.holds.map((h) => this.toRecord(h));
  }
  /** Invariante global: ninguna noche vendida de mas ni en negativo. */
  oversoldNights(): number {
    let n = 0;
    for (const p of this.properties.values()) for (const inv of p.inventory.values()) if (inv.booked > inv.total || inv.booked < 0) n += 1;
    return n;
  }

  // ---- internos ----
  private requireSystem(): void {
    if (this.actor.userId !== null) throw new ReservasAgenteError("sin_permiso", "solo la sesion de sistema (agente) puede hacerlo");
  }
  private requireMigration(operation: string): void {
    if (!this.migrationApplied) throw new ReservasAgenteUnavailableError(operation);
  }
  private nowOf(now?: Date): Date {
    // Igual que agent_clock: el reloj de la app solo se respeta en sesion de sistema.
    return this.actor.userId === null ? (now ?? this.clock()) : this.clock();
  }
  private validateStay(p: PropertyState, checkIn: string, checkOut: string, now: Date): number {
    if (checkOut <= checkIn) throw new ReservasAgenteError("fechas_invalidas", "la salida debe ser posterior a la llegada");
    const today = localToday(p.timezone, now);
    if (checkIn < today) throw new ReservasAgenteError("fecha_pasada", "la llegada ya paso en la zona horaria del hotel");
    if (nightsBetweenDates(today, checkIn) > p.policy.maxAdvanceDays) throw new ReservasAgenteError("fecha_muy_lejana", "demasiado por adelantado");
    const nights = nightsBetweenDates(checkIn, checkOut);
    if (nights > p.policy.maxNights) throw new ReservasAgenteError("estadia_muy_larga", `maximo ${p.policy.maxNights} noches por el agente`);
    return nights;
  }
  private quote(p: PropertyState, roomTypeId: string, checkIn: string, checkOut: string): Pick<StayOption, "status" | "netCents" | "ivaCents" | "ishCents" | "totalCents" | "nightly"> {
    const none = { netCents: null, ivaCents: null, ishCents: null, totalCents: null, nightly: null };
    const nights = eachNight(checkIn, checkOut);
    const rows = nights.map((d) => p.rates.get(`${roomTypeId}|${d}`));
    if (rows.some((r) => !r)) return { status: "sin_tarifa", ...none };
    const rates = rows as RateRow[];
    if (rates.some((r) => r.currency !== "MXN")) return { status: "moneda_no_soportada", ...none };
    const arrival = rates[0]!;
    if (arrival.closedToArrival) return { status: "cerrado_a_llegada", ...none };
    if (nights.length < arrival.minStay) return { status: "estadia_minima_no_alcanzada", ...none };
    if (p.rates.get(`${roomTypeId}|${checkOut}`)?.closedToDeparture) return { status: "cerrado_a_salida", ...none };
    const g = p.guard.get(roomTypeId);
    if (g && rates.some((r) => r.priceCents < g.floorCents || r.priceCents > g.ceilingCents)) return { status: "precio_fuera_de_guardia", ...none };
    const net = rates.reduce((a, r) => a + r.priceCents, 0);
    if (net <= 0) return { status: "precio_fuera_de_guardia", ...none };
    const iva = Math.floor((net * p.ivaBps + 5000) / 10000);
    const ish = Math.floor((net * p.ishBps + 5000) / 10000);
    return { status: "ok", netCents: net, ivaCents: iva, ishCents: ish, totalCents: net + iva + ish, nightly: nights.map((d, i) => ({ date: d, cents: rates[i]!.priceCents })) };
  }
  private freeRooms(p: PropertyState, roomTypeId: string, checkIn: string, checkOut: string): number {
    const nights = eachNight(checkIn, checkOut);
    let min = Number.POSITIVE_INFINITY;
    for (const d of nights) {
      const inv = p.inventory.get(`${roomTypeId}|${d}`);
      if (!inv) return 0;
      min = Math.min(min, inv.total - inv.booked);
    }
    return Math.max(Number.isFinite(min) ? min : 0, 0);
  }
  private releaseInventory(p: PropertyState, h: StoredHold): void {
    for (const d of eachNight(h.checkInDate, h.checkOutDate)) {
      const inv = p.inventory.get(`${h.roomTypeId}|${d}`);
      if (inv) inv.booked = Math.max(inv.booked - 1, 0);
    }
  }
  private log(h: StoredHold, eventType: string): void {
    this.events.push({ holdId: h.id, eventType, actorId: this.actor.userId });
  }
  private setStatus(h: StoredHold, patch: Partial<StoredHold>): StoredHold {
    const idx = this.holds.indexOf(h);
    const next = { ...h, ...patch } as StoredHold;
    this.holds[idx] = next;
    return next;
  }
  private expireCore(propertyId: string, now: Date): number {
    const p = this.prop(propertyId);
    let n = 0;
    for (const h of [...this.holds]) {
      if (h.propertyId === propertyId && (HOLD_OPEN_STATUSES as readonly string[]).includes(h.status) && new Date(h.expiresAt).getTime() <= now.getTime()) {
        this.releaseInventory(p, h);
        const next = this.setStatus(h, { status: "expirado" });
        this.log(next, "expirado");
        n += 1;
      }
    }
    return n;
  }
  private toRecord(h: StoredHold): HoldRecord {
    const { idempotencyKey: _k, nightly: _n, ...rec } = h;
    return rec;
  }
  private isOpen(h: StoredHold): boolean {
    return (HOLD_OPEN_STATUSES as readonly string[]).includes(h.status);
  }

  // ---- agente (sistema) ----
  async stayOptions(propertyId: string, checkInDate: string, checkOutDate: string, now?: Date): Promise<StayOptionsResult> {
    if (!this.migrationApplied) return { disponible: false, checkInDate, checkOutDate, nights: nightsBetweenDates(checkInDate, checkOutDate), opciones: [] };
    this.requireSystem();
    const p = this.prop(propertyId);
    const at = this.nowOf(now);
    const nights = this.validateStay(p, checkInDate, checkOutDate, at);
    this.expireCore(propertyId, at);
    const opciones: StayOption[] = [...p.roomTypes.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([roomTypeId, rt]) => {
        const free = this.freeRooms(p, roomTypeId, checkInDate, checkOutDate);
        const q = free === 0
          ? { status: "sin_inventario" as const, netCents: null, ivaCents: null, ishCents: null, totalCents: null, nightly: null }
          : this.quote(p, roomTypeId, checkInDate, checkOutDate);
        return { roomTypeId, roomTypeName: rt.name, maxOccupancy: rt.maxOccupancy, freeRooms: free, ...q };
      });
    return { disponible: true, checkInDate, checkOutDate, nights, opciones };
  }

  async createHold(input: CreateHoldInput): Promise<HoldRecord> {
    this.requireMigration("createHold");
    this.requireSystem();
    const p = this.prop(input.propertyId);
    const now = this.nowOf(input.now);
    if (!p.policy.holdsEnabled) throw new ReservasAgenteError("holds_deshabilitados", "el hotel no habilito la pre-reserva por el agente");
    const phone = input.contactPhone.trim();
    if ((input.channel !== "whatsapp" && input.channel !== "voz") || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 120
        || phone.length < 4 || phone.length > 32 || (input.guestName !== null && input.guestName.length > 120)) {
      throw new ReservasAgenteError("parametros_invalidos", "canal, llave, telefono o nombre fuera de rango");
    }
    const byKey = this.holds.find((h) => h.propertyId === input.propertyId && h.idempotencyKey === input.idempotencyKey);
    if (byKey) {
      if (byKey.roomTypeId !== input.roomTypeId || byKey.checkInDate !== input.checkInDate || byKey.checkOutDate !== input.checkOutDate || byKey.contactPhone !== phone) {
        throw new ReservasAgenteError("idempotencia_conflicto", "la llave ya se uso con otros parametros");
      }
      return this.toRecord(byKey);
    }
    const natural = this.holds.find((h) => h.propertyId === input.propertyId && h.contactPhone === phone && h.roomTypeId === input.roomTypeId
      && h.checkInDate === input.checkInDate && h.checkOutDate === input.checkOutDate && this.isOpen(h) && new Date(h.expiresAt).getTime() > now.getTime());
    if (natural) return this.toRecord(natural);

    const nights = this.validateStay(p, input.checkInDate, input.checkOutDate, now);
    const rt = p.roomTypes.get(input.roomTypeId);
    if (!rt) throw new ReservasAgenteError("tipo_habitacion_invalido", "el tipo no pertenece a la property");
    const maxGuests = Math.min(p.policy.maxGuests, rt.maxOccupancy);
    if (!Number.isInteger(input.guests) || input.guests < 1 || input.guests > maxGuests) {
      throw new ReservasAgenteError("huespedes_invalidos", `de 1 a ${maxGuests} huespedes para este tipo`);
    }
    this.expireCore(input.propertyId, now);
    const open = this.holds.filter((h) => h.propertyId === input.propertyId && this.isOpen(h));
    if (open.length >= p.policy.maxActiveHolds) throw new ReservasAgenteError("limite_holds_activos", "demasiados holds abiertos en el hotel");
    if (open.filter((h) => h.contactPhone === phone).length >= 2) throw new ReservasAgenteError("limite_holds_contacto", "ya tiene 2 pre-reservas abiertas");

    const q = this.quote(p, input.roomTypeId, input.checkInDate, input.checkOutDate);
    if (q.status !== "ok") throw new ReservasAgenteError("cotizacion_no_disponible", `cotizacion_no_disponible: ${q.status}`, { status: q.status });
    if (input.expectedTotalCents !== q.totalCents) {
      throw new ReservasAgenteError("precio_cambio", `el total vigente es ${q.totalCents} centavos`, { totalCents: q.totalCents });
    }
    const nightsList = eachNight(input.checkInDate, input.checkOutDate);
    for (const d of nightsList) {
      const inv = p.inventory.get(`${input.roomTypeId}|${d}`);
      if (!inv || inv.booked + 1 > inv.total) throw new ReservasAgenteError("sin_disponibilidad", `no hay habitaciones libres para la fecha ${d}`);
    }
    for (const d of nightsList) p.inventory.get(`${input.roomTypeId}|${d}`)!.booked += 1;

    const hold: StoredHold = {
      id: randomUUID(),
      propertyId: input.propertyId,
      roomTypeId: input.roomTypeId,
      checkInDate: input.checkInDate,
      checkOutDate: input.checkOutDate,
      nights,
      guests: input.guests,
      channel: input.channel,
      guestName: input.guestName,
      contactPhone: phone,
      currency: "MXN",
      netCents: q.netCents!,
      ivaCents: q.ivaCents!,
      ishCents: q.ishCents!,
      totalCents: q.totalCents!,
      mode: p.policy.mode,
      status: p.policy.mode === "aprobacion_humana" ? "pendiente_aprobacion" : "pendiente_pago",
      expiresAt: new Date(now.getTime() + p.policy.holdTtlMinutes * 60_000).toISOString(),
      paymentLinkRef: null,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      reservationId: null,
      createdAt: now.toISOString(),
      idempotencyKey: input.idempotencyKey,
      nightly: q.nightly!,
    };
    this.holds.push(hold);
    this.log(hold, "creado");
    return this.toRecord(hold);
  }

  private findForContact(propertyId: string, holdId: string, phone: string): StoredHold {
    const h = this.holds.find((x) => x.id === holdId && x.propertyId === propertyId && x.contactPhone === phone.trim());
    if (!h) throw new ReservasAgenteError("no_encontrada", "pre-reserva no encontrada");
    return h;
  }
  async holdStatusForContact(propertyId: string, holdId: string, contactPhone: string, now?: Date): Promise<HoldRecord> {
    this.requireMigration("holdStatusForContact");
    this.requireSystem();
    this.expireCore(propertyId, this.nowOf(now));
    return this.toRecord(this.findForContact(propertyId, holdId, contactPhone));
  }
  async cancelHoldForContact(propertyId: string, holdId: string, contactPhone: string, now?: Date): Promise<HoldRecord> {
    this.requireMigration("cancelHoldForContact");
    this.requireSystem();
    this.expireCore(propertyId, this.nowOf(now));
    const h = this.findForContact(propertyId, holdId, contactPhone);
    if (h.status === "cancelado") return this.toRecord(h);
    if (!this.isOpen(h)) throw new ReservasAgenteError("estado_no_valido", `la pre-reserva esta en estado ${h.status}`);
    this.releaseInventory(this.prop(propertyId), h);
    const next = this.setStatus(h, { status: "cancelado" });
    this.log(next, "cancelado_por_huesped");
    return this.toRecord(next);
  }
  async expireDueHolds(propertyId: string | null, now?: Date): Promise<number> {
    this.requireMigration("expireDueHolds");
    this.requireSystem();
    const at = this.nowOf(now);
    let n = 0;
    for (const id of propertyId ? [propertyId] : [...this.properties.keys()]) n += this.expireCore(id, at);
    return n;
  }

  // ---- staff ----
  private requireStaff(roles: readonly string[]): void {
    if (this.actor.userId === null || !this.actor.role || !roles.includes(this.actor.role)) {
      throw new ReservasAgenteError(this.actor.userId === null ? "sin_permiso" : "no_encontrada", "sin permiso o no encontrada");
    }
  }
  private lockHold(propertyId: string, holdId: string): StoredHold {
    this.requireStaff(HOLD_DECISION_ROLES);
    const h = this.holds.find((x) => x.id === holdId && x.propertyId === propertyId);
    if (!h) throw new ReservasAgenteError("no_encontrada", "pre-reserva no encontrada");
    return h;
  }
  async listHolds(propertyId: string, filter: { status?: HoldStatus; onlyOpen?: boolean } = {}): Promise<HoldListResult> {
    if (!this.migrationApplied) return { disponible: false, holds: [] };
    if (this.actor.userId === null || !this.actor.role || !(HOLD_VIEW_ROLES as readonly string[]).includes(this.actor.role)) return { disponible: true, holds: [] };
    const rows = this.holds.filter((h) => h.propertyId === propertyId && (!filter.status || h.status === filter.status) && (!filter.onlyOpen || this.isOpen(h)));
    return { disponible: true, holds: rows.map((h) => this.toRecord(h)).reverse() };
  }
  async decideHold(propertyId: string, holdId: string, decision: "aprobar" | "rechazar", reason: string): Promise<HoldRecord> {
    this.requireMigration("decideHold");
    const h = this.lockHold(propertyId, holdId);
    if (decision !== "aprobar" && decision !== "rechazar") throw new ReservasAgenteError("parametros_invalidos", "decision invalida");
    if (!reason || reason.trim().length < 1 || reason.trim().length > 500) throw new ReservasAgenteError("parametros_invalidos", "el motivo es obligatorio");
    if (h.mode !== "aprobacion_humana" || h.status !== "pendiente_aprobacion") throw new ReservasAgenteError("estado_no_valido", `estado: ${h.status}`);
    const now = this.clock();
    if (new Date(h.expiresAt).getTime() <= now.getTime()) {
      this.expireCore(propertyId, now);
      return this.toRecord(this.holds.find((x) => x.id === holdId)!);
    }
    const p = this.prop(propertyId);
    let next: StoredHold;
    if (decision === "rechazar") {
      this.releaseInventory(p, h);
      next = this.setStatus(h, { status: "rechazado", decidedBy: this.actor.userId, decidedAt: now.toISOString(), decisionReason: reason.trim() });
    } else {
      next = this.setStatus(h, { status: "aprobado", decidedBy: this.actor.userId, decidedAt: now.toISOString(), decisionReason: reason.trim(), expiresAt: new Date(now.getTime() + p.policy.holdTtlMinutes * 60_000).toISOString() });
    }
    this.log(next, decision === "aprobar" ? "aprobado" : "rechazado");
    return this.toRecord(next);
  }
  async registerPaymentLink(propertyId: string, holdId: string, reference: string): Promise<HoldRecord> {
    this.requireMigration("registerPaymentLink");
    const h = this.lockHold(propertyId, holdId);
    if (h.mode !== "link_pago" || h.status !== "pendiente_pago") throw new ReservasAgenteError("estado_no_valido", `estado: ${h.status}`);
    const ref = (reference ?? "").trim();
    if (ref.length < 1 || ref.length > 200 || /[0-9]{13,19}/.test(ref.replace(/[ -]/g, ""))) {
      throw new ReservasAgenteError("parametros_invalidos", "referencia invalida: sin numeros con forma de tarjeta");
    }
    const next = this.setStatus(h, { paymentLinkRef: ref });
    this.log(next, "link_pago_registrado");
    return this.toRecord(next);
  }
  async confirmHold(propertyId: string, holdId: string): Promise<HoldRecord> {
    this.requireMigration("confirmHold");
    const h = this.lockHold(propertyId, holdId);
    if (h.status !== "aprobado" && h.status !== "pendiente_pago") throw new ReservasAgenteError("estado_no_valido", `estado: ${h.status}`);
    const now = this.clock();
    if (new Date(h.expiresAt).getTime() <= now.getTime()) {
      this.expireCore(propertyId, now);
      return this.toRecord(this.holds.find((x) => x.id === holdId)!);
    }
    const next = this.setStatus(h, { status: "confirmado", reservationId: randomUUID(), decidedBy: h.decidedBy ?? this.actor.userId, decidedAt: h.decidedAt ?? now.toISOString() });
    this.log(next, "confirmado");
    return this.toRecord(next);
  }
  async staffCancelHold(propertyId: string, holdId: string, reason: string): Promise<HoldRecord> {
    this.requireMigration("staffCancelHold");
    const h = this.lockHold(propertyId, holdId);
    if (!reason || reason.trim().length < 1 || reason.trim().length > 500) throw new ReservasAgenteError("parametros_invalidos", "el motivo es obligatorio");
    if (!this.isOpen(h)) throw new ReservasAgenteError("estado_no_valido", `estado: ${h.status}`);
    this.releaseInventory(this.prop(propertyId), h);
    const next = this.setStatus(h, { status: "cancelado", decidedBy: this.actor.userId, decidedAt: this.clock().toISOString(), decisionReason: reason.trim() });
    this.log(next, "cancelado_por_staff");
    return this.toRecord(next);
  }
  async getPolicy(propertyId: string): Promise<BookingPolicyResult> {
    if (!this.migrationApplied) return { disponible: false, politica: { propertyId, ...DEFAULT_BOOKING_POLICY, configured: false } };
    return { disponible: true, politica: this.prop(propertyId).policy };
  }
  async upsertPolicy(propertyId: string, input: BookingPolicyInput): Promise<BookingPolicyResult> {
    this.requireMigration("upsertPolicy");
    this.requireStaff(HOLD_POLICY_ROLES);
    if (input.holdTtlMinutes < 15 || input.holdTtlMinutes > 4320 || input.maxNights < 1 || input.maxNights > 60 || input.maxGuests < 1 || input.maxGuests > 20
        || input.maxAdvanceDays < 1 || input.maxAdvanceDays > 730 || input.maxActiveHolds < 1 || input.maxActiveHolds > 500 || (input.mode !== "aprobacion_humana" && input.mode !== "link_pago")) {
      throw new ReservasAgenteError("parametros_invalidos", "politica fuera de rango");
    }
    const p = this.prop(propertyId);
    p.policy = { propertyId, ...input, configured: true };
    return { disponible: true, politica: p.policy };
  }
}
