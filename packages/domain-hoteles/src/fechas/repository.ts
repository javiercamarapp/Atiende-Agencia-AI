// Puerto de persistencia del cambio de fechas (H-28). Separado de `HotelesRepository` (mismo criterio que recepcion/housekeeping)
// para no ensanchar el puerto grande. La lectura de reservas, tarifas, impuestos y politica se reutiliza de `HotelesRepository`.
import type { AplicarCambioFechasInput, CambioFechasAplicado, DisponibilidadTipo } from "./tipos.ts";

export interface CambioFechasRepository {
  /** Inventario por noche de un tipo de habitacion en [desde, hasta] (ambas inclusive) y su regla de sobreventa. Solo lee tablas
   *  anteriores a la migracion 041: la previsualizacion funciona contra la base sin migrar. */
  cargarDisponibilidad(propertyId: string, roomTypeId: string, desde: string, hasta: string): Promise<DisponibilidadTipo>;
  /** Aplica el cambio de forma ATOMICA (funcion `hoteles.change_reservation_dates`, migracion 041): bloquea la reserva, revisa
   *  noches posteadas y traslape de habitacion, libera/reserva inventario por noche y deja bitacora. Lanza
   *  `CambioFechasUnavailableError` si la migracion no esta aplicada. */
  aplicarCambio(input: AplicarCambioFechasInput): Promise<CambioFechasAplicado>;
}
