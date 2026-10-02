// D-25 -- puerto del repositorio de pagos provisionales: lectura de la base del cálculo (CFDI + pagos de REP del ejercicio),
// registro de pagos de REP y papeles de trabajo (guardar / presentar). Migración 020.
import type { FacturaProvisional, ImpuestoProvisional, PagoRepProvisional } from "./types.ts";

export const MAX_FACTURAS_PAPEL = 20_000;

export interface BasePapel {
  readonly facturas: readonly FacturaProvisional[];
  readonly pagos: readonly PagoRepProvisional[];
  /** false = la base no tiene el modelo CFDI completo (migración 018): no hay con qué calcular. */
  readonly facturasDisponibles: boolean;
  /** false = la base no tiene la migración 020 (pagos de REP). */
  readonly pagosDisponibles: boolean;
  /** true = el ejercicio rebasó MAX_FACTURAS_PAPEL: un papel con CFDI faltantes NO se calcula. */
  readonly truncado: boolean;
}

export interface PagoRepNuevo {
  readonly invoiceId: string;
  readonly folioFiscalRep: string;
  readonly pagoIndex: number;
  /** YYYY-MM-DD. */
  readonly fechaPago: string;
  readonly flujo: "trasladado" | "acreditable";
  readonly numParcialidad: number | null;
  readonly importePagadoCentavos: number;
  readonly baseCentavos: number;
  readonly ivaCentavos: number;
  readonly ivaRetenidoCentavos: number;
}

export interface PapelAGuardar {
  readonly ejercicio: number;
  readonly mes: number;
  readonly impuesto: ImpuestoProvisional;
  readonly regimen: string;
  readonly baseCentavos: number;
  readonly determinadoCentavos: number;
  readonly acreditableCentavos: number;
  readonly aCargoCentavos: number;
  readonly aFavorCentavos: number;
  /** Entradas usadas (coeficiente, pérdidas...): sin PII. */
  readonly parametros: Readonly<Record<string, unknown>>;
  readonly advertencias: number;
}

export interface PapelGuardado extends PapelAGuardar {
  readonly id: string;
  readonly estado: "borrador" | "presentado";
  readonly montoPagadoCentavos: number | null;
  readonly fechaPresentacion: string | null;
  readonly updatedAt: string;
}

export interface LecturaPapeles {
  readonly estado: "disponible" | "no_disponible";
  readonly papeles: readonly PapelGuardado[];
}

export class PagosNoDisponiblesError extends Error {
  constructor() {
    super("Los pagos provisionales todavía no están disponibles en esta base (migración pendiente).");
    this.name = "PagosNoDisponiblesError";
  }
}
export class PagosSinPermisoError extends Error {
  constructor(message = "No tienes permiso para esta operación sobre los pagos provisionales.") {
    super(message);
    this.name = "PagosSinPermisoError";
  }
}
export class PagosDatosInvalidosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PagosDatosInvalidosError";
  }
}
export class PagosNoEncontradoError extends Error {
  constructor(message = "No se encontró el registro.") {
    super(message);
    this.name = "PagosNoEncontradoError";
  }
}
export class PapelYaPresentadoError extends Error {
  constructor(message = "El pago provisional ya fue presentado.") {
    super(message);
    this.name = "PapelYaPresentadoError";
  }
}

export interface PagosProvisionalesRepository {
  /** CFDI del ejercicio hasta el mes (más los CFDI de meses/ejercicios anteriores con pagos de REP en el rango) y esos pagos. */
  leerBase(propertyId: string, ejercicio: number, mes: number): Promise<BasePapel>;
  /** true = se insertó; false = ya existía (idempotente). */
  registrarPago(propertyId: string, pago: PagoRepNuevo): Promise<boolean>;
  listarPapeles(propertyId: string, ejercicio: number): Promise<LecturaPapeles>;
  guardarPapel(propertyId: string, papel: PapelAGuardar): Promise<void>;
  presentarPapel(propertyId: string, ejercicio: number, mes: number, impuesto: ImpuestoProvisional, montoPagadoCentavos: number, fechaPresentacion: string): Promise<void>;
}
