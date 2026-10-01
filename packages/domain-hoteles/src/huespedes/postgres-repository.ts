// Adaptador Postgres de la ficha de huesped (H-27) sobre `TenantDbSession` (auth.uid() real por request). REGLA DURA DE
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: `dbSession` es UNA transaccion por request; un error de Postgres (42P01/42883/42703)
// la dejaria ABORTADA (25P02). Toda operacion que toca objetos posteriores a la base minima corre dentro de
// `runWithSavepointFallback`: las lecturas degradan a `null`/lista vacia honesta, las escrituras a 503.
// El SQL de las notas y la bandera ARCO lo ejercita scripts/verify-hoteles-recepcion-ficha contra Postgres real.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { ReservationStatus } from "../reservationStateMachine.ts";
import type { HuespedesRepository } from "./repository.ts";
import {
  HuespedesAccessDeniedError,
  HuespedesArcoRestrictionError,
  HuespedesInvalidInputError,
  HuespedesNotFoundError,
  HuespedesUnavailableError,
  type GuestConsentRow,
  type GuestContactRequestRow,
  type GuestNoteKind,
  type GuestNoteRecord,
  type GuestNotesResult,
  type GuestStayRow,
} from "./tipos.ts";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Traduce un error de Postgres de las notas a un error de dominio tipado. */
export function mapHuespedesPgError(err: unknown, operation: string): unknown {
  if (
    err instanceof HuespedesNotFoundError ||
    err instanceof HuespedesInvalidInputError ||
    err instanceof HuespedesArcoRestrictionError ||
    err instanceof HuespedesAccessDeniedError ||
    err instanceof HuespedesUnavailableError
  ) {
    return err;
  }
  if (isMigrationPendingError(err)) return new HuespedesUnavailableError(operation);
  const message = err instanceof Error ? err.message : "";
  switch (pgCode(err)) {
    case "42501":
      return new HuespedesAccessDeniedError();
    case "23503":
      return new HuespedesNotFoundError("Huesped");
    case "22023":
      return new HuespedesInvalidInputError(message.replace(/^[a-z_]+:\s*/, "") || "La nota contiene datos que no se pueden guardar.");
    case "23514":
      return new HuespedesInvalidInputError("La nota debe tener entre 1 y 500 caracteres y un tipo valido.");
    case "55000":
      return message.startsWith("arco_en_curso") ? new HuespedesArcoRestrictionError() : err;
    default:
      return err;
  }
}

interface NoteRow {
  id: string;
  kind: GuestNoteKind;
  body: string;
  created_by: string | null;
  created_at: string;
}
const NOTE_COLS = "id, kind, body, created_by, created_at::text as created_at";
const mapNote = (r: NoteRow): GuestNoteRecord => ({ id: r.id, kind: r.kind, body: r.body, createdBy: r.created_by, createdAt: r.created_at });

export class PostgresHuespedesRepository implements HuespedesRepository {
  constructor(private readonly db: TenantDbSession) {}

  private read<T>(primary: () => Promise<T>, onMissing: () => T): Promise<T> {
    return runWithSavepointFallback({ session: this.db, primary, isRecoverable: isMigrationPendingError, fallback: () => Promise.resolve(onMissing()) });
  }

  async listarEstancias(propertyId: string, guestId: string, limit: number): Promise<readonly GuestStayRow[]> {
    interface Row {
      id: string;
      status: ReservationStatus;
      check_in_date: string;
      check_out_date: string;
      room_type_name: string | null;
      room_code: string | null;
      total_amount: string;
    }
    const map = (r: Row): GuestStayRow => ({
      reservationId: r.id,
      status: r.status,
      checkInDate: r.check_in_date,
      checkOutDate: r.check_out_date,
      roomTypeName: r.room_type_name,
      roomCode: r.room_code,
      netAmountCents: Math.round(Number(r.total_amount) * 100),
    });
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<Row>(
          `select r.id, r.status, r.check_in_date::text as check_in_date, r.check_out_date::text as check_out_date,
                  rt.name as room_type_name, rm.code as room_code, r.total_amount::text as total_amount
             from hoteles.reservation r
             left join hoteles.room_type rt on rt.id = r.room_type_id
             left join hoteles.room rm on rm.id = r.room_id
            where r.property_id = $1 and r.guest_id = $2
            order by r.check_in_date desc, r.created_at desc
            limit $3;`,
          [propertyId, guestId, limit],
        );
        return rows.map(map);
      },
      isRecoverable: isMigrationPendingError,
      // Base anterior a `reservation.room_id` (018) o a `total_amount` (005): historial sin habitacion fisica.
      fallback: async () => {
        const { rows } = await this.db.query<Row>(
          `select r.id, r.status, r.check_in_date::text as check_in_date, r.check_out_date::text as check_out_date,
                  rt.name as room_type_name, null::text as room_code, '0'::text as total_amount
             from hoteles.reservation r
             left join hoteles.room_type rt on rt.id = r.room_type_id
            where r.property_id = $1 and r.guest_id = $2
            order by r.check_in_date desc, r.created_at desc
            limit $3;`,
          [propertyId, guestId, limit],
        );
        return rows.map(map);
      },
    });
  }

  async listarContactos(propertyId: string, phoneKey: string | null, limit: number): Promise<readonly GuestContactRequestRow[]> {
    if (!phoneKey) return [];
    return this.read(
      async () => {
        const { rows } = await this.db.query<{ id: string; reason: string; source: "voice" | "whatsapp"; message: string | null; created_at: string }>(
          `select id, reason, source, message, created_at::text as created_at
             from hoteles.contacto_no_operativo
            where property_id = $1 and guest_phone is not null
              and right(regexp_replace(guest_phone, '[^0-9]', '', 'g'), 10) = $2
            order by created_at desc
            limit $3;`,
          [propertyId, phoneKey, limit],
        );
        return rows.map((r): GuestContactRequestRow => ({ id: r.id, reason: r.reason, source: r.source, message: r.message, createdAt: r.created_at }));
      },
      () => [],
    );
  }

  async listarConsentimientos(propertyId: string, guestId: string): Promise<readonly GuestConsentRow[] | null> {
    return this.read<readonly GuestConsentRow[] | null>(
      async () => {
        const { rows } = await this.db.query<{ id: string; notice_version: string; accepted_optional: string[]; channel: string; consented_at: string; revoked_at: string | null }>(
          `select id, notice_version, accepted_optional, channel, consented_at::text as consented_at, revoked_at::text as revoked_at
             from hoteles.identity_consent
            where property_id = $1 and guest_id = $2
            order by consented_at desc
            limit 10;`,
          [propertyId, guestId],
        );
        return rows.map((r): GuestConsentRow => ({ id: r.id, noticeVersion: r.notice_version, optionalPurposes: r.accepted_optional, channel: r.channel, consentedAt: r.consented_at, revoked: r.revoked_at !== null }));
      },
      () => null,
    );
  }

  async tieneIdentidadActiva(propertyId: string, guestId: string): Promise<boolean | null> {
    return this.read<boolean | null>(
      async () => {
        const { rows } = await this.db.query<{ n: string }>(`select count(*)::text as n from hoteles.identity_vault where property_id = $1 and guest_id = $2 and status = 'activo';`, [propertyId, guestId]);
        return Number(rows[0]?.n ?? 0) > 0;
      },
      () => null,
    );
  }

  async tieneRestriccionArco(guestId: string): Promise<boolean | null> {
    return this.read<boolean | null>(
      async () => {
        const { rows } = await this.db.query<{ restriction: boolean }>(`select hoteles.guest_has_arco_restriction($1::uuid) as restriction;`, [guestId]);
        return rows[0]?.restriction === true;
      },
      () => null,
    );
  }

  async listarNotas(propertyId: string, guestId: string): Promise<GuestNotesResult> {
    return this.read<GuestNotesResult>(
      async () => {
        const { rows } = await this.db.query<NoteRow>(
          `select ${NOTE_COLS} from hoteles.guest_note where property_id = $1 and guest_id = $2 and archived_at is null order by created_at desc limit 100;`,
          [propertyId, guestId],
        );
        return { available: true, items: rows.map(mapNote) };
      },
      () => ({ available: false, items: [] }),
    );
  }

  async agregarNota(input: { readonly propertyId: string; readonly guestId: string; readonly kind: GuestNoteKind; readonly body: string }): Promise<GuestNoteRecord> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<NoteRow>(
          `insert into hoteles.guest_note (property_id, guest_id, kind, body) values ($1, $2, $3, $4) returning ${NOTE_COLS};`,
          [input.propertyId, input.guestId, input.kind, input.body],
        );
        const row = rows[0];
        if (!row) throw new HuespedesNotFoundError("Huesped");
        return mapNote(row);
      },
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapHuespedesPgError(err, "agregar notas del huesped");
      },
    });
  }

  async archivarNota(propertyId: string, guestId: string, noteId: string): Promise<GuestNoteRecord | null> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<NoteRow>(
          `update hoteles.guest_note set archived_at = now() where id = $1 and property_id = $2 and guest_id = $3 and archived_at is null returning ${NOTE_COLS};`,
          [noteId, propertyId, guestId],
        );
        const row = rows[0];
        return row ? mapNote(row) : null;
      },
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapHuespedesPgError(err, "archivar notas del huesped");
      },
    });
  }
}
