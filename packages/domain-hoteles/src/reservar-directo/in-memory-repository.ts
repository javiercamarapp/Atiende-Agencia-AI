// Espejo EN MEMORIA de la reserva directa publica (H-42) para pruebas de dominio y de la API. Reproduce las reglas de la migracion 044 (politica
// fail-closed, guardia de precio, retencion sin sobreventa todo-o-nada, idempotencia por llave sin dedupe cruzado, topes por contacto, expiracion,
// pago que confirma, cancelacion con cancellation_policy). Lo que SOLO la base garantiza (RLS, GRANT, triggers, CHECK, concurrencia real) lo cubre
// scripts/verify-hoteles-reservar-publico contra Postgres real; el SAVEPOINT contra una base sin migrar lo cubre el spec con AbortAwareFakeSession.
import { randomUUID } from "node:crypto";
import { ReservasAgenteError, ReservasAgenteUnavailableError } from "../reservas-agente/tipos.ts";
import type { HoldStatus, StayOption, StayOptionsResult } from "../reservas-agente/tipos.ts";
import { isRealCalendarDate, nightsBetweenDates } from "../reservas-agente/validacion.ts";
import { calcularAnticipo, previsionCancelacion } from "./precio.ts";
import type { ReservarDirectoRepository } from "./repository.ts";
import type { CreateWebHoldInput, PagoEstado, RoomNightsDirectas, TerminosCancelacion, WebHoldContext, WebHoldRecord, WebPolicyRecord } from "./tipos.ts";

const OPEN: readonly HoldStatus[] = ["pendiente_aprobacion", "pendiente_pago", "aprobado"];
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/;

interface NightRow { total: number; booked: number; netCents: number }
interface PropertyState {
  organizationId: string;
  name: string;
  policy: Omit<WebPolicyRecord, "disponible" | "terminos">;
  terms: TerminosCancelacion | null;
  roomTypes: Map<string, { name: string; maxOccupancy: number }>;
  nights: Map<string, NightRow>;
}
interface Reservation { id: string; propertyId: string; checkInDate: string; checkOutDate: string; status: string; channel: string | null }
type Stored = WebHoldRecord & { idempotencyKey: string };

const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const half = (x: number): number => Math.floor(x + 0.5);

export class InMemoryReservarDirectoRepository implements ReservarDirectoRepository {
  clock: () => Date = () => new Date();
  /** false = simula la base SIN la migracion 044. */
  migrationApplied = true;
  private readonly props = new Map<string, PropertyState>();
  private readonly holds = new Map<string, Stored>();
  private readonly reservations = new Map<string, Reservation>();

  // ---- siembra (solo pruebas) ----
  seedProperty(propertyId: string, opts: { organizationId: string; name?: string }): void {
    this.props.set(propertyId, {
      organizationId: opts.organizationId, name: opts.name ?? "Hotel de prueba", terms: null, roomTypes: new Map(), nights: new Map(),
      policy: { webEnabled: false, holdsEnabled: false, depositPct: 0, holdTtlMinutes: 120, maxNights: 14, maxGuests: 6, maxAdvanceDays: 365 },
    });
  }
  seedRoomType(propertyId: string, roomTypeId: string, name: string, maxOccupancy: number): void {
    this.prop(propertyId).roomTypes.set(roomTypeId, { name, maxOccupancy });
  }
  /** Inventario y tarifa NETA por noche en [desde, hasta] (ambos inclusive), en centavos. */
  seedInventory(propertyId: string, roomTypeId: string, desde: string, hasta: string, total: number, netCents: number): void {
    for (let d = desde; d <= hasta; d = addDays(d, 1)) this.prop(propertyId).nights.set(`${roomTypeId}|${d}`, { total, booked: 0, netCents });
  }
  setPolicy(propertyId: string, patch: Partial<Omit<WebPolicyRecord, "disponible" | "terminos">>): void {
    Object.assign(this.prop(propertyId).policy, patch);
  }
  setTerms(propertyId: string, terms: TerminosCancelacion | null): void {
    this.prop(propertyId).terms = terms;
  }
  allHolds(): readonly WebHoldRecord[] {
    return [...this.holds.values()];
  }
  allReservations(): readonly Reservation[] {
    return [...this.reservations.values()];
  }
  booked(propertyId: string, roomTypeId: string, date: string): number {
    return this.prop(propertyId).nights.get(`${roomTypeId}|${date}`)?.booked ?? 0;
  }
  /** Prueba de carrera: deja el hold como si hubiera vencido (reloj de la app). */
  forceStatus(holdId: string, patch: Partial<Pick<WebHoldRecord, "status" | "expiresAt">>): void {
    const h = this.holds.get(holdId);
    if (h) this.holds.set(holdId, { ...h, ...patch });
  }

  private prop(propertyId: string): PropertyState {
    const p = this.props.get(propertyId);
    if (!p) throw new ReservasAgenteError("no_encontrada", "property no encontrada");
    return p;
  }
  private guard(operation: string): void {
    if (!this.migrationApplied) throw new ReservasAgenteUnavailableError(`reservar-directo:${operation}`);
  }
  private today(now: Date): string {
    return now.toISOString().slice(0, 10);
  }
  private quote(p: PropertyState, roomTypeId: string, checkIn: string, checkOut: string): { status: StayOption["status"]; net: number; iva: number; ish: number; total: number; nightly: { date: string; cents: number }[] } {
    const nightly: { date: string; cents: number }[] = [];
    for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
      const row = p.nights.get(`${roomTypeId}|${d}`);
      if (!row) return { status: "sin_tarifa", net: 0, iva: 0, ish: 0, total: 0, nightly: [] };
      nightly.push({ date: d, cents: row.netCents });
    }
    const net = nightly.reduce((s, n) => s + n.cents, 0);
    const iva = half(net * 0.16);
    const ish = half(net * 0.03);
    return { status: "ok", net, iva, ish, total: net + iva + ish, nightly };
  }
  private release(h: Stored): void {
    const p = this.prop(h.propertyId);
    for (let d = h.checkInDate; d < h.checkOutDate; d = addDays(d, 1)) {
      const row = p.nights.get(`${h.roomTypeId}|${d}`);
      if (row) row.booked = Math.max(row.booked - 1, 0);
    }
  }
  private expireDue(propertyId: string, now: Date): void {
    for (const h of this.holds.values()) {
      if (h.propertyId === propertyId && OPEN.includes(h.status) && Date.parse(h.expiresAt) <= now.getTime()) {
        this.release(h);
        this.holds.set(h.id, { ...h, status: "expirado" });
      }
    }
  }
  private validateStay(p: PropertyState, checkIn: string, checkOut: string, now: Date): number {
    if (!isRealCalendarDate(checkIn) || !isRealCalendarDate(checkOut) || checkOut <= checkIn) throw new ReservasAgenteError("fechas_invalidas", "fechas_invalidas");
    if (checkIn < this.today(now)) throw new ReservasAgenteError("fecha_pasada", "fecha_pasada");
    if (checkIn > addDays(this.today(now), p.policy.maxAdvanceDays)) throw new ReservasAgenteError("fecha_muy_lejana", "fecha_muy_lejana");
    const nights = nightsBetweenDates(checkIn, checkOut);
    if (nights > p.policy.maxNights) throw new ReservasAgenteError("estadia_muy_larga", "estadia_muy_larga");
    return nights;
  }

  // ---- puerto ----
  async webPolicy(propertyId: string): Promise<WebPolicyRecord> {
    if (!this.migrationApplied) return { disponible: false, webEnabled: false, holdsEnabled: false, depositPct: 0, holdTtlMinutes: 120, maxNights: 14, maxGuests: 6, maxAdvanceDays: 365, terminos: null };
    const p = this.prop(propertyId);
    return { disponible: true, ...p.policy, terminos: p.terms };
  }

  async stayOptions(propertyId: string, checkInDate: string, checkOutDate: string, now: Date = this.clock()): Promise<StayOptionsResult> {
    const nights = nightsBetweenDates(checkInDate, checkOutDate);
    if (!this.migrationApplied) return { disponible: false, checkInDate, checkOutDate, nights, opciones: [] };
    const p = this.prop(propertyId);
    this.validateStay(p, checkInDate, checkOutDate, now);
    this.expireDue(propertyId, now);
    const opciones: StayOption[] = [];
    for (const [rtId, rt] of [...p.roomTypes.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      let free = Number.POSITIVE_INFINITY;
      let rows = 0;
      for (let d = checkInDate; d < checkOutDate; d = addDays(d, 1)) {
        const row = p.nights.get(`${rtId}|${d}`);
        if (row) { rows += 1; free = Math.min(free, row.total - row.booked); }
      }
      if (rows < nights) free = 0;
      free = Math.max(Number.isFinite(free) ? free : 0, 0);
      const q = this.quote(p, rtId, checkInDate, checkOutDate);
      const sinInv = free === 0;
      opciones.push({
        roomTypeId: rtId, roomTypeName: rt.name, maxOccupancy: rt.maxOccupancy, freeRooms: free, status: sinInv ? "sin_inventario" : q.status,
        netCents: sinInv || q.status !== "ok" ? null : q.net, ivaCents: sinInv || q.status !== "ok" ? null : q.iva, ishCents: sinInv || q.status !== "ok" ? null : q.ish,
        totalCents: sinInv || q.status !== "ok" ? null : q.total, nightly: sinInv || q.status !== "ok" ? null : q.nightly,
      });
    }
    return { disponible: true, checkInDate, checkOutDate, nights, opciones };
  }

  async createWebHold(input: CreateWebHoldInput): Promise<WebHoldRecord> {
    this.guard("createWebHold");
    const now = input.now ?? this.clock();
    const p = this.prop(input.propertyId);
    if (!p.policy.holdsEnabled || !p.policy.webEnabled) throw new ReservasAgenteError("web_deshabilitado", "web_deshabilitado: el hotel no habilito la reserva directa en linea");
    const name = input.guestName.trim();
    const email = input.contactEmail.trim().toLowerCase();
    const phone = input.contactPhone.trim();
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 120 || phone.length < 4 || phone.length > 32 || !name || name.length > 120
        || email.length < 5 || email.length > 254 || !EMAIL_RE.test(email)) {
      throw new ReservasAgenteError("parametros_invalidos", "parametros_invalidos");
    }
    if (!input.consentNoticeVersion.trim() || input.consentNoticeVersion.length > 60) throw new ReservasAgenteError("consentimiento_requerido", "consentimiento_requerido");
    const same = [...this.holds.values()].find((h) => h.propertyId === input.propertyId && h.idempotencyKey === input.idempotencyKey);
    if (same) {
      if (same.roomTypeId !== input.roomTypeId || same.checkInDate !== input.checkInDate || same.checkOutDate !== input.checkOutDate || same.contactPhone !== phone) {
        throw new ReservasAgenteError("idempotencia_conflicto", "idempotencia_conflicto");
      }
      return strip(same);
    }
    const nights = this.validateStay(p, input.checkInDate, input.checkOutDate, now);
    const rt = p.roomTypes.get(input.roomTypeId);
    if (!rt) throw new ReservasAgenteError("tipo_habitacion_invalido", "tipo_habitacion_invalido");
    if (input.guests < 1 || input.guests > Math.min(p.policy.maxGuests, rt.maxOccupancy)) throw new ReservasAgenteError("huespedes_invalidos", "huespedes_invalidos");
    this.expireDue(input.propertyId, now);
    const open = [...this.holds.values()].filter((h) => h.propertyId === input.propertyId && OPEN.includes(h.status));
    if (open.length >= 40) throw new ReservasAgenteError("limite_holds_activos", "limite_holds_activos");
    if (open.filter((h) => h.contactPhone === phone || h.guestEmail === email).length >= 2) throw new ReservasAgenteError("limite_holds_contacto", "limite_holds_contacto");
    const q = this.quote(p, input.roomTypeId, input.checkInDate, input.checkOutDate);
    if (q.status !== "ok") throw new ReservasAgenteError("cotizacion_no_disponible", "cotizacion_no_disponible", { status: q.status });
    if (input.expectedTotalCents !== q.total) throw new ReservasAgenteError("precio_cambio", `precio_cambio: el total vigente es ${q.total} centavos`, { totalCents: q.total });
    for (let d = input.checkInDate; d < input.checkOutDate; d = addDays(d, 1)) {
      const row = p.nights.get(`${input.roomTypeId}|${d}`);
      if (!row || row.booked + 1 > row.total) throw new ReservasAgenteError("sin_disponibilidad", "sin_disponibilidad");
    }
    for (let d = input.checkInDate; d < input.checkOutDate; d = addDays(d, 1)) p.nights.get(`${input.roomTypeId}|${d}`)!.booked += 1;
    const deposit = calcularAnticipo(q.total, p.policy.depositPct);
    const hold: Stored = {
      id: randomUUID(), propertyId: input.propertyId, roomTypeId: input.roomTypeId, checkInDate: input.checkInDate, checkOutDate: input.checkOutDate, nights,
      guests: input.guests, channel: "web", guestName: name, contactPhone: phone, currency: "MXN", netCents: q.net, ivaCents: q.iva, ishCents: q.ish, totalCents: q.total,
      mode: deposit > 0 ? "link_pago" : "aprobacion_humana", status: deposit > 0 ? "pendiente_pago" : "pendiente_aprobacion",
      expiresAt: new Date(now.getTime() + p.policy.holdTtlMinutes * 60_000).toISOString(), paymentLinkRef: null, decidedBy: null, decidedAt: null, decisionReason: null,
      reservationId: null, createdAt: now.toISOString(), guestEmail: email, consentNoticeVersion: input.consentNoticeVersion.trim(), depositCents: deposit,
      paymentStatus: deposit > 0 ? "pendiente" : "no_requerido", paymentRef: null, canceledAt: null, cancelPenaltyCents: null, refundCents: null, refundStatus: null,
      idempotencyKey: input.idempotencyKey,
    };
    this.holds.set(hold.id, hold);
    return strip(hold);
  }

  private find(propertyId: string, holdId: string): Stored {
    const h = this.holds.get(holdId);
    if (!h || h.propertyId !== propertyId) throw new ReservasAgenteError("no_encontrada", "reserva no encontrada");
    return h;
  }

  async getWebHold(propertyId: string, holdId: string, now: Date = this.clock()): Promise<WebHoldRecord> {
    this.guard("getWebHold");
    this.prop(propertyId);
    this.expireDue(propertyId, now);
    return strip(this.find(propertyId, holdId));
  }

  async webContext(propertyId: string, holdId: string): Promise<WebHoldContext | null> {
    if (!this.migrationApplied) return null;
    const h = this.holds.get(holdId);
    if (!h || h.propertyId !== propertyId) return null;
    const p = this.prop(propertyId);
    const res = h.reservationId ? this.reservations.get(h.reservationId) : undefined;
    return { roomTypeName: p.roomTypes.get(h.roomTypeId)?.name ?? "", propertyName: p.name, reservationStatus: res?.status ?? null, terminos: p.terms };
  }

  async recordPayment(propertyId: string, holdId: string, status: "capturado" | "fallido" | "pendiente", ref: string | null, now: Date = this.clock()): Promise<WebHoldRecord> {
    this.guard("recordPayment");
    let h = this.find(propertyId, holdId);
    if (h.status === "confirmado") return strip(h);
    if (h.status !== "pendiente_pago") throw new ReservasAgenteError("estado_no_valido", "estado_no_valido");
    if (Date.parse(h.expiresAt) <= now.getTime()) {
      this.expireDue(propertyId, now);
      return strip(this.find(propertyId, holdId));
    }
    if (status !== "capturado") {
      h = { ...h, paymentStatus: status as PagoEstado, paymentRef: ref ?? h.paymentRef };
      this.holds.set(h.id, h);
      return strip(h);
    }
    const res: Reservation = { id: randomUUID(), propertyId, checkInDate: h.checkInDate, checkOutDate: h.checkOutDate, status: "confirmada", channel: "directo_web" };
    this.reservations.set(res.id, res);
    h = { ...h, status: "confirmado", reservationId: res.id, decidedAt: now.toISOString(), paymentStatus: "capturado", paymentRef: ref };
    this.holds.set(h.id, h);
    return strip(h);
  }

  async cancelWebHold(propertyId: string, holdId: string, now: Date = this.clock()): Promise<WebHoldRecord> {
    this.guard("cancelWebHold");
    const p = this.prop(propertyId);
    this.expireDue(propertyId, now);
    let h = this.find(propertyId, holdId);
    if (h.canceledAt !== null || h.status === "cancelado") return strip(h);
    if (OPEN.includes(h.status)) {
      this.release(h);
      h = { ...h, status: "cancelado", canceledAt: now.toISOString(), cancelPenaltyCents: 0, refundCents: 0, refundStatus: "no_aplica" };
      this.holds.set(h.id, h);
      return strip(h);
    }
    if (h.status !== "confirmado") throw new ReservasAgenteError("estado_no_valido", "La reserva ya no admite cancelacion en linea: contacta al hotel.", { motivo: "no_cancelable" });
    const res = h.reservationId ? this.reservations.get(h.reservationId) : undefined;
    if (!res || res.status !== "confirmada") throw new ReservasAgenteError("estado_no_valido", "La reserva ya no admite cancelacion en linea: contacta al hotel.", { motivo: "no_cancelable" });
    const pagado = h.paymentStatus === "capturado" || h.paymentStatus === "manual" ? h.depositCents : 0;
    const prev = previsionCancelacion({ totalCents: h.totalCents, pagadoCents: pagado, checkInDate: h.checkInDate, now, terminos: p.terms });
    res.status = "cancelada";
    this.release(h);
    h = { ...h, canceledAt: now.toISOString(), cancelPenaltyCents: prev.penalidadCents, refundCents: prev.reembolsoCents, refundStatus: prev.reembolsoCents > 0 ? "solicitado" : "no_aplica" };
    this.holds.set(h.id, h);
    return strip(h);
  }

  async markRefunded(propertyId: string, holdId: string, ref: string): Promise<WebHoldRecord> {
    this.guard("markRefunded");
    const h = this.find(propertyId, holdId);
    if (h.refundStatus === "procesado") return strip(h);
    if (h.refundStatus !== "solicitado" || !ref) throw new ReservasAgenteError("estado_no_valido", "estado_no_valido");
    const next: Stored = { ...h, refundStatus: "procesado" };
    this.holds.set(h.id, next);
    return strip(next);
  }

  async roomNightsDirectas(propertyId: string, desde: string, hasta: string): Promise<RoomNightsDirectas> {
    if (!this.migrationApplied) return { disponible: false, desde, hasta, directas: 0, total: 0, porcentaje: null };
    let directas = 0;
    let total = 0;
    for (const r of this.reservations.values()) {
      if (r.propertyId !== propertyId || r.status === "cancelada" || r.status === "cotizada" || r.status === "no_show") continue;
      const lo = r.checkInDate > desde ? r.checkInDate : desde;
      const hi = r.checkOutDate < hasta ? r.checkOutDate : hasta;
      const n = Math.max(0, nightsBetweenDates(lo, hi));
      total += n;
      if (r.channel === "directo_web") directas += n;
    }
    return { disponible: true, desde, hasta, directas, total, porcentaje: total > 0 ? Math.round((directas / total) * 10_000) / 10_000 : null };
  }

  /** Reservas ajenas a la web (recepcion) para el KPI. */
  seedReservation(propertyId: string, checkInDate: string, checkOutDate: string, channel: string | null = null, status = "confirmada"): void {
    const id = randomUUID();
    this.reservations.set(id, { id, propertyId, checkInDate, checkOutDate, status, channel });
  }
}

function strip(h: Stored): WebHoldRecord {
  const { idempotencyKey: _unused, ...rest } = h;
  void _unused;
  return rest;
}
