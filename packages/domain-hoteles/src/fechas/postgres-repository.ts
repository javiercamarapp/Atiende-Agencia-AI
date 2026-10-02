// Adaptador Postgres del cambio de fechas (H-28) sobre `TenantDbSession` (auth.uid() real). REGLA DURA DE COMPATIBILIDAD CON LA
// BASE SIN MIGRAR: `dbSession` es UNA transaccion por request; un error de Postgres (42883 si la 041 no esta aplicada) la dejaria
// ABORTADA (25P02). La llamada a la funcion corre dentro de `runWithSavepointFallback`: contra la base sin migrar responde
// `CambioFechasUnavailableError` (503) y la sesion queda utilizable. La lectura de inventario solo usa tablas anteriores.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { CambioFechasRepository } from "./repository.ts";
import {
  CambioFechasAccessDeniedError,
  CambioFechasConflictError,
  CambioFechasInvalidInputError,
  CambioFechasNotFoundError,
  CambioFechasUnavailableError,
  type AplicarCambioFechasInput,
  type CambioFechasAplicado,
  type DisponibilidadTipo,
} from "./tipos.ts";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}
function pgMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z_]+:\s*/, "");
}
function pgPrefix(err: unknown): string {
  const raw = err instanceof Error ? err.message : "";
  const m = raw.match(/^([a-z_]+):/);
  return m ? (m[1] as string) : "";
}

/** Traduce un error de Postgres de `change_reservation_dates` a un error de dominio tipado (nunca un 500 crudo). */
export function mapCambioFechasPgError(err: unknown, operation: string): unknown {
  if (
    err instanceof CambioFechasAccessDeniedError ||
    err instanceof CambioFechasConflictError ||
    err instanceof CambioFechasInvalidInputError ||
    err instanceof CambioFechasNotFoundError ||
    err instanceof CambioFechasUnavailableError
  ) {
    return err;
  }
  if (isMigrationPendingError(err)) return new CambioFechasUnavailableError(operation);
  switch (pgCode(err)) {
    case "42501":
      return new CambioFechasAccessDeniedError();
    case "P0002":
      return new CambioFechasNotFoundError("Reserva");
    case "22023":
      return new CambioFechasInvalidInputError(pgMessage(err));
    case "55006":
      return new CambioFechasConflictError("Las fechas de la reserva cambiaron mientras tanto: recarga y vuelve a intentar.", "reserva_modificada");
    case "55000":
      return new CambioFechasConflictError(pgMessage(err), pgPrefix(err) === "noches_posteadas" ? "noches_posteadas" : "reserva_no_modificable");
    case "23P01":
      return new CambioFechasConflictError(pgMessage(err), "habitacion_ocupada");
    case "P0001":
      if (pgPrefix(err) === "sin_disponibilidad") return new CambioFechasConflictError(pgMessage(err), "sin_disponibilidad");
      return err;
    default:
      return err;
  }
}

interface AplicadoRow {
  out_reservation_id: string;
  out_old_check_in: string;
  out_old_check_out: string;
  out_new_check_in: string;
  out_new_check_out: string;
  out_new_total: string;
  out_noches_liberadas: number;
  out_noches_reservadas: number;
  out_penalty_amount: string;
}

export class PostgresCambioFechasRepository implements CambioFechasRepository {
  constructor(private readonly db: TenantDbSession) {}

  async cargarDisponibilidad(propertyId: string, roomTypeId: string, desde: string, hasta: string): Promise<DisponibilidadTipo> {
    const { rows } = await this.db.query<{ date: string; total_rooms: number; booked_rooms: number }>(
      `select date::text as date, total_rooms, booked_rooms from hoteles.availability
        where property_id = $1 and room_type_id = $2 and date >= $3::date and date <= $4::date order by date;`,
      [propertyId, roomTypeId, desde, hasta],
    );
    const cfg = await this.db.query<{ max_overbook_rooms: number; overbooking_occupancy_threshold_pct: string }>(
      `select max_overbook_rooms, overbooking_occupancy_threshold_pct from hoteles.room_type where id = $1 and property_id = $2;`,
      [roomTypeId, propertyId],
    );
    const c = cfg.rows[0];
    return {
      noches: rows.map((r) => ({ date: r.date, totalRooms: r.total_rooms, bookedRooms: r.booked_rooms })),
      overbooking: { maxOverbookRooms: c?.max_overbook_rooms ?? 0, occupancyThresholdPct: c ? Number(c.overbooking_occupancy_threshold_pct) : 95 },
    };
  }

  async aplicarCambio(input: AplicarCambioFechasInput): Promise<CambioFechasAplicado> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<AplicadoRow>(
          `select out_reservation_id, out_old_check_in::text as out_old_check_in, out_old_check_out::text as out_old_check_out,
                out_new_check_in::text as out_new_check_in, out_new_check_out::text as out_new_check_out, out_new_total, out_noches_liberadas,
                out_noches_reservadas, out_penalty_amount
           from hoteles.change_reservation_dates($1::uuid, $2::date, $3::date, $4::date, $5::date, $6::numeric, $7::numeric, $8::text);`,
          [input.reservationId, input.esperadaEntrada, input.esperadaSalida, input.nuevaEntrada, input.nuevaSalida, input.nuevoTotalNeto, input.penalidad, input.motivo],
        );
        const r = rows[0];
        if (!r) throw new CambioFechasNotFoundError("Reserva");
        return {
          reservationId: r.out_reservation_id,
          entradaAnterior: r.out_old_check_in,
          salidaAnterior: r.out_old_check_out,
          entradaNueva: r.out_new_check_in,
          salidaNueva: r.out_new_check_out,
          totalNeto: Number(r.out_new_total),
          nochesLiberadas: r.out_noches_liberadas,
          nochesReservadas: r.out_noches_reservadas,
          penalidad: Number(r.out_penalty_amount),
        };
      },
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapCambioFechasPgError(err, "cambiar las fechas");
      },
    });
  }
}
