// Rn-03 -- puerto de datos del reporte de ocupación e ingresos. Solo LECTURA, sobre tablas
// que ya existen desde 001/003 (no requiere migración nueva).
import type { RangoFechas } from "../tipos.ts";
import type { ReservaParaReporte, UnidadParaReporte } from "./tipos.ts";

export interface FiltrosReporte {
  readonly unidadId?: string;
  readonly ownerId?: string;
  readonly canal?: string;
}

export interface DatosReporte {
  readonly moneda: string;
  readonly zonaHoraria: string;
  readonly unidades: readonly UnidadParaReporte[];
  readonly reservas: readonly ReservaParaReporte[];
  /** `false` cuando la base no tiene (o no deja leer) `rentas.reserva_financiero`: las
   * reservas traen noches pero ningún monto -- la UI lo dice, nunca inventa ceros. */
  readonly financieroDisponible: boolean;
}

export interface ContextoPropiedadReporte {
  readonly moneda: string;
  readonly zonaHoraria: string;
}

export interface RentasReportesRepository {
  /** Moneda y zona horaria de la property (para elegir el mes en curso cuando no se pide periodo). */
  leerContextoPropiedad(propertyId: string): Promise<ContextoPropiedadReporte>;
  cargarDatosReporte(propertyId: string, periodo: RangoFechas, filtros: FiltrosReporte): Promise<DatosReporte>;
}
