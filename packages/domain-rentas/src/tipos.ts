// Tipos de dominio de calendario — port literal de rentas/packages/domain/src/tipos.ts.
// Sin IO: solo formas de datos, no acceso a base de datos.

/** Fecha calendario en formato `YYYY-MM-DD`, sin hora ni zona — el tipo por defecto
 * del invariante de ocupación. */
export type FechaLocal = string;

/** Capa de ocupación: 'reserva' es la única que participa del EXCLUDE de base de
 * datos; 'bloqueo' agrupa las tres razones de menor precedencia. */
export type Capa = "reserva" | "bloqueo";

/** Precedencia total y determinística:
 * RESERVA_CANAL > BLOQUEO_PROPIETARIO > MANTENIMIENTO > BUFFER_LIMPIEZA. */
export type Razon = "RESERVA_CANAL" | "BLOQUEO_PROPIETARIO" | "MANTENIMIENTO" | "BUFFER_LIMPIEZA";

/** Estados de `rentas.ocupacion`. */
export type EstadoOcupacion = "confirmado" | "provisional" | "cancelado" | "conflicto_pendiente";

export interface RangoFechas {
  /** Inclusivo: check-in / inicio del bloqueo. */
  inicio: FechaLocal;
  /** Exclusivo: check-out / fin del bloqueo — el día del `fin` NO pertenece al rango
   * (modelo `[inicio, fin)`). */
  fin: FechaLocal;
}

export interface Ocupacion {
  id: string;
  unidadId: string;
  rango: RangoFechas;
  capa: Capa;
  razon: Razon;
  estado: EstadoOcupacion;
  /** Decide si esta fila participa del EXCLUDE de base de datos (solo relevante
   * cuando capa='reserva'); también decide, en lectura, si una reserva 'provisional'
   * cuenta como ocupación real. Para capa='bloqueo' es irrelevante para el EXCLUDE
   * (nunca participa) pero SIEMPRE cuenta como ocupación en lectura. */
  bloqueante: boolean;
  canalOrigenId?: string | null;
  externalId?: string | null;
}

export const PRECEDENCIA_RAZON: Record<Razon, number> = {
  RESERVA_CANAL: 4,
  BLOQUEO_PROPIETARIO: 3,
  MANTENIMIENTO: 2,
  BUFFER_LIMPIEZA: 1,
};

export type TipoConflicto = "capa_cruzada" | "overbooking_confirmado";
