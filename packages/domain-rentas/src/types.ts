// Tipos de registro (fila ya mapeada a camelCase) que RentasRepository
// devuelve/recibe — ninguna función de negocio de las rutas de apps/api toca una
// fila cruda de SQL directamente, mismo criterio que domain-hoteles/domain-restaurantes.
import type { EstadoOcupacion } from "./tipos.ts";
import type { ConfiguracionComisionCanal, LineaGastoEntrada, LineaImpuestoEntrada, MovimientoFinancieroReserva } from "./finanzas/tipos.ts";

export interface UnidadRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly duracionMinimaNoches: number;
}

export interface CanalRecord {
  readonly id: string;
  readonly codigo: string;
}

export interface NewGuestMinimoInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly nombre: string | null;
  readonly contacto: string | null;
}

/** Resumen mínimo de una ocupación para las verificaciones de defensa en profundidad
 * que hace la ruta ANTES de invocar `modificarFechasReserva`/`cancelarOcupacion`
 * (nunca tocar una reserva de canal — regla heredada del origen, se porta literal). */
export interface OcupacionResumen {
  readonly id: string;
  readonly unidadId: string;
  readonly capa: "reserva" | "bloqueo";
  readonly estado: EstadoOcupacion;
  readonly canalOrigenId: string | null;
}

export interface OcupacionParaMovimiento {
  readonly id: string;
  readonly capa: "reserva" | "bloqueo";
  readonly canalId: string | null;
}

export interface NewReservaFinancieroInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly ocupacionId: string;
  readonly moneda: string;
  readonly montoBrutoCentavos: number;
  readonly yaNetoDeComision: boolean;
  readonly comisionCanalBasisPoints: number;
  readonly comisionCanalFuente: string;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorBasisPoints: number;
  readonly comisionGestorBase: "bruto" | "neto_de_canal";
  readonly comisionGestorCentavos: number;
  readonly montoRecibidoCentavos: number;
  readonly gastos: readonly LineaGastoEntrada[];
  readonly gastosCentavos: number;
  readonly impuestos: readonly LineaImpuestoEntrada[];
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
  readonly createdBy: string;
}

export type { ConfiguracionComisionCanal, MovimientoFinancieroReserva };
export type { ContextoPricingUnidad, DescuentoDuracion, ReglaCanal, ReglaMinStay, ResultadoCotizacion, TemporadaTarifa } from "./pricing/tipos.ts";
