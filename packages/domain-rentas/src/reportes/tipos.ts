// Rn-03 -- tipos del reporte de ocupación e ingresos. Sin IO. Todo dinero en CENTAVOS
// enteros (mismo criterio que ../finanzas), nunca punto flotante; la moneda de reporte
// es la de la property (MXN por defecto, ver rentas.property_config.moneda) y NUNCA se
// convierte tipo de cambio.
import type { FechaLocal, RangoFechas } from "../tipos.ts";

/** Máximo de noches que cubre un reporte (2 años): acota el costo de la agregación. */
export const MAX_NOCHES_REPORTE = 731;

export type AgrupacionReporte = "unidad" | "propietario" | "canal" | "mes";
export const AGRUPACIONES_REPORTE: readonly AgrupacionReporte[] = ["unidad", "propietario", "canal", "mes"];

/** Movimiento financiero ya calculado de una reserva (`rentas.reserva_financiero`). */
export interface FinancieroReservaReporte {
  readonly moneda: string;
  readonly brutoCentavos: number;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorCentavos: number;
  readonly gastosCentavos: number;
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
}

/** Una reserva `confirmado` de capa 'reserva' (rentas.ocupacion) con su movimiento
 * financiero opcional (una reserva sin `reserva_financiero` aporta noches, no dinero). */
export interface ReservaParaReporte {
  readonly ocupacionId: string;
  readonly unidadId: string;
  /** Código de canal (`rentas.canal.codigo`); 'manual' = reserva directa. */
  readonly canal: string;
  /** Check-in inclusivo / check-out exclusivo (`[inicio, fin)`). */
  readonly inicio: FechaLocal;
  readonly fin: FechaLocal;
  /** Desempate determinista cuando dos reservas pretenden la misma noche. */
  readonly creadaEn: string;
  readonly financiero: FinancieroReservaReporte | null;
}

export interface UnidadParaReporte {
  readonly id: string;
  readonly nombre: string;
  readonly ownerId: string | null;
  readonly ownerNombre: string | null;
}

export interface EntradaReporte {
  readonly periodo: RangoFechas;
  readonly moneda: string;
  readonly unidades: readonly UnidadParaReporte[];
  readonly reservas: readonly ReservaParaReporte[];
}

export interface MetricasReporte {
  /** Check-ins dentro del periodo (cada reserva cuenta UNA vez, en su mes de llegada). */
  readonly llegadas: number;
  readonly nochesOcupadas: number;
  /** `null` cuando la dimensión no tiene inventario propio (agrupar por canal). */
  readonly nochesDisponibles: number | null;
  /** Ocupación en puntos base (7550 = 75.50%); `null` si no hay nochesDisponibles. */
  readonly ocupacionBasisPoints: number | null;
  readonly ingresoBrutoCentavos: number;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorCentavos: number;
  readonly gastosCentavos: number;
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
  /** Tarifa media por noche ocupada (bruto / noches), redondeo half-up; 0 sin noches. */
  readonly adrCentavos: number;
}

export interface GrupoReporte extends MetricasReporte {
  /** Clave estable: id de unidad/propietario, código de canal o 'YYYY-MM'. */
  readonly clave: string;
  readonly etiqueta: string;
}

export interface AdvertenciasReporte {
  /** Reservas con noches en el periodo pero sin movimiento financiero registrado. */
  readonly reservasSinMovimientoFinanciero: number;
  /** Reservas cuyo movimiento está en una moneda distinta a la del reporte (no se convierte). */
  readonly reservasMonedaDistinta: number;
  /** Noches reclamadas por dos reservas de la misma unidad: se cuentan una sola vez. */
  readonly nochesSolapadasOmitidas: number;
  /** Filas repetidas del mismo ocupacion_id: se cuentan una sola vez. */
  readonly reservasDuplicadasOmitidas: number;
}

export interface FilaDetalleReporte extends MetricasReporte {
  readonly mes: string;
  readonly unidadId: string;
  readonly unidadNombre: string;
  readonly ownerId: string | null;
  readonly ownerNombre: string | null;
  readonly canal: string;
}

export interface ResultadoReporte {
  readonly periodo: RangoFechas;
  readonly moneda: string;
  readonly totales: MetricasReporte;
  readonly porUnidad: readonly GrupoReporte[];
  readonly porPropietario: readonly GrupoReporte[];
  readonly porCanal: readonly GrupoReporte[];
  readonly porMes: readonly GrupoReporte[];
  /** Cubo completo mes x unidad x canal (insumo de cualquier agrupación). */
  readonly detalle: readonly FilaDetalleReporte[];
  readonly advertencias: AdvertenciasReporte;
}
