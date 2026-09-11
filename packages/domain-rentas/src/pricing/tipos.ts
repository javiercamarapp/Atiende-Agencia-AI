// Tipos de dominio de pricing básico — port literal de
// rentas/packages/domain/src/pricing/tipos.ts. Sin IO: solo formas de datos y
// funciones puras.
import type { FechaLocal, RangoFechas } from "../tipos.ts";

export interface TemporadaTarifa {
  nombre: string;
  /** Semiabierto `[inicio, fin)`, mismo modelo que `RangoFechas` de calendario, para
   * reutilizar `rangoCubreNoche`. */
  rango: RangoFechas;
  precioNocheCentavos: number;
}

/**
 * Descuento por duración de estancia: umbrales estándar de industria (7+ noches
 * semanal, 28+ noches mensual). `fuente` se declara explícitamente por dato (nunca un
 * porcentaje mudo), y el motor NO asume estos umbrales por defecto: deben
 * configurarse por unidad.
 */
export interface DescuentoDuracion {
  nochesMinimas: number;
  porcentajeDescuentoBasisPoints: number;
  fuente: string;
}

/** Min-stay dinámico por rango de fechas y, opcionalmente, día de la semana del
 * check-in. */
export interface ReglaMinStay {
  rango: RangoFechas;
  /** `0` (domingo) a `6` (sábado); `null` = aplica todos los días. */
  diaSemanaCheckIn: number | null;
  nochesMinimas: number;
}

/** Regla por canal: markup para compensar la comisión del canal al publicar la misma
 * tarifa neta deseada. */
export interface ReglaCanal {
  canalCodigo: string;
  markupBasisPoints: number;
  activo: boolean;
}

export interface ContextoPricingUnidad {
  unidadId: string;
  moneda: string;
  precioBaseNocheCentavos: number;
  temporadas: TemporadaTarifa[];
  descuentosDuracion: DescuentoDuracion[];
  reglasMinStay: ReglaMinStay[];
}

export interface EntradaCotizacion {
  contexto: ContextoPricingUnidad;
  rango: RangoFechas;
  /** Si se cotiza para un canal específico, aplica su `ReglaCanal` (markup) —
   * `null`/omitido = cotización para reserva directa, sin markup. */
  reglaCanal?: ReglaCanal | null;
}

export interface DesgloseNoche {
  fecha: FechaLocal;
  precioCentavos: number;
  origen: "base" | "temporada";
  temporadaNombre?: string;
}

export interface DescuentoAplicado {
  nochesMinimas: number;
  porcentajeDescuentoBasisPoints: number;
  fuente: string;
  montoCentavos: number;
}

export interface ViolacionMinStay {
  regla: ReglaMinStay;
  nochesSolicitadas: number;
}

export interface ResultadoCotizacion {
  unidadId: string;
  moneda: string;
  noches: number;
  desgloseNoches: DesgloseNoche[];
  subtotalAntesDescuentoCentavos: number;
  descuentoAplicado: DescuentoAplicado | null;
  subtotalConDescuentoCentavos: number;
  markupCanalCentavos: number;
  totalCentavos: number;
  /** Nunca bloquea el cálculo (es informativo): la UI decide si impide la reserva; el
   * motor de cotización siempre devuelve un precio determinista aunque min-stay no se
   * cumpla, para que la UI pueda explicar "por qué". */
  violacionesMinStay: ViolacionMinStay[];
}
