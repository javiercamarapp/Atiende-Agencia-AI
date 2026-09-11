// Tipos de dominio de finanzas — port literal (recortado a lo que el flujo 3 de esta
// fase necesita: movimiento financiero por reserva; owner statement/conciliación de
// payout quedan fuera de fase, ver README.md) de
// rentas/packages/domain/src/finanzas/tipos.ts. Sin IO.

/** Código de moneda ISO 4217. */
export type CodigoMoneda = string;

/**
 * Configuración de comisión de canal: decide si el monto que el gestor recibe de un
 * canal ya viene neto de la comisión del canal (confirmado para Airbnb: "the entire
 * fee is deducted from the host's payout") o bruto (Booking.com/Vrbo, sin confirmar —
 * configurable, nunca hardcodeado).
 */
export interface ConfiguracionComisionCanal {
  /** `true`: el monto de entrada YA es neto de comisión de canal (no se vuelve a
   * restar — Finanzas-1). `false`: el monto de entrada es bruto y la comisión se
   * calcula y resta aquí. */
  yaNetoDeComision: boolean;
  /** Basis points (1600 = 16.00%). Ignorado si `yaNetoDeComision` es true. */
  comisionBasisPoints: number;
  /** Cita de la fuente y fecha de vigencia (nunca un valor mudo en la UI). */
  fuente: string;
}

/** Base sobre la que se calcula la comisión del gestor (decisión de producto por
 * tenant). */
export type BaseComisionGestor = "bruto" | "neto_de_canal";

export interface ConfiguracionComisionGestor {
  basisPoints: number;
  base: BaseComisionGestor;
}

export interface LineaGastoEntrada {
  tipo: string;
  descripcion?: string | null;
  montoCentavos: number;
}

/**
 * Línea de impuesto: SIEMPRE `revisionFiscal: true` — Atiende nunca calcula un monto
 * de retención ISR/IVA definitivo; estas líneas son capturadas manualmente (o
 * importadas de un reporte de canal) y quedan marcadas para revisión legal/fiscal
 * antes de presentarse como definitivas.
 */
export interface LineaImpuestoEntrada {
  tipo: string;
  montoCentavos: number;
  nota?: string;
}

export interface EntradaMovimientoReserva {
  ocupacionUnidadId: string;
  moneda: CodigoMoneda;
  montoBrutoCentavos: number;
  comisionCanal: ConfiguracionComisionCanal;
  comisionGestor: ConfiguracionComisionGestor;
  gastos: LineaGastoEntrada[];
  impuestos: LineaImpuestoEntrada[];
}

export interface MovimientoFinancieroReserva {
  ocupacionUnidadId: string;
  moneda: CodigoMoneda;
  ingresoBrutoCentavos: number;
  /** Monto efectivamente recibido por el gestor tras la comisión de canal (igual a
   * `ingresoBrutoCentavos` si `yaNetoDeComision`). */
  montoRecibidoCentavos: number;
  comisionCanalCentavos: number;
  comisionCanalFuente: string;
  comisionGestorCentavos: number;
  gastosCentavos: number;
  impuestosCentavos: number;
  netoCentavos: number;
}
