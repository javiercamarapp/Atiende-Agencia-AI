// Adaptador Postgres de recepcion (H-28) sobre `TenantDbSession` (auth.uid() real por request). REGLA DURA DE
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: `dbSession` es UNA transaccion por request; un error de Postgres (42883 si la
// migracion 038 no esta aplicada) la dejaria ABORTADA (25P02). Toda lectura/escritura que toca objetos posteriores a la
// base minima corre dentro de `runWithSavepointFallback`: las lecturas degradan (sin habitacion asignada / identidad
// "no disponible"), la escritura a `RecepcionUnavailableError` (503). El SQL de cambiarHabitacion lo ejercita
// scripts/verify-hoteles-recepcion-ficha contra Postgres real.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { ReservationStatus } from "../reservationStateMachine.ts";
import type { RecepcionRepository } from "./repository.ts";
import {
  RecepcionAccessDeniedError,
  RecepcionConflictError,
  RecepcionInvalidInputError,
  RecepcionNotFoundError,
  RecepcionUnavailableError,
  type RecepcionReservaRow,
  type RecepcionTraslape,
} from "./tipos.ts";

interface DiaRow {
  id: string;
  status: ReservationStatus;
  check_in_date: string;
  check_out_date: string;
  room_type_id: string | null;
  room_type_name: string | null;
  room_id: string | null;
  room_code: string | null;
  guest_id: string | null;
  guest_name: string | null;
}

function mapDia(r: DiaRow): RecepcionReservaRow {
  return {
    reservationId: r.id,
    status: r.status,
    checkInDate: r.check_in_date,
    checkOutDate: r.check_out_date,
    roomTypeId: r.room_type_id,
    roomTypeName: r.room_type_name,
    roomId: r.room_id,
    roomCode: r.room_code,
    guestId: r.guest_id,
    guestName: r.guest_name,
  };
}

const DIA_WHERE = `r.property_id = $1
  and (r.status in ('check_in', 'en_estancia')
       or (r.check_in_date = $2::date and r.status = 'confirmada')
       or (r.check_out_date = $2::date and r.status in ('check_out', 'cerrada')))`;
const DIA_LIMIT = 1000;

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}
function pgMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Los mensajes de la funcion SQL llevan un prefijo "codigo: detalle"; al usuario solo le sirve el detalle.
  return raw.replace(/^[a-z_]+:\s*/, "");
}

/** Traduce un error de Postgres de `change_reservation_room` a un error de dominio tipado (nunca un 500 crudo). */
export function mapRecepcionPgError(err: unknown, operation: string): unknown {
  if (
    err instanceof RecepcionNotFoundError ||
    err instanceof RecepcionConflictError ||
    err instanceof RecepcionInvalidInputError ||
    err instanceof RecepcionAccessDeniedError ||
    err instanceof RecepcionUnavailableError
  ) {
    return err;
  }
  if (isMigrationPendingError(err)) return new RecepcionUnavailableError(operation);
  const raw = err instanceof Error ? err.message : "";
  switch (pgCode(err)) {
    case "42501":
      return new RecepcionAccessDeniedError();
    case "P0002":
      return new RecepcionNotFoundError("Reserva o habitacion");
    case "22023":
      return new RecepcionInvalidInputError(pgMessage(err));
    case "23P01":
      return new RecepcionConflictError(pgMessage(err), "habitacion_ocupada");
    case "55000":
      return new RecepcionConflictError(
        pgMessage(err),
        raw.startsWith("habitacion_no_lista") ? "habitacion_no_lista" : raw.startsWith("habitacion_no_disponible") ? "habitacion_no_disponible" : "reserva_no_modificable",
      );
    default:
      return err;
  }
}

export class PostgresRecepcionRepository implements RecepcionRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listarReservasDelDia(propertyId: string, fecha: string): Promise<readonly RecepcionReservaRow[]> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<DiaRow>(
          `select r.id, r.status, r.check_in_date::text as check_in_date, r.check_out_date::text as check_out_date,
                  r.room_type_id, rt.name as room_type_name, r.room_id, rm.code as room_code, r.guest_id, g.full_name as guest_name
             from hoteles.reservation r
             left join hoteles.room_type rt on rt.id = r.room_type_id
             left join hoteles.room rm on rm.id = r.room_id
             left join hoteles.guest g on g.id = r.guest_id
            where ${DIA_WHERE}
            order by r.check_in_date, r.created_at
            limit ${DIA_LIMIT};`,
          [propertyId, fecha],
        );
        return rows.map(mapDia);
      },
      isRecoverable: isMigrationPendingError,
      // Base anterior a la columna `reservation.room_id` (migracion 018): sin habitacion fisica asignada.
      fallback: async () => {
        const { rows } = await this.db.query<DiaRow>(
          `select r.id, r.status, r.check_in_date::text as check_in_date, r.check_out_date::text as check_out_date,
                  r.room_type_id, rt.name as room_type_name, null::uuid as room_id, null::text as room_code, r.guest_id, g.full_name as guest_name
             from hoteles.reservation r
             left join hoteles.room_type rt on rt.id = r.room_type_id
             left join hoteles.guest g on g.id = r.guest_id
            where ${DIA_WHERE}
            order by r.check_in_date, r.created_at
            limit ${DIA_LIMIT};`,
          [propertyId, fecha],
        );
        return rows.map(mapDia);
      },
    });
  }

  async buscarTraslapeDeHabitacion(propertyId: string, roomId: string, checkInDate: string, checkOutDate: string, excludeReservationId: string): Promise<RecepcionTraslape | null> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string; check_in_date: string; check_out_date: string }>(
          `select id, check_in_date::text as check_in_date, check_out_date::text as check_out_date
             from hoteles.reservation
            where property_id = $1 and room_id = $2 and id <> $3
              and status in ('confirmada', 'check_in', 'en_estancia')
              and check_in_date < $5::date and check_out_date > $4::date
            order by check_in_date
            limit 1;`,
          [propertyId, roomId, excludeReservationId, checkInDate, checkOutDate],
        );
        const row = rows[0];
        return row ? { reservationId: row.id, checkInDate: row.check_in_date, checkOutDate: row.check_out_date } : null;
      },
      isRecoverable: isMigrationPendingError,
      // Sin la columna room_id no puede haber habitaciones asignadas: nada que traslapar.
      fallback: () => Promise.resolve(null),
    });
  }

  async huespedesConIdentidad(propertyId: string, guestIds: readonly string[]): Promise<ReadonlySet<string> | null> {
    if (guestIds.length === 0) return new Set();
    return runWithSavepointFallback<ReadonlySet<string> | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ guest_id: string }>(
          `select distinct guest_id from hoteles.identity_vault where property_id = $1 and guest_id = any($2::uuid[]) and status = 'activo';`,
          [propertyId, [...guestIds]],
        );
        return new Set(rows.map((r) => r.guest_id));
      },
      isRecoverable: isMigrationPendingError,
      fallback: () => Promise.resolve(null),
    });
  }

  async cambiarHabitacion(_propertyId: string, reservationId: string, newRoomId: string, reason: string | null): Promise<{ readonly fromRoomId: string | null; readonly toRoomId: string }> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ from_room_id: string | null; to_room_id: string }>(
          `select from_room_id, to_room_id from hoteles.change_reservation_room($1::uuid, $2::uuid, $3::text);`,
          [reservationId, newRoomId, reason],
        );
        const row = rows[0];
        if (!row) throw new RecepcionNotFoundError("Reserva");
        return { fromRoomId: row.from_room_id, toRoomId: row.to_room_id };
      },
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapRecepcionPgError(err, "cambiar la habitacion");
      },
    });
  }
}
