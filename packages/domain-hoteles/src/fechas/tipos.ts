// H-28 -- cambio de fechas de una reserva con recotizacion: tipos y errores de dominio. Sin I/O.
import type { OverbookingConfig } from "../overbooking.ts";
import type { ReservationStatus } from "../reservationStateMachine.ts";

export class CambioFechasUnavailableError extends Error {
  constructor(operation: string) {
    super(`No disponible aun: ${operation} requiere la migracion 041 de hoteles.`);
    this.name = "CambioFechasUnavailableError";
  }
}
export class CambioFechasNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} no encontrada.`);
    this.name = "CambioFechasNotFoundError";
  }
}
export class CambioFechasInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CambioFechasInvalidInputError";
  }
}
export class CambioFechasConflictError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "CambioFechasConflictError";
  }
}
export class CambioFechasAccessDeniedError extends Error {
  constructor() {
    super("Tu rol no puede cambiar las fechas de una reserva.");
    this.name = "CambioFechasAccessDeniedError";
  }
}

export interface DisponibilidadNoche {
  readonly date: string;
  readonly totalRooms: number;
  readonly bookedRooms: number;
}

/** Inventario por noche de un tipo de habitacion mas su regla de sobreventa. */
export interface DisponibilidadTipo {
  readonly noches: readonly DisponibilidadNoche[];
  readonly overbooking: OverbookingConfig;
}

export interface DesgloseEstancia {
  readonly entrada: string;
  readonly salida: string;
  readonly noches: number;
  readonly neto: number;
  readonly iva: number;
  readonly ish: number;
  readonly total: number;
}

export interface BloqueoCambioFechas {
  readonly codigo: string;
  readonly mensaje: string;
}

export interface PenalidadAcortamiento {
  readonly monto: number;
  readonly porcentaje: number;
  /** Horas desde ahora hasta la primera noche que se quita (null si no se quita ninguna). */
  readonly horasParaLaNoche: number | null;
}

export interface PrevisualizacionCambioFechas {
  readonly puedeCambiar: boolean;
  readonly bloqueos: readonly BloqueoCambioFechas[];
  readonly estado: ReservationStatus;
  readonly actual: DesgloseEstancia;
  /** null cuando la nueva estadia no se pudo cotizar (ver `bloqueos`). */
  readonly nueva: DesgloseEstancia | null;
  readonly diferenciaTotal: number | null;
  readonly nochesAgregadas: readonly string[];
  readonly nochesQuitadas: readonly string[];
  readonly nochesSinCupo: readonly string[];
  readonly penalidad: PenalidadAcortamiento;
}

export interface AplicarCambioFechasInput {
  /** La funcion SQL resuelve la property desde la reserva y valida el rol contra ESA property; el llamador ya verifico que la
   *  reserva pertenece a `propertyId` (el espejo en memoria si lo usa). */
  readonly propertyId: string;
  readonly reservationId: string;
  readonly esperadaEntrada: string;
  readonly esperadaSalida: string;
  readonly nuevaEntrada: string;
  readonly nuevaSalida: string;
  /** Monto NETO (mismo criterio que `ReservationRecord.totalAmount`). */
  readonly nuevoTotalNeto: number;
  readonly penalidad: number;
  readonly motivo: string | null;
}

export interface CambioFechasAplicado {
  readonly reservationId: string;
  readonly entradaAnterior: string;
  readonly salidaAnterior: string;
  readonly entradaNueva: string;
  readonly salidaNueva: string;
  readonly totalNeto: number;
  readonly nochesLiberadas: number;
  readonly nochesReservadas: number;
  readonly penalidad: number;
}
