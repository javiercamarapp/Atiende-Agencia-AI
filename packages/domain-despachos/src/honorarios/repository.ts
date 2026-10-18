// D-32 -- puerto del repositorio de honorarios (igualas y prefacturas). Cada metodo corresponde a UNA funcion de la migracion 023.
import type { CancelacionDatos, Desglose, IgualaInput, IgualaRecord, PrefacturaRecord, TimbreRegistrado } from "./types.ts";

export class HonorariosNoDisponiblesError extends Error {
  constructor() {
    super("La facturación de honorarios todavía no está disponible en esta base (migración pendiente).");
    this.name = "HonorariosNoDisponiblesError";
  }
}
export class HonorariosSinPermisoError extends Error {
  constructor(message = "No tienes permiso para esta operación sobre los honorarios.") {
    super(message);
    this.name = "HonorariosSinPermisoError";
  }
}
export class HonorariosDatosInvalidosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HonorariosDatosInvalidosError";
  }
}
export class HonorariosNoEncontradoError extends Error {
  constructor(message = "No se encontró el registro.") {
    super(message);
    this.name = "HonorariosNoEncontradoError";
  }
}
/** La operacion no es valida en el estado actual (SQLSTATE 55000): ya aprobada, ya cancelada, con timbrado en curso... */
export class HonorariosEstadoInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HonorariosEstadoInvalidoError";
  }
}
export class HonorariosTopeExcedidoError extends Error {
  constructor(message = "Alcanzaste el máximo de igualas de este cliente.") {
    super(message);
    this.name = "HonorariosTopeExcedidoError";
  }
}
/** El UUID fiscal ya esta ligado a otra prefactura de la organizacion (SQLSTATE 23505). */
export class HonorariosDuplicadoError extends Error {
  constructor(message = "Ese folio fiscal ya está ligado a otra prefactura.") {
    super(message);
    this.name = "HonorariosDuplicadoError";
  }
}

export interface LecturaIgualas {
  /** `no_disponible`: la base todavia no tiene la migracion 023 (lista vacia, nunca un error). */
  readonly estado: "disponible" | "no_disponible";
  readonly igualas: readonly IgualaRecord[];
}
export interface LecturaPrefacturas {
  readonly estado: "disponible" | "no_disponible";
  readonly prefacturas: readonly PrefacturaRecord[];
}

export interface HonorariosRepository {
  listarIgualas(propertyId: string): Promise<LecturaIgualas>;
  /** Crea (id null) o actualiza una iguala. Devuelve su id. */
  guardarIguala(propertyId: string, id: string | null, input: IgualaInput): Promise<string>;
  /** Solo si no tiene prefacturas (55000 -> `HonorariosEstadoInvalidoError`): si ya facturo, se desactiva. */
  eliminarIguala(propertyId: string, id: string): Promise<void>;
  /** Prefacturas del cliente; `periodo` (AAAA-MM) acota a un mes. */
  listarPrefacturas(propertyId: string, periodo: string | null): Promise<LecturaPrefacturas>;
  obtenerPrefactura(propertyId: string, id: string): Promise<PrefacturaRecord | null>;
  /** Idempotente: devuelve el id de la prefactura nueva, o null si ya existia (iguala, periodo). El receptor lo toma la base de la ficha del cliente. */
  generarPrefactura(propertyId: string, igualaId: string, periodo: string, desglose: Desglose): Promise<string | null>;
  aprobar(propertyId: string, id: string): Promise<void>;
  /** Compare-and-set ANTES de llamar al PAC: true = esta llamada gano la reserva; false = otra la tiene o el estado no lo permite. */
  reservarTimbrado(propertyId: string, id: string, expiraSegundos: number): Promise<boolean>;
  registrarTimbre(propertyId: string, id: string, timbre: TimbreRegistrado): Promise<void>;
  registrarFallo(propertyId: string, id: string, codigo: string): Promise<void>;
  cancelar(propertyId: string, id: string, datos: CancelacionDatos): Promise<void>;
}
