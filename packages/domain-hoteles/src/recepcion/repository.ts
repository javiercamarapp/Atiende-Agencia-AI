// Puerto de persistencia de recepcion (H-28). Separado de `HotelesRepository` (mismo criterio que housekeeping H-04 y la
// boveda H-01) para no ensanchar el puerto grande. Las transiciones de estado de la reserva y el estado de limpieza
// NO viven aqui: se reutilizan `HotelesRepository.transitionReservation` y `HousekeepingRepository`.
import type { RecepcionReservaRow, RecepcionTraslape } from "./tipos.ts";

export interface RecepcionRepository {
  /** Reservas relevantes para `fecha`: en casa (check_in/en_estancia), llegadas confirmadas de hoy y salidas de hoy ya
   *  hechas. Acotado (no recorre toda la historia de la property). */
  listarReservasDelDia(propertyId: string, fecha: string): Promise<readonly RecepcionReservaRow[]>;
  /** Otra reserva ACTIVA (confirmada/check_in/en_estancia) con esa habitacion fisica y fechas traslapadas. */
  buscarTraslapeDeHabitacion(propertyId: string, roomId: string, checkInDate: string, checkOutDate: string, excludeReservationId: string): Promise<RecepcionTraslape | null>;
  /** Huespedes (de la lista) con una identidad activa en la boveda. `null` si la boveda (migracion 031) no esta
   *  disponible: nunca se afirma "sin identidad" cuando no se pudo saber. */
  huespedesConIdentidad(propertyId: string, guestIds: readonly string[]): Promise<ReadonlySet<string> | null>;
  /** Asigna o cambia la habitacion de forma atomica (funcion `hoteles.change_reservation_room`, migracion 038).
   *  La funcion resuelve la property desde la reserva y valida el rol contra ESA property; el llamador ya verifico que la
   *  reserva pertenece a `propertyId`. Lanza `RecepcionUnavailableError` si la migracion no esta aplicada. */
  cambiarHabitacion(propertyId: string, reservationId: string, newRoomId: string, reason: string | null): Promise<{ readonly fromRoomId: string | null; readonly toRoomId: string }>;
}
