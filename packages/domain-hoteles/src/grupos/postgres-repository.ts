// Adaptador Postgres de GRUPOS (H-06) sobre `TenantDbSession` (auth.uid() real por request, RLS real; o sesion de
// sistema para las funciones de sistema). REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: `dbSession` es UNA
// transaccion por request; un error de Postgres (42P01/42883/42703 si la migracion 036 no esta aplicada) la dejaria
// ABORTADA (25P02). Toda operacion corre dentro de `runWithSavepointFallback`: las lecturas degradan a vacio honesto
// (`disponible: false`), las escrituras a `GruposUnavailableError` (503). El SQL es el MISMO que ejercita
// scripts/verify-hoteles-grupos contra Postgres real.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { summarizePickup } from "./calculo.ts";
import type { GruposRepository } from "./repository.ts";
import {
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
  QuoteStatus,
  ReleaseKind,
  ReleasedBlock,
  RoomingEntryRecord,
  RoomingStatus,
} from "./tipos.ts";

const QUOTE_COLS = `id, property_id, group_name, contact_name, contact_email, check_in_date::text as check_in_date, check_out_date::text as check_out_date,
       nights, cutoff_date::text as cutoff_date, valid_until::text as valid_until, discount_bps, gross_cents, total_cents, deposit_required_cents,
       deposit_recorded_cents, status, sent_at::text as sent_at, accepted_at::text as accepted_at, closed_reason, created_at::text as created_at`;
const ROOMING_COLS = `id, block_id, room_type_id, guest_name, check_in_date::text as check_in_date, check_out_date::text as check_out_date, status,
       reservation_id, confirmed_at::text as confirmed_at, created_at::text as created_at`;

type Num = string | number;
interface QuoteRow {
  id: string; property_id: string; group_name: string; contact_name: string | null; contact_email: string | null; check_in_date: string; check_out_date: string;
  nights: number; cutoff_date: string; valid_until: string; discount_bps: number; gross_cents: Num; total_cents: Num; deposit_required_cents: Num;
  deposit_recorded_cents: Num; status: QuoteStatus; sent_at: string | null; accepted_at: string | null; closed_reason: string | null; created_at: string;
}
interface BlockRow {
  id: string; property_id: string; quote_id: string; group_name: string; status: BlockStatus; check_in_date: string; check_out_date: string; cutoff_date: string;
  released_at: string | null; release_kind: ReleaseKind | null; created_at: string; blocked: Num; picked: Num; released: Num;
}
interface NightRow { room_type_id: string; date: string; blocked_rooms: number; picked_up_rooms: number; released_rooms: number }
interface RoomingRow {
  id: string; block_id: string; room_type_id: string; guest_name: string; check_in_date: string; check_out_date: string; status: RoomingStatus;
  reservation_id: string | null; confirmed_at: string | null; created_at: string;
}

function mapQuote(r: QuoteRow): QuoteRecord {
  return {
    id: r.id, propertyId: r.property_id, groupName: r.group_name, contactName: r.contact_name, contactEmail: r.contact_email, checkInDate: r.check_in_date,
    checkOutDate: r.check_out_date, nights: Number(r.nights), cutoffDate: r.cutoff_date, validUntil: r.valid_until, discountBps: Number(r.discount_bps),
    grossCents: Number(r.gross_cents), totalCents: Number(r.total_cents), depositRequiredCents: Number(r.deposit_required_cents),
    depositRecordedCents: Number(r.deposit_recorded_cents), status: r.status, sentAt: r.sent_at, acceptedAt: r.accepted_at, closedReason: r.closed_reason, createdAt: r.created_at,
  };
}
function mapRooming(r: RoomingRow): RoomingEntryRecord {
  return {
    id: r.id, blockId: r.block_id, roomTypeId: r.room_type_id, guestName: r.guest_name, checkInDate: r.check_in_date, checkOutDate: r.check_out_date,
    status: r.status, reservationId: r.reservation_id, confirmedAt: r.confirmed_at, createdAt: r.created_at,
  };
}
function mapNight(r: NightRow): BlockNightRecord {
  return { roomTypeId: r.room_type_id, date: r.date, blockedRooms: Number(r.blocked_rooms), pickedUpRooms: Number(r.picked_up_rooms), releasedRooms: Number(r.released_rooms) };
}
function mapBlock(r: BlockRow): BlockRecord {
  const blocked = Number(r.blocked);
  const picked = Number(r.picked);
  const released = Number(r.released);
  return {
    id: r.id, propertyId: r.property_id, quoteId: r.quote_id, groupName: r.group_name, status: r.status, checkInDate: r.check_in_date, checkOutDate: r.check_out_date,
    cutoffDate: r.cutoff_date, releasedAt: r.released_at, releaseKind: r.release_kind, createdAt: r.created_at,
    pickup: summarizePickup([{ blockedRooms: blocked, pickedUpRooms: picked, releasedRooms: released }]),
  };
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}
function pgMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}
/** Mensajes propios de la migracion 036 son seguros de mostrar; los de CHECK/FK del motor no. */
function safeMessage(err: unknown, fallback: string): string {
  const m = pgMessage(err);
  return m && !/^(new row|insert or update|update or delete|duplicate key|null value)/i.test(m) ? m : fallback;
}

/** Traduce un error de Postgres a un error de dominio tipado (nunca un 500 crudo). */
export function mapGruposPgError(err: unknown, operation: string): unknown {
  if (
    err instanceof GruposNotFoundError || err instanceof GruposConflictError || err instanceof GruposInvalidInputError ||
    err instanceof GruposAccessDeniedError || err instanceof GruposUnavailableError
  ) {
    return err;
  }
  if (isMigrationPendingError(err)) return new GruposUnavailableError(operation);
  switch (pgCode(err)) {
    case "P0001": {
      const m = pgMessage(err);
      if (/^sin_cupo_en_bloque/.test(m)) return new GruposConflictError("Sin cupo en el bloqueo: no quedan cuartos bloqueados para alguna noche del huesped.");
      if (/^sin_disponibilidad/.test(m)) return new GruposConflictError("Sin disponibilidad: no hay cuartos libres suficientes en alguna noche (no se bloqueo nada).");
      return new GruposConflictError("La operacion no procede con el inventario actual.");
    }
    case "23503":
    case "P0002":
      return new GruposNotFoundError();
    case "23505":
      return new GruposConflictError("Ya existe un registro equivalente (por ejemplo, la misma referencia de anticipo).");
    case "55000":
      return new GruposConflictError(safeMessage(err, "La operacion no procede en el estado actual."));
    case "23514":
    case "22023":
      return new GruposInvalidInputError(safeMessage(err, "Datos invalidos (fuera de rango o formato no permitido)."));
    case "42501":
      return new GruposAccessDeniedError(safeMessage(err, "No tienes permiso para esta operacion."));
    default:
      return err;
  }
}

export class PostgresGruposRepository implements GruposRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Escritura protegida por SAVEPOINT: cualquier error recupera la sesion y se traduce. */
  private write<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapGruposPgError(err, operation);
      },
    });
  }

  /** Lectura protegida por SAVEPOINT: solo "migracion pendiente" degrada; el resto se repropaga. */
  private read<T>(operation: string, primary: () => Promise<T>, onMissing: () => T): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary,
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        console.warn(`${operation}: grupos (migracion 036) aun no aplicada -- degradando:`, err instanceof Error ? err.message : err);
        return Promise.resolve(onMissing());
      },
    });
  }

  /** La entidad debe pertenecer a la property de la URL (misma org no basta); la RLS ya oculta lo ajeno. */
  private async assertInProperty(table: "group_quote" | "group_block" | "group_rooming_entry", propertyId: string, id: string, what: string): Promise<void> {
    const { rows } = await this.db.query<{ ok: number }>(`select 1 as ok from hoteles.${table} where id = $1 and property_id = $2;`, [id, propertyId]);
    if (rows.length === 0) throw new GruposNotFoundError(what);
  }

  private async loadQuote(propertyId: string, quoteId: string): Promise<QuoteDetail | null> {
    const q = await this.db.query<QuoteRow>(`select ${QUOTE_COLS} from hoteles.group_quote where id = $1 and property_id = $2;`, [quoteId, propertyId]);
    if (!q.rows[0]) return null;
    const lines = await this.db.query<{ id: string; room_type_id: string; rooms: number; rate_cents: Num }>(
      `select id, room_type_id, rooms, rate_cents from hoteles.group_quote_line where quote_id = $1 order by room_type_id;`, [quoteId]);
    const deps = await this.db.query<{ id: string; amount_cents: Num; reference: string; recorded_by: string | null; recorded_at: string }>(
      `select id, amount_cents, reference, recorded_by, recorded_at::text as recorded_at from hoteles.group_deposit where quote_id = $1 order by recorded_at, id;`, [quoteId]);
    const blk = await this.db.query<{ id: string }>(`select id from hoteles.group_block where quote_id = $1;`, [quoteId]);
    return {
      ...mapQuote(q.rows[0]),
      lines: lines.rows.map((l): QuoteLineRecord => ({ id: l.id, roomTypeId: l.room_type_id, rooms: Number(l.rooms), rateCents: Number(l.rate_cents) })),
      deposits: deps.rows.map((d): DepositRecord => ({ id: d.id, amountCents: Number(d.amount_cents), reference: d.reference, recordedBy: d.recorded_by, recordedAt: d.recorded_at })),
      blockId: blk.rows[0]?.id ?? null,
    };
  }

  private async loadQuoteOrThrow(propertyId: string, quoteId: string): Promise<QuoteDetail> {
    const q = await this.loadQuote(propertyId, quoteId);
    if (!q) throw new GruposNotFoundError("Cotizacion");
    return q;
  }

  private async loadBlock(propertyId: string, blockId: string): Promise<BlockDetail | null> {
    const b = await this.db.query<BlockRow>(
      `select b.id, b.property_id, b.quote_id, q.group_name, b.status, b.check_in_date::text as check_in_date, b.check_out_date::text as check_out_date,
              b.cutoff_date::text as cutoff_date, b.released_at::text as released_at, b.release_kind, b.created_at::text as created_at,
              coalesce(sum(n.blocked_rooms), 0) as blocked, coalesce(sum(n.picked_up_rooms), 0) as picked, coalesce(sum(n.released_rooms), 0) as released
         from hoteles.group_block b
         join hoteles.group_quote q on q.id = b.quote_id
         left join hoteles.group_block_night n on n.block_id = b.id
        where b.id = $1 and b.property_id = $2
        group by b.id, q.group_name;`,
      [blockId, propertyId],
    );
    if (!b.rows[0]) return null;
    const nights = await this.db.query<NightRow>(
      `select room_type_id, date::text as date, blocked_rooms, picked_up_rooms, released_rooms from hoteles.group_block_night where block_id = $1 order by room_type_id, date;`, [blockId]);
    const rooming = await this.db.query<RoomingRow>(`select ${ROOMING_COLS} from hoteles.group_rooming_entry where block_id = $1 order by created_at, id;`, [blockId]);
    return { ...mapBlock(b.rows[0]), nights: nights.rows.map(mapNight), rooming: rooming.rows.map(mapRooming) };
  }

  // ---- cotizaciones ----
  async listQuotes(propertyId: string): Promise<QuoteListResult> {
    return this.read<QuoteListResult>(
      "listQuotes",
      async () => {
        const { rows } = await this.db.query<QuoteRow>(`select ${QUOTE_COLS} from hoteles.group_quote where property_id = $1 order by created_at desc, id limit 200;`, [propertyId]);
        return { disponible: true, cotizaciones: rows.map(mapQuote) };
      },
      () => ({ disponible: false, cotizaciones: [] }),
    );
  }

  async getQuote(propertyId: string, quoteId: string): Promise<QuoteDetail | null> {
    return this.read<QuoteDetail | null>("getQuote", () => this.loadQuote(propertyId, quoteId), () => null);
  }

  async createQuote(input: NewQuoteInput, _actor: GrupoActor): Promise<QuoteDetail> {
    return this.write("createQuote", async () => {
      const lines = input.lines.map((l) => ({ room_type_id: l.roomTypeId, rooms: l.rooms, rate_cents: l.rateCents }));
      const { rows } = await this.db.query<{ id: string }>(
        `select (hoteles.group_quote_create($1, $2, $3, $4, $5::date, $6::date, $7::date, $8::timestamptz, $9, $10, $11::jsonb)).id as id;`,
        [input.propertyId, input.groupName, input.contactName ?? null, input.contactEmail ?? null, input.checkInDate, input.checkOutDate, input.cutoffDate,
          input.validUntil, input.discountBps, input.depositRequiredCents, JSON.stringify(lines)],
      );
      return this.loadQuoteOrThrow(input.propertyId, rows[0]!.id);
    });
  }

  async sendQuote(propertyId: string, quoteId: string, _actor: GrupoActor, now?: Date): Promise<QuoteDetail> {
    return this.write("sendQuote", async () => {
      await this.assertInProperty("group_quote", propertyId, quoteId, "Cotizacion");
      await this.db.query(`select hoteles.group_quote_send($1, $2::timestamptz);`, [quoteId, now ? now.toISOString() : null]);
      return this.loadQuoteOrThrow(propertyId, quoteId);
    });
  }

  async closeQuote(propertyId: string, quoteId: string, outcome: "rechazada" | "cancelada", reason: string, _actor: GrupoActor): Promise<QuoteDetail> {
    return this.write("closeQuote", async () => {
      await this.assertInProperty("group_quote", propertyId, quoteId, "Cotizacion");
      await this.db.query(`select hoteles.group_quote_close($1, $2, $3);`, [quoteId, outcome, reason]);
      return this.loadQuoteOrThrow(propertyId, quoteId);
    });
  }

  async acceptQuote(propertyId: string, quoteId: string, _actor: GrupoActor, now?: Date): Promise<BlockDetail> {
    return this.write("acceptQuote", async () => {
      await this.assertInProperty("group_quote", propertyId, quoteId, "Cotizacion");
      const { rows } = await this.db.query<{ id: string }>(`select (hoteles.group_quote_accept($1, $2::timestamptz)).id as id;`, [quoteId, now ? now.toISOString() : null]);
      const block = await this.loadBlock(propertyId, rows[0]!.id);
      if (!block) throw new GruposNotFoundError("Bloqueo");
      return block;
    });
  }

  async registerDeposit(propertyId: string, quoteId: string, amountCents: number, reference: string, _actor: GrupoActor): Promise<QuoteDetail> {
    return this.write("registerDeposit", async () => {
      await this.assertInProperty("group_quote", propertyId, quoteId, "Cotizacion");
      await this.db.query(`select hoteles.group_deposit_register($1, $2::bigint, $3);`, [quoteId, amountCents, reference]);
      return this.loadQuoteOrThrow(propertyId, quoteId);
    });
  }

  // ---- bloqueos, pickup y rooming ----
  async listBlocks(propertyId: string): Promise<BlockListResult> {
    return this.read<BlockListResult>(
      "listBlocks",
      async () => {
        const { rows } = await this.db.query<BlockRow>(
          `select b.id, b.property_id, b.quote_id, q.group_name, b.status, b.check_in_date::text as check_in_date, b.check_out_date::text as check_out_date,
                  b.cutoff_date::text as cutoff_date, b.released_at::text as released_at, b.release_kind, b.created_at::text as created_at,
                  coalesce(sum(n.blocked_rooms), 0) as blocked, coalesce(sum(n.picked_up_rooms), 0) as picked, coalesce(sum(n.released_rooms), 0) as released
             from hoteles.group_block b
             join hoteles.group_quote q on q.id = b.quote_id
             left join hoteles.group_block_night n on n.block_id = b.id
            where b.property_id = $1
            group by b.id, q.group_name
            order by b.cutoff_date, b.id limit 200;`,
          [propertyId],
        );
        return { disponible: true, bloqueos: rows.map(mapBlock) };
      },
      () => ({ disponible: false, bloqueos: [] }),
    );
  }

  async getBlock(propertyId: string, blockId: string): Promise<BlockDetail | null> {
    return this.read<BlockDetail | null>("getBlock", () => this.loadBlock(propertyId, blockId), () => null);
  }

  async addRoomingEntry(propertyId: string, blockId: string, input: NewRoomingEntryInput, _actor: GrupoActor): Promise<RoomingEntryRecord> {
    return this.write("addRoomingEntry", async () => {
      await this.assertInProperty("group_block", propertyId, blockId, "Bloqueo");
      const { rows } = await this.db.query<{ id: string }>(
        `select (hoteles.group_rooming_add($1, $2, $3, $4::date, $5::date)).id as id;`,
        [blockId, input.roomTypeId, input.guestName, input.checkInDate, input.checkOutDate],
      );
      return this.loadEntry(rows[0]!.id);
    });
  }

  private async loadEntry(entryId: string): Promise<RoomingEntryRecord> {
    const { rows } = await this.db.query<RoomingRow>(`select ${ROOMING_COLS} from hoteles.group_rooming_entry where id = $1;`, [entryId]);
    if (!rows[0]) throw new GruposNotFoundError("Huesped");
    return mapRooming(rows[0]);
  }

  async confirmRoomingEntry(propertyId: string, entryId: string, reservationId: string | null, _actor: GrupoActor, now?: Date): Promise<RoomingEntryRecord> {
    return this.write("confirmRoomingEntry", async () => {
      await this.assertInProperty("group_rooming_entry", propertyId, entryId, "Huesped");
      await this.db.query(`select hoteles.group_rooming_confirm($1, $2, $3::timestamptz);`, [entryId, reservationId, now ? now.toISOString() : null]);
      return this.loadEntry(entryId);
    });
  }

  async cancelRoomingEntry(propertyId: string, entryId: string, _actor: GrupoActor): Promise<RoomingEntryRecord> {
    return this.write("cancelRoomingEntry", async () => {
      await this.assertInProperty("group_rooming_entry", propertyId, entryId, "Huesped");
      await this.db.query(`select hoteles.group_rooming_cancel($1);`, [entryId]);
      return this.loadEntry(entryId);
    });
  }

  async releaseBlock(propertyId: string, blockId: string, _actor: GrupoActor, now?: Date): Promise<number> {
    return this.write("releaseBlock", async () => {
      await this.assertInProperty("group_block", propertyId, blockId, "Bloqueo");
      const { rows } = await this.db.query<{ n: number }>(`select hoteles.group_release_block($1, $2::timestamptz) as n;`, [blockId, now ? now.toISOString() : null]);
      return Number(rows[0]?.n ?? 0);
    });
  }

  async cancelBlock(propertyId: string, blockId: string, reason: string, _actor: GrupoActor): Promise<number> {
    return this.write("cancelBlock", async () => {
      await this.assertInProperty("group_block", propertyId, blockId, "Bloqueo");
      const { rows } = await this.db.query<{ n: number }>(`select hoteles.group_cancel_block($1, $2) as n;`, [blockId, reason]);
      return Number(rows[0]?.n ?? 0);
    });
  }

  // ---- sistema ----
  async releaseDueBlocks(propertyId: string | null, now: Date): Promise<readonly ReleasedBlock[]> {
    return this.write("releaseDueBlocks", async () => {
      const { rows } = await this.db.query<{ block_id: string; released_rooms: number }>(
        `select block_id, released_rooms from hoteles.group_release_due($1, $2::timestamptz);`, [propertyId, now.toISOString()]);
      return rows.map((r) => ({ blockId: r.block_id, releasedRoomNights: Number(r.released_rooms) }));
    });
  }

  async expireQuotes(now: Date): Promise<number> {
    return this.write("expireQuotes", async () => {
      const { rows } = await this.db.query<{ n: number }>(`select hoteles.group_expire_quotes($1::timestamptz) as n;`, [now.toISOString()]);
      return Number(rows[0]?.n ?? 0);
    });
  }
}
