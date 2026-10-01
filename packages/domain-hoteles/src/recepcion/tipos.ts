// H-28 -- tipos y reglas puras de la vista de recepcion. Sin I/O: la clasificacion del dia es determinista y se prueba
// sin base de datos. Las fechas son YYYY-MM-DD en la zona horaria de la property (la ruta resuelve "hoy" con
// `hoyFechaNegocio`); aqui nunca se llama a `new Date()`.
import { nightsBetween } from "../quote.ts";
import type { ReservationStatus } from "../reservationStateMachine.ts";

export interface RecepcionReservaRow {
  readonly reservationId: string;
  readonly status: ReservationStatus;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly roomTypeId: string | null;
  readonly roomTypeName: string | null;
  readonly roomId: string | null;
  readonly roomCode: string | null;
  readonly guestId: string | null;
  readonly guestName: string | null;
}

export interface RecepcionMovimiento extends RecepcionReservaRow {
  readonly noches: number;
  /** En casa con fecha de salida anterior a hoy: el huesped sigue registrado y no se hizo el check-out. */
  readonly salidaVencida: boolean;
}

export interface RecepcionDia {
  readonly fecha: string;
  readonly llegadas: readonly RecepcionMovimiento[];
  readonly salidas: readonly RecepcionMovimiento[];
  readonly enCasa: readonly RecepcionMovimiento[];
}

const IN_HOUSE: ReadonlySet<ReservationStatus> = new Set(["check_in", "en_estancia"]);
const ARRIVAL_STATUSES: ReadonlySet<ReservationStatus> = new Set(["confirmada", "check_in", "en_estancia"]);
const DEPARTURE_STATUSES: ReadonlySet<ReservationStatus> = new Set(["check_in", "en_estancia", "check_out", "cerrada"]);

export function isInHouse(status: ReservationStatus): boolean {
  return IN_HOUSE.has(status);
}

function toMovimiento(row: RecepcionReservaRow, fecha: string): RecepcionMovimiento {
  const noches = row.checkOutDate > row.checkInDate ? nightsBetween(row.checkInDate, row.checkOutDate).length : 0;
  return { ...row, noches, salidaVencida: isInHouse(row.status) && row.checkOutDate < fecha };
}

/** Reparte las reservas relevantes del dia en llegadas, salidas y en casa. Una misma reserva puede estar en dos listas
 *  (un huesped que llega y ya hizo check-in hoy esta en llegadas y en casa). Orden estable por habitacion y huesped. */
export function clasificarRecepcion(rows: readonly RecepcionReservaRow[], fecha: string): RecepcionDia {
  const orden = (a: RecepcionMovimiento, b: RecepcionMovimiento) =>
    (a.roomCode ?? "~").localeCompare(b.roomCode ?? "~", "es", { numeric: true }) || (a.guestName ?? "").localeCompare(b.guestName ?? "", "es");
  const todos = rows.map((r) => toMovimiento(r, fecha));
  return {
    fecha,
    llegadas: todos.filter((r) => r.checkInDate === fecha && ARRIVAL_STATUSES.has(r.status)).sort(orden),
    salidas: todos.filter((r) => r.checkOutDate === fecha && DEPARTURE_STATUSES.has(r.status)).sort(orden),
    enCasa: todos.filter((r) => isInHouse(r.status)).sort(orden),
  };
}

export type RecepcionOcupacion = "ocupada" | "llegada" | "libre";

/** Ocupacion de una habitacion para el rack: quien esta en casa ahi, o quien llega hoy y aun no hizo check-in. */
export function ocupacionDeHabitacion(dia: RecepcionDia, roomId: string): { readonly ocupacion: RecepcionOcupacion; readonly reserva: RecepcionMovimiento | null } {
  const enCasa = dia.enCasa.find((r) => r.roomId === roomId);
  if (enCasa) return { ocupacion: "ocupada", reserva: enCasa };
  const llegada = dia.llegadas.find((r) => r.roomId === roomId && r.status === "confirmada");
  if (llegada) return { ocupacion: "llegada", reserva: llegada };
  return { ocupacion: "libre", reserva: null };
}

export interface RecepcionTraslape {
  readonly reservationId: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
}

export class RecepcionNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} no encontrada.`);
    this.name = "RecepcionNotFoundError";
  }
}
export class RecepcionConflictError extends Error {
  constructor(
    message: string,
    readonly code: "habitacion_ocupada" | "habitacion_no_disponible" | "habitacion_no_lista" | "reserva_no_modificable" | "conflicto",
  ) {
    super(message);
    this.name = "RecepcionConflictError";
  }
}
export class RecepcionInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecepcionInvalidInputError";
  }
}
export class RecepcionAccessDeniedError extends Error {
  constructor() {
    super("Tu rol no puede asignar ni cambiar habitaciones.");
    this.name = "RecepcionAccessDeniedError";
  }
}
/** La migracion 038 aun no esta aplicada: la operacion no existe todavia (se responde 503 honesto, nunca 500). */
export class RecepcionUnavailableError extends Error {
  constructor(operation: string) {
    super(`No disponible aun: ${operation} requiere la migracion 038 (recepcion y ficha de huesped).`);
    this.name = "RecepcionUnavailableError";
  }
}
