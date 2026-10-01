// D-24 -- tipos y puerto del libro contable persistido (migración 020): catálogo de cuentas por cliente, pólizas con folio y
// partidas, balanza derivada. Todo en CENTAVOS ENTEROS (number entero seguro): ningún monto del libro pasa por flotantes.
import type { NaturalezaCuenta } from "../contabilidad-electronica/types.ts";

export type TipoPoliza = "ingreso" | "egreso" | "diario";
export const TIPOS_POLIZA: readonly TipoPoliza[] = ["ingreso", "egreso", "diario"];
export type OrigenPoliza = "manual" | "cfdi" | "reversa";

export interface CuentaLibro {
  readonly codigo: string;
  readonly descripcion: string;
  readonly naturaleza: NaturalezaCuenta;
}

export interface MovimientoPolizaInput {
  readonly cuenta: string;
  readonly concepto: string;
  readonly debeCentavos: number;
  readonly haberCentavos: number;
}

export interface PolizaInput {
  readonly tipo: TipoPoliza;
  /** YYYY-MM-DD. */
  readonly fecha: string;
  readonly concepto: string;
  readonly movimientos: readonly MovimientoPolizaInput[];
}

export interface MovimientoPolizaRecord extends MovimientoPolizaInput {
  readonly linea: number;
}

export interface PolizaRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly tipo: TipoPoliza;
  readonly folio: number;
  readonly fecha: string;
  readonly concepto: string;
  readonly origen: OrigenPoliza;
  readonly invoiceId: string | null;
  readonly reversaDe: string | null;
  readonly reversada: boolean;
  readonly totalCentavos: number;
  readonly createdAt: string;
}

export interface PolizaConMovimientos extends PolizaRecord {
  readonly movimientos: readonly MovimientoPolizaRecord[];
}

export interface FiltroPolizas {
  readonly ejercicio: number;
  readonly mes?: number;
  readonly limit: number;
  readonly offset: number;
}

export interface LineaBalanzaLibro {
  readonly cuenta: string;
  readonly descripcion: string;
  readonly naturaleza: NaturalezaCuenta;
  readonly saldoInicialCentavos: number;
  readonly debeCentavos: number;
  readonly haberCentavos: number;
  readonly saldoFinalCentavos: number;
}

/** `no_disponible`: la migración 020 todavía no está en esta base. Las lecturas devuelven vacío honesto con este estado. */
export type EstadoLibro = "disponible" | "no_disponible";

export interface LecturaLibro<T> {
  readonly estado: EstadoLibro;
  readonly datos: T;
}

export interface RegistroPolizaResultado {
  readonly polizaId: string;
  readonly folio: number;
}

export class LibroNoDisponibleError extends Error {
  constructor() {
    super("El libro contable todavía no está disponible en esta base (migración pendiente).");
    this.name = "LibroNoDisponibleError";
  }
}
export class LibroSinPermisoError extends Error {
  constructor(message = "No tienes permiso para esta operación sobre el libro contable.") {
    super(message);
    this.name = "LibroSinPermisoError";
  }
}
export class LibroDatosInvalidosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibroDatosInvalidosError";
  }
}
export class PeriodoCerradoError extends Error {
  constructor(message = "El periodo está cerrado: no se registran pólizas en él.") {
    super(message);
    this.name = "PeriodoCerradoError";
  }
}
export class PolizaDuplicadaError extends Error {
  constructor(message = "El CFDI ya tiene una póliza vigente.") {
    super(message);
    this.name = "PolizaDuplicadaError";
  }
}
export class LibroNoEncontradoError extends Error {
  constructor(message = "No se encontró el registro.") {
    super(message);
    this.name = "LibroNoEncontradoError";
  }
}
export class LibroTopeExcedidoError extends Error {
  constructor(message = "Se alcanzó el tope del libro contable.") {
    super(message);
    this.name = "LibroTopeExcedidoError";
  }
}

export interface LibroRepository {
  /** Catálogo del cliente; `no_disponible` + lista vacía si la base no tiene la migración 020. */
  listarCuentas(propertyId: string): Promise<LecturaLibro<readonly CuentaLibro[]>>;
  /** Inserta las cuentas que falten (idempotente); devuelve cuántas se agregaron. */
  sembrarCatalogo(propertyId: string, cuentas: readonly CuentaLibro[]): Promise<number>;
  guardarCuenta(propertyId: string, cuenta: CuentaLibro): Promise<void>;
  registrarPoliza(propertyId: string, poliza: PolizaInput, invoiceId?: string | null): Promise<RegistroPolizaResultado>;
  reversarPoliza(propertyId: string, polizaId: string, fecha: string, concepto: string): Promise<RegistroPolizaResultado>;
  listarPolizas(propertyId: string, filtro: FiltroPolizas): Promise<LecturaLibro<readonly PolizaRecord[]>>;
  obtenerPoliza(propertyId: string, polizaId: string): Promise<PolizaConMovimientos | null>;
  /** Pólizas vigentes (no reversadas) ligadas a los CFDI dados: invoiceId -> póliza. */
  polizasDeCfdi(propertyId: string, invoiceIds: readonly string[]): Promise<ReadonlyMap<string, PolizaRecord>>;
  balanza(propertyId: string, ejercicio: number, mes: number): Promise<LecturaLibro<readonly LineaBalanzaLibro[]>>;
}
