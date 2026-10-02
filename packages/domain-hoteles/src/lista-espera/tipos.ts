// H-12 -- lista de espera de hoteles: tipos y errores de dominio. Sin I/O.
export const ESTADOS_LISTA_ESPERA = ["activa", "ofrecida", "aceptada", "expirada", "cancelada"] as const;
export type EstadoListaEspera = (typeof ESTADOS_LISTA_ESPERA)[number];

export function esEstadoListaEspera(value: unknown): value is EstadoListaEspera {
  return typeof value === "string" && (ESTADOS_LISTA_ESPERA as readonly string[]).includes(value);
}

export class ListaEsperaUnavailableError extends Error {
  constructor(operation: string) {
    super(`No disponible aun: ${operation} requiere la migracion 041 de hoteles.`);
    this.name = "ListaEsperaUnavailableError";
  }
}
export class ListaEsperaNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} no encontrada.`);
    this.name = "ListaEsperaNotFoundError";
  }
}
export class ListaEsperaInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListaEsperaInvalidInputError";
  }
}
export class ListaEsperaConflictError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ListaEsperaConflictError";
  }
}
export class ListaEsperaAccessDeniedError extends Error {
  constructor() {
    super("Tu rol no puede administrar la lista de espera.");
    this.name = "ListaEsperaAccessDeniedError";
  }
}

export interface EntradaListaEspera {
  readonly id: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly huespedes: number;
  readonly nombre: string;
  readonly telefono: string | null;
  readonly email: string | null;
  readonly notas: string | null;
  readonly estado: EstadoListaEspera;
  readonly ofrecidaEn: string | null;
  readonly ofertaVenceEn: string | null;
  readonly reservaId: string | null;
  readonly creadaEn: string;
}

export interface NuevaEntradaListaEspera {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly huespedes: number;
  readonly nombre: string;
  readonly telefono: string | null;
  readonly email: string | null;
  readonly notas: string | null;
}

export interface ListadoListaEspera {
  /** `false` cuando la base aun no tiene la migracion 041: lista vacia + estado honesto. */
  readonly disponible: boolean;
  readonly entradas: readonly EntradaListaEspera[];
}
