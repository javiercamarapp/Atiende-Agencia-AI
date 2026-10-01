// Espejo en memoria de PostgresRecepcionRepository (H-28) para tests de ruta, construido SOLO sobre la interfaz publica de
// `HotelesRepository` (misma fuente de verdad de reservas, huespedes y habitaciones que el resto de las pruebas). NO emula
// RLS/GRANT/triggers (eso lo cubre scripts/verify-hoteles-recepcion-ficha contra Postgres real); SI replica las reglas de
// negocio visibles de `change_reservation_room` y la degradacion "base sin migrar" (`migrated: false` => 503).
import type { HotelesRepository } from "../repository.ts";
import type { RecepcionRepository } from "./repository.ts";
import {
  RecepcionConflictError,
  RecepcionInvalidInputError,
  RecepcionNotFoundError,
  RecepcionUnavailableError,
  type RecepcionReservaRow,
  type RecepcionTraslape,
} from "./tipos.ts";

const ACTIVE = new Set(["confirmada", "check_in", "en_estancia"]);

export class InMemoryRecepcionRepository implements RecepcionRepository {
  private readonly identidades = new Map<string, Set<string>>();
  /** `false` simula una base SIN la migracion 038 (cambiarHabitacion lanza 503). */
  migrated: boolean;
  /** `false` simula una base SIN la boveda de identidad (031): `huespedesConIdentidad` devuelve `null`. */
  identidadDisponible: boolean;
  readonly cambios: { reservationId: string; fromRoomId: string | null; toRoomId: string; reason: string | null }[] = [];

  constructor(
    private readonly hoteles: HotelesRepository,
    opts: { readonly migrated?: boolean; readonly identidadDisponible?: boolean } = {},
  ) {
    this.migrated = opts.migrated ?? true;
    this.identidadDisponible = opts.identidadDisponible ?? true;
  }

  seedIdentidad(propertyId: string, guestId: string): void {
    const set = this.identidades.get(propertyId) ?? new Set<string>();
    set.add(guestId);
    this.identidades.set(propertyId, set);
  }

  async listarReservasDelDia(propertyId: string, fecha: string): Promise<readonly RecepcionReservaRow[]> {
    const [reservas, tipos, rooms] = await Promise.all([this.hoteles.listReservations(propertyId), this.hoteles.listRoomTypes(propertyId), this.hoteles.listRooms(propertyId)]);
    const out: RecepcionReservaRow[] = [];
    for (const r of reservas) {
      const relevante =
        r.status === "check_in" ||
        r.status === "en_estancia" ||
        (r.checkInDate === fecha && r.status === "confirmada") ||
        (r.checkOutDate === fecha && (r.status === "check_out" || r.status === "cerrada"));
      if (!relevante) continue;
      const guest = r.guestId ? await this.hoteles.findGuestById(propertyId, r.guestId) : null;
      const room = r.roomId ? rooms.find((x) => x.id === r.roomId) : undefined;
      out.push({
        reservationId: r.id,
        status: r.status,
        checkInDate: r.checkInDate,
        checkOutDate: r.checkOutDate,
        roomTypeId: r.roomTypeId,
        roomTypeName: tipos.find((t) => t.id === r.roomTypeId)?.name ?? null,
        roomId: r.roomId,
        roomCode: room?.code ?? null,
        guestId: r.guestId,
        guestName: guest?.fullName ?? null,
      });
    }
    return out;
  }

  async buscarTraslapeDeHabitacion(propertyId: string, roomId: string, checkInDate: string, checkOutDate: string, excludeReservationId: string): Promise<RecepcionTraslape | null> {
    const reservas = await this.hoteles.listReservations(propertyId);
    const hit = reservas.find(
      (o) => o.roomId === roomId && o.id !== excludeReservationId && ACTIVE.has(o.status) && o.checkInDate < checkOutDate && o.checkOutDate > checkInDate,
    );
    return hit ? { reservationId: hit.id, checkInDate: hit.checkInDate, checkOutDate: hit.checkOutDate } : null;
  }

  async huespedesConIdentidad(propertyId: string, guestIds: readonly string[]): Promise<ReadonlySet<string> | null> {
    if (!this.identidadDisponible) return null;
    const set = this.identidades.get(propertyId) ?? new Set<string>();
    return new Set(guestIds.filter((g) => set.has(g)));
  }

  async cambiarHabitacion(propertyId: string, reservationId: string, newRoomId: string, reason: string | null): Promise<{ readonly fromRoomId: string | null; readonly toRoomId: string }> {
    if (!this.migrated) throw new RecepcionUnavailableError("cambiar la habitacion");
    const reservation = await this.hoteles.findReservation(propertyId, reservationId);
    if (!reservation) throw new RecepcionNotFoundError("Reserva");
    if (!ACTIVE.has(reservation.status)) throw new RecepcionConflictError(`La reserva esta en estado ${reservation.status}.`, "reserva_no_modificable");
    const room = await this.hoteles.findRoom(propertyId, newRoomId);
    if (!room) throw new RecepcionNotFoundError("Habitacion");
    if (room.id === reservation.roomId) throw new RecepcionInvalidInputError("La reserva ya tiene esa habitacion.");
    if (room.roomTypeId !== reservation.roomTypeId) throw new RecepcionInvalidInputError("La habitacion es de otro tipo que la reserva.");
    if (room.status === "fuera_de_servicio" || room.status === "mantenimiento") throw new RecepcionConflictError(`La habitacion ${room.code} esta fuera de servicio.`, "habitacion_no_disponible");
    const inHouse = reservation.status === "check_in" || reservation.status === "en_estancia";
    if (inHouse && (room.status === "sucia" || room.status === "ocupada")) throw new RecepcionConflictError(`La habitacion ${room.code} esta ${room.status}.`, "habitacion_no_lista");
    const traslape = await this.buscarTraslapeDeHabitacion(propertyId, room.id, reservation.checkInDate, reservation.checkOutDate, reservation.id);
    if (traslape) throw new RecepcionConflictError(`La habitacion ${room.code} tiene otra reserva en esas fechas.`, "habitacion_ocupada");
    await this.hoteles.assignRoomToReservation(propertyId, reservationId, room.id);
    this.cambios.push({ reservationId, fromRoomId: reservation.roomId, toRoomId: room.id, reason });
    return { fromRoomId: reservation.roomId, toRoomId: room.id };
  }
}
