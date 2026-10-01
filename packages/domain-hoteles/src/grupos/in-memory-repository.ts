// Repositorio en memoria de GRUPOS (H-06). Espejo de la logica de la migracion 036 para la integracion HTTP rapida
// (apps/api) y las pruebas de dominio; NO sustituye la verificacion contra Postgres real (RLS, GRANT, triggers,
// funciones definer, concurrencia: scripts/verify-hoteles-grupos).
import { randomUUID } from "node:crypto";
import { computeQuoteTotals, eachNight, isCutoffReached, isGroupIsoDate, localDateIn, summarizePickup } from "./calculo.ts";
import type { GruposRepository } from "./repository.ts";
import {
  DEFAULT_GROUP_MAX_DISCOUNT_PCT,
  GRUPOS_DEPOSIT_ROLES,
  GRUPOS_DISCOUNT_OVERRIDE_ROLES,
  GRUPOS_MANAGE_ROLES,
  GRUPOS_ROOMING_ROLES,
  GruposAccessDeniedError,
  GruposConflictError,
  GruposInvalidInputError,
  GruposNotFoundError,
  GruposUnavailableError,
} from "./tipos.ts";
import type {
  GrupoActor,
  BlockDetail,
  BlockListResult,
  BlockNightRecord,
  BlockRecord,
  BlockStatus,
  DepositRecord,
  NewQuoteInput,
  NewRoomingEntryInput,
  QuoteDetail,
  QuoteLineRecord,
  QuoteListResult,
  QuoteRecord,
  ReleaseKind,
  ReleasedBlock,
  RoomingEntryRecord,
} from "./tipos.ts";

export interface InventoryNight {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly date: string;
  readonly totalRooms: number;
  readonly bookedRooms: number;
}

export interface InMemoryGruposOptions {
  /** Simula la base SIN la migracion 036. */
  readonly migrated?: boolean;
  readonly now?: () => Date;
  /** Zona horaria por property (nula/ausente = America/Mexico_City). */
  readonly timeZones?: Readonly<Record<string, string | null>>;
  /** Tipos de habitacion validos por property. */
  readonly roomTypes?: Readonly<Record<string, readonly string[]>>;
  readonly inventory?: readonly InventoryNight[];
  /** Tope de descuento vigente (guardrail 035); por defecto 30. */
  readonly maxDiscountPct?: number;
}

interface QuoteState {
  rec: { -readonly [K in keyof QuoteRecord]: QuoteRecord[K] };
  lines: QuoteLineRecord[];
  deposits: DepositRecord[];
  blockId: string | null;
}
interface BlockState {
  id: string;
  propertyId: string;
  quoteId: string;
  status: BlockStatus;
  checkInDate: string;
  checkOutDate: string;
  cutoffDate: string;
  releasedAt: string | null;
  releaseKind: ReleaseKind | null;
  createdAt: string;
  nights: BlockNightRecord[] & { -readonly [K in keyof BlockNightRecord]: BlockNightRecord[K] }[];
}

type Mut<T> = { -readonly [K in keyof T]: T[K] };

const lockRole = (actor: GrupoActor, roles: readonly string[]): void => {
  if (!actor.role) throw new GruposNotFoundError();
  if (!roles.includes(actor.role)) throw new GruposAccessDeniedError("Sin permiso para esta operacion sobre grupos.");
};

export class InMemoryGruposRepository implements GruposRepository {
  private readonly migrated: boolean;
  private readonly clock: () => Date;
  private readonly timeZones: Readonly<Record<string, string | null>>;
  private readonly roomTypes: Readonly<Record<string, readonly string[]>>;
  private readonly inventory = new Map<string, { total: number; booked: number }>();
  private readonly maxDiscountPct: number;
  private readonly quotes = new Map<string, QuoteState>();
  private readonly blocks = new Map<string, BlockState>();
  private readonly entries = new Map<string, Mut<RoomingEntryRecord> & { propertyId: string }>();

  constructor(opts: InMemoryGruposOptions = {}) {
    this.migrated = opts.migrated ?? true;
    this.clock = opts.now ?? (() => new Date());
    this.timeZones = opts.timeZones ?? {};
    this.roomTypes = opts.roomTypes ?? {};
    this.maxDiscountPct = opts.maxDiscountPct ?? DEFAULT_GROUP_MAX_DISCOUNT_PCT;
    for (const n of opts.inventory ?? []) this.inventory.set(this.invKey(n.propertyId, n.roomTypeId, n.date), { total: n.totalRooms, booked: n.bookedRooms });
  }

  private invKey(p: string, rt: string, d: string): string {
    return `${p}|${rt}|${d}`;
  }
  /** Cuartos retenidos de una noche (para aserciones de pruebas). */
  booked(propertyId: string, roomTypeId: string, date: string): number | null {
    return this.inventory.get(this.invKey(propertyId, roomTypeId, date))?.booked ?? null;
  }
  private need(): void {
    if (!this.migrated) throw new GruposUnavailableError("grupos");
  }
  private tz(propertyId: string): string | null {
    return this.timeZones[propertyId] ?? null;
  }
  private quoteOf(propertyId: string, id: string): QuoteState {
    const q = this.quotes.get(id);
    if (!q || q.rec.propertyId !== propertyId) throw new GruposNotFoundError("Cotizacion");
    return q;
  }
  private blockOf(propertyId: string, id: string): BlockState {
    const b = this.blocks.get(id);
    if (!b || b.propertyId !== propertyId) throw new GruposNotFoundError("Bloqueo");
    return b;
  }
  private entryOf(propertyId: string, id: string): Mut<RoomingEntryRecord> & { propertyId: string } {
    const e = this.entries.get(id);
    if (!e || e.propertyId !== propertyId) throw new GruposNotFoundError("Huesped");
    return e;
  }

  private toQuoteDetail(q: QuoteState): QuoteDetail {
    return { ...q.rec, lines: q.lines.map((l) => ({ ...l })), deposits: q.deposits.map((d) => ({ ...d })), blockId: q.blockId };
  }
  private toBlockRecord(b: BlockState): BlockRecord {
    const q = this.quotes.get(b.quoteId)!;
    return {
      id: b.id, propertyId: b.propertyId, quoteId: b.quoteId, groupName: q.rec.groupName, status: b.status, checkInDate: b.checkInDate, checkOutDate: b.checkOutDate,
      cutoffDate: b.cutoffDate, releasedAt: b.releasedAt, releaseKind: b.releaseKind, createdAt: b.createdAt, pickup: summarizePickup(b.nights),
    };
  }
  private toBlockDetail(b: BlockState): BlockDetail {
    return {
      ...this.toBlockRecord(b),
      nights: b.nights.map((n) => ({ ...n })),
      rooming: [...this.entries.values()].filter((e) => e.blockId === b.id).map(({ propertyId: _p, ...e }) => ({ ...e })),
    };
  }

  // ---- cotizaciones ----
  async listQuotes(propertyId: string): Promise<QuoteListResult> {
    if (!this.migrated) return { disponible: false, cotizaciones: [] };
    return { disponible: true, cotizaciones: [...this.quotes.values()].filter((q) => q.rec.propertyId === propertyId).map((q) => ({ ...q.rec })).reverse() };
  }

  async getQuote(propertyId: string, quoteId: string): Promise<QuoteDetail | null> {
    if (!this.migrated) return null;
    const q = this.quotes.get(quoteId);
    return q && q.rec.propertyId === propertyId ? this.toQuoteDetail(q) : null;
  }

  async createQuote(input: NewQuoteInput, actor: GrupoActor): Promise<QuoteDetail> {
    this.need();
    lockRole(actor, GRUPOS_MANAGE_ROLES);
    const now = this.clock();
    const today = localDateIn(now, this.tz(input.propertyId));
    if (!isGroupIsoDate(input.cutoffDate) || !isGroupIsoDate(input.checkInDate) || !isGroupIsoDate(input.checkOutDate)) throw new GruposInvalidInputError("Fechas invalidas (YYYY-MM-DD).");
    const totals = computeQuoteTotals(input.lines, input.checkInDate, input.checkOutDate, input.discountBps);
    if (input.checkInDate < today) throw new GruposInvalidInputError("La llegada del grupo esta en el pasado.");
    if (input.cutoffDate > input.checkInDate) throw new GruposInvalidInputError("La fecha de liberacion no puede ser posterior a la llegada.");
    if (input.cutoffDate < today) throw new GruposInvalidInputError("La fecha de liberacion esta en el pasado.");
    const validUntil = new Date(input.validUntil);
    if (Number.isNaN(validUntil.getTime()) || validUntil.getTime() <= now.getTime()) throw new GruposInvalidInputError("La vigencia de la propuesta ya paso.");
    if (input.discountBps > this.maxDiscountPct * 100 && !(GRUPOS_DISCOUNT_OVERRIDE_ROLES as readonly string[]).includes(actor.role ?? "")) {
      throw new GruposAccessDeniedError("El descuento excede el tope vigente: lo autoriza owner/gm.");
    }
    const valid = this.roomTypes[input.propertyId];
    for (const l of input.lines) if (valid && !valid.includes(l.roomTypeId)) throw new GruposInvalidInputError("El tipo de habitacion no pertenece a la property.");
    if (!Number.isInteger(input.depositRequiredCents) || input.depositRequiredCents < 0 || input.depositRequiredCents > totals.totalCents) {
      throw new GruposInvalidInputError("El anticipo requerido no puede exceder el total de la cotizacion.");
    }
    const name = input.groupName.trim();
    if (name.length < 2 || name.length > 120) throw new GruposInvalidInputError("El nombre del grupo debe tener de 2 a 120 caracteres.");
    const id = randomUUID();
    const state: QuoteState = {
      rec: {
        id, propertyId: input.propertyId, groupName: name, contactName: input.contactName?.trim() || null, contactEmail: input.contactEmail?.trim() || null,
        checkInDate: input.checkInDate, checkOutDate: input.checkOutDate, nights: totals.nights, cutoffDate: input.cutoffDate, validUntil: validUntil.toISOString(),
        discountBps: input.discountBps, grossCents: totals.grossCents, totalCents: totals.totalCents, depositRequiredCents: input.depositRequiredCents,
        depositRecordedCents: 0, status: "borrador", sentAt: null, acceptedAt: null, closedReason: null, createdAt: now.toISOString(),
      },
      lines: input.lines.map((l) => ({ id: randomUUID(), roomTypeId: l.roomTypeId, rooms: l.rooms, rateCents: l.rateCents })),
      deposits: [],
      blockId: null,
    };
    this.quotes.set(id, state);
    return this.toQuoteDetail(state);
  }

  async sendQuote(propertyId: string, quoteId: string, actor: GrupoActor, now?: Date): Promise<QuoteDetail> {
    this.need();
    const q = this.quoteOf(propertyId, quoteId);
    lockRole(actor, GRUPOS_MANAGE_ROLES);
    if (q.rec.status !== "borrador") throw new GruposConflictError(`Solo una cotizacion en borrador se envia (estado: ${q.rec.status}).`);
    const t = now ?? this.clock();
    if (new Date(q.rec.validUntil).getTime() <= t.getTime()) throw new GruposConflictError("La vigencia de la propuesta ya paso.");
    q.rec.status = "enviada";
    q.rec.sentAt = t.toISOString();
    return this.toQuoteDetail(q);
  }

  async closeQuote(propertyId: string, quoteId: string, outcome: "rechazada" | "cancelada", reason: string, actor: GrupoActor): Promise<QuoteDetail> {
    this.need();
    const q = this.quoteOf(propertyId, quoteId);
    lockRole(actor, GRUPOS_MANAGE_ROLES);
    const r = reason.trim();
    if (r.length < 5 || r.length > 300) throw new GruposInvalidInputError("El motivo es obligatorio (5 a 300 caracteres).");
    if ((q.rec.status !== "borrador" && q.rec.status !== "enviada") || (outcome === "rechazada" && q.rec.status !== "enviada")) {
      throw new GruposConflictError(`La cotizacion en estado ${q.rec.status} no admite ${outcome}.`);
    }
    q.rec.status = outcome;
    q.rec.closedReason = r;
    return this.toQuoteDetail(q);
  }

  async acceptQuote(propertyId: string, quoteId: string, actor: GrupoActor, now?: Date): Promise<BlockDetail> {
    this.need();
    const q = this.quoteOf(propertyId, quoteId);
    lockRole(actor, GRUPOS_MANAGE_ROLES);
    const t = now ?? this.clock();
    if (q.rec.status !== "enviada") throw new GruposConflictError(`Solo una cotizacion enviada se acepta (estado: ${q.rec.status}).`);
    if (new Date(q.rec.validUntil).getTime() <= t.getTime()) throw new GruposConflictError("La propuesta vencio: la vigencia ya paso.");
    if (isCutoffReached(q.rec.cutoffDate, t, this.tz(propertyId))) throw new GruposConflictError("Ya paso la fecha de liberacion del bloqueo.");
    // Todo o nada: se valida CADA noche antes de retener alguna (la base lo hace con una sola transaccion).
    const holds: { key: string; rooms: number }[] = [];
    const nights: BlockNightRecord[] = [];
    const sorted = [...q.lines].sort((a, b) => (a.roomTypeId < b.roomTypeId ? -1 : a.roomTypeId > b.roomTypeId ? 1 : 0));
    for (const line of sorted) {
      for (const date of eachNight(q.rec.checkInDate, q.rec.checkOutDate)) {
        const key = this.invKey(propertyId, line.roomTypeId, date);
        const inv = this.inventory.get(key);
        if (!inv || inv.booked + line.rooms > inv.total) throw new GruposConflictError("Sin disponibilidad: no hay cuartos libres suficientes en alguna noche (no se bloqueo nada).");
        holds.push({ key, rooms: line.rooms });
        nights.push({ roomTypeId: line.roomTypeId, date, blockedRooms: line.rooms, pickedUpRooms: 0, releasedRooms: 0 });
      }
    }
    for (const h of holds) this.inventory.get(h.key)!.booked += h.rooms;
    const block: BlockState = {
      id: randomUUID(), propertyId, quoteId, status: "activo", checkInDate: q.rec.checkInDate, checkOutDate: q.rec.checkOutDate, cutoffDate: q.rec.cutoffDate,
      releasedAt: null, releaseKind: null, createdAt: t.toISOString(), nights: nights as BlockState["nights"],
    };
    this.blocks.set(block.id, block);
    q.rec.status = "aceptada";
    q.rec.acceptedAt = t.toISOString();
    q.blockId = block.id;
    return this.toBlockDetail(block);
  }

  async registerDeposit(propertyId: string, quoteId: string, amountCents: number, reference: string, actor: GrupoActor): Promise<QuoteDetail> {
    this.need();
    const q = this.quoteOf(propertyId, quoteId);
    lockRole(actor, GRUPOS_DEPOSIT_ROLES);
    if (q.rec.status !== "aceptada") throw new GruposConflictError(`Solo se registran anticipos de una cotizacion aceptada (estado: ${q.rec.status}).`);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new GruposInvalidInputError("El monto del anticipo debe ser un entero de centavos mayor a cero.");
    const ref = reference.trim();
    if (ref.length < 3 || ref.length > 120) throw new GruposInvalidInputError("La referencia del anticipo es obligatoria (3 a 120 caracteres).");
    if (q.rec.depositRecordedCents + amountCents > q.rec.totalCents) throw new GruposInvalidInputError("El anticipo acumulado excederia el total de la cotizacion.");
    if (q.deposits.some((d) => d.reference === ref)) throw new GruposConflictError("Ya existe un registro equivalente (la misma referencia de anticipo).");
    q.deposits.push({ id: randomUUID(), amountCents, reference: ref, recordedBy: actor.userId, recordedAt: this.clock().toISOString() });
    q.rec.depositRecordedCents += amountCents;
    return this.toQuoteDetail(q);
  }

  // ---- bloqueos, pickup y rooming ----
  async listBlocks(propertyId: string): Promise<BlockListResult> {
    if (!this.migrated) return { disponible: false, bloqueos: [] };
    return {
      disponible: true,
      bloqueos: [...this.blocks.values()].filter((b) => b.propertyId === propertyId).sort((a, b) => a.cutoffDate.localeCompare(b.cutoffDate)).map((b) => this.toBlockRecord(b)),
    };
  }

  async getBlock(propertyId: string, blockId: string): Promise<BlockDetail | null> {
    if (!this.migrated) return null;
    const b = this.blocks.get(blockId);
    return b && b.propertyId === propertyId ? this.toBlockDetail(b) : null;
  }

  async addRoomingEntry(propertyId: string, blockId: string, input: NewRoomingEntryInput, actor: GrupoActor): Promise<RoomingEntryRecord> {
    this.need();
    const b = this.blockOf(propertyId, blockId);
    lockRole(actor, GRUPOS_ROOMING_ROLES);
    if (b.status !== "activo") throw new GruposConflictError(`El bloqueo esta ${b.status}: no admite mas huespedes.`);
    if (!isGroupIsoDate(input.checkInDate) || !isGroupIsoDate(input.checkOutDate) || input.checkOutDate <= input.checkInDate || input.checkInDate < b.checkInDate || input.checkOutDate > b.checkOutDate) {
      throw new GruposInvalidInputError("Las fechas del huesped deben caer dentro de las del bloqueo.");
    }
    const name = input.guestName.trim();
    if (name.length < 2 || name.length > 120) throw new GruposInvalidInputError("guestName: 2 a 120 caracteres.");
    if (!b.nights.some((n) => n.roomTypeId === input.roomTypeId)) throw new GruposInvalidInputError("El tipo de habitacion no esta en el bloqueo.");
    const entry = {
      id: randomUUID(), propertyId, blockId, roomTypeId: input.roomTypeId, guestName: name, checkInDate: input.checkInDate, checkOutDate: input.checkOutDate,
      status: "pendiente" as const, reservationId: null, confirmedAt: null, createdAt: this.clock().toISOString(),
    };
    this.entries.set(entry.id, entry);
    const { propertyId: _p, ...rec } = entry;
    return rec;
  }

  async confirmRoomingEntry(propertyId: string, entryId: string, reservationId: string | null, actor: GrupoActor, now?: Date): Promise<RoomingEntryRecord> {
    this.need();
    const e = this.entryOf(propertyId, entryId);
    const b = this.blockOf(propertyId, e.blockId);
    lockRole(actor, GRUPOS_ROOMING_ROLES);
    const t = now ?? this.clock();
    if (e.status !== "pendiente") throw new GruposConflictError(`Solo un huesped pendiente se confirma (estado: ${e.status}).`);
    if (b.status !== "activo") throw new GruposConflictError(`El bloqueo esta ${b.status}: ya no admite pickup.`);
    if (isCutoffReached(b.cutoffDate, t, this.tz(propertyId))) throw new GruposConflictError("El pickup cerro en la fecha de liberacion.");
    const rows = eachNight(e.checkInDate, e.checkOutDate).map((date) => b.nights.find((n) => n.roomTypeId === e.roomTypeId && n.date === date));
    if (rows.some((n) => !n || n.pickedUpRooms + n.releasedRooms >= n.blockedRooms)) throw new GruposConflictError("Sin cupo en el bloqueo: no quedan cuartos bloqueados para alguna noche del huesped.");
    for (const n of rows as Mut<BlockNightRecord>[]) n.pickedUpRooms += 1;
    e.status = "confirmada";
    e.confirmedAt = t.toISOString();
    e.reservationId = reservationId;
    const { propertyId: _p, ...rec } = e;
    return { ...rec };
  }

  async cancelRoomingEntry(propertyId: string, entryId: string, actor: GrupoActor): Promise<RoomingEntryRecord> {
    this.need();
    const e = this.entryOf(propertyId, entryId);
    const b = this.blockOf(propertyId, e.blockId);
    lockRole(actor, GRUPOS_ROOMING_ROLES);
    if (e.status === "cancelada") throw new GruposConflictError("El huesped ya estaba cancelado.");
    if (e.status === "confirmada") {
      for (const date of eachNight(e.checkInDate, e.checkOutDate)) {
        const n = b.nights.find((x) => x.roomTypeId === e.roomTypeId && x.date === date) as Mut<BlockNightRecord> | undefined;
        if (!n || n.pickedUpRooms <= 0) continue;
        n.pickedUpRooms -= 1;
        if (b.status === "liberado") {
          n.releasedRooms += 1;
          const inv = this.inventory.get(this.invKey(propertyId, e.roomTypeId, date));
          if (inv) inv.booked = Math.max(inv.booked - 1, 0);
        }
      }
    }
    e.status = "cancelada";
    const { propertyId: _p, ...rec } = e;
    return { ...rec };
  }

  private releaseCore(b: BlockState, kind: ReleaseKind, at: Date): number {
    if (b.status !== "activo") return 0;
    let total = 0;
    for (const n of b.nights as Mut<BlockNightRecord>[]) {
      const libres = n.blockedRooms - n.pickedUpRooms - n.releasedRooms;
      if (libres <= 0) continue;
      const inv = this.inventory.get(this.invKey(b.propertyId, n.roomTypeId, n.date));
      if (inv) inv.booked = Math.max(inv.booked - libres, 0);
      n.releasedRooms += libres;
      total += libres;
    }
    b.status = kind === "cancelacion" ? "cancelado" : "liberado";
    b.releasedAt = at.toISOString();
    b.releaseKind = kind;
    return total;
  }

  async releaseBlock(propertyId: string, blockId: string, actor: GrupoActor, now?: Date): Promise<number> {
    this.need();
    const b = this.blockOf(propertyId, blockId);
    lockRole(actor, GRUPOS_MANAGE_ROLES);
    if (b.status !== "activo") throw new GruposConflictError(`El bloqueo ya esta ${b.status}.`);
    return this.releaseCore(b, "manual", now ?? this.clock());
  }

  async cancelBlock(propertyId: string, blockId: string, reason: string, actor: GrupoActor): Promise<number> {
    this.need();
    const b = this.blockOf(propertyId, blockId);
    lockRole(actor, GRUPOS_MANAGE_ROLES);
    const r = reason.trim();
    if (r.length < 5 || r.length > 300) throw new GruposInvalidInputError("El motivo es obligatorio (5 a 300 caracteres).");
    if (b.status !== "activo") throw new GruposConflictError(`El bloqueo ya esta ${b.status}.`);
    if (b.nights.some((n) => n.pickedUpRooms > 0)) throw new GruposConflictError("El bloqueo tiene huespedes confirmados: cancelalos antes o libera el bloqueo.");
    for (const e of this.entries.values()) if (e.blockId === b.id && e.status === "pendiente") e.status = "cancelada";
    return this.releaseCore(b, "cancelacion", this.clock());
  }

  // ---- sistema ----
  async releaseDueBlocks(propertyId: string | null, now: Date): Promise<readonly ReleasedBlock[]> {
    this.need();
    const out: ReleasedBlock[] = [];
    const due = [...this.blocks.values()]
      .filter((b) => b.status === "activo" && (propertyId === null || b.propertyId === propertyId) && isCutoffReached(b.cutoffDate, now, this.tz(b.propertyId)))
      .sort((a, b) => a.cutoffDate.localeCompare(b.cutoffDate));
    for (const b of due) out.push({ blockId: b.id, releasedRoomNights: this.releaseCore(b, "cutoff", now) });
    return out;
  }

  async expireQuotes(now: Date): Promise<number> {
    this.need();
    let n = 0;
    for (const q of this.quotes.values()) {
      if ((q.rec.status === "borrador" || q.rec.status === "enviada") && new Date(q.rec.validUntil).getTime() <= now.getTime()) {
        q.rec.status = "vencida";
        n += 1;
      }
    }
    return n;
  }
}
