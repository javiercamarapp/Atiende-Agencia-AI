// Tipos de la importación de estados de cuenta bancarios (D-03). El movimiento
// importado EXTIENDE `MovimientoBancario` del motor de conciliación existente
// (`../types.ts`) para poder pasarse tal cual a `conciliarMovimientos` sin adaptador.
import type { MovimientoBancario } from "../types.ts";

export const BANCOS_MX = ["bbva", "banorte", "santander", "hsbc", "scotiabank", "banamex", "inbursa", "generico"] as const;
export type BancoMx = (typeof BANCOS_MX)[number];

export type FormatoEstadoCuenta = "csv" | "ofx";

/** Error de un renglón: el renglón se EXCLUYE de los movimientos y se reporta con su
 * número de línea física en el archivo (1 = primera línea) para que el contador lo
 * corrija en el banco/Excel y vuelva a subir. */
export interface ErrorRenglonEstado {
  readonly renglon: number;
  /** Campo que falló ("fecha", "cargo", "abono", "importe", "saldo", "fila"), o null. */
  readonly campo: string | null;
  readonly codigo: "fecha_invalida" | "importe_invalido" | "sin_importe" | "cargo_y_abono" | "tipo_desconocido" | "fila_incompleta" | "ofx_invalido";
  readonly mensaje: string;
}

/** Aviso no bloqueante (el movimiento SÍ se importa). */
export interface AdvertenciaEstado {
  readonly renglon: number | null;
  readonly codigo: "saldo_discontinuo" | "posible_duplicado" | "sin_cuenta" | "banco_no_detectado" | "monto_cero";
  readonly mensaje: string;
}

export interface MovimientoImportado extends MovimientoBancario {
  /** Renglón físico de origen (CSV: línea; OFX: n-ésimo STMTTRN, 1-based). */
  readonly renglon: number;
  /** SHA-256 hex determinista (idempotencia): mismo movimiento en la misma cuenta →
   * mismo hash aunque el archivo se vuelva a subir o se traslape con otro periodo. */
  readonly hash: string;
  /** n-ésima aparición (1-based) de un movimiento idéntico (misma fecha, monto y
   * concepto) en el archivo. Dos depósitos legítimos iguales el mismo día NO son un
   * duplicado: el hash los distingue por esta ocurrencia. */
  readonly ocurrencia: number;
}

export interface ResultadoParseoEstado {
  readonly formato: FormatoEstadoCuenta;
  readonly banco: BancoMx;
  /** true si el banco se dedujo del contenido; false si lo indicó el usuario o cayó a "generico". */
  readonly bancoDetectado: boolean;
  /** CLABE / número de cuenta si el archivo lo trae (OFX ACCTID, preámbulo CSV). */
  readonly cuenta: string | null;
  readonly moneda: string;
  readonly movimientos: readonly MovimientoImportado[];
  readonly errores: readonly ErrorRenglonEstado[];
  readonly advertencias: readonly AdvertenciaEstado[];
  /** Renglones de datos leídos (movimientos + con error). */
  readonly renglonesLeidos: number;
  readonly periodo: { readonly desde: string; readonly hasta: string } | null;
  readonly totalCargos: number;
  readonly totalAbonos: number;
  readonly saldoFinal: number | null;
}

/** Movimiento listo para el libro `despachos.estado_cuenta_movimiento` (migración 015). */
export interface NuevoMovimientoEstadoCuenta {
  readonly hash: string;
  readonly cuenta: string | null;
  readonly banco: BancoMx;
  readonly formato: FormatoEstadoCuenta;
  readonly fecha: string;
  readonly descripcion: string;
  readonly referencia: string | null;
  readonly cargo: number | null;
  readonly abono: number | null;
  readonly monto: number;
  readonly saldo: number | null;
  readonly renglon: number;
}

export interface NuevoLoteEstadoCuenta {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly loteId: string;
  readonly movimientos: readonly NuevoMovimientoEstadoCuenta[];
}

export interface ResultadoGuardadoEstadoCuenta {
  readonly loteId: string;
  readonly insertados: number;
  /** Movimientos cuya huella ya estaba en el libro (descartados por idempotencia, no son error). */
  readonly yaExistentes: number;
}
