// Tipos de registro (fila ya mapeada a camelCase) que RentasRepository
// devuelve/recibe — ninguna función de negocio de las rutas de apps/api toca una
// fila cruda de SQL directamente, mismo criterio que domain-hoteles/domain-restaurantes.
import type { EstadoOcupacion, Razon, RangoFechas } from "./tipos.ts";
import type { ConfiguracionComisionCanal, LineaGastoEntrada, LineaImpuestoEntrada, MovimientoFinancieroReserva } from "./finanzas/tipos.ts";
import type { LineaOwnerStatement, TotalesOwnerStatement } from "./finanzas/statement.ts";
import type { LineaConciliada, ResumenConciliacion } from "./finanzas/conciliacion.ts";
import type { DescuentoDuracion, ReglaMinStay, TemporadaTarifa } from "./pricing/tipos.ts";

export interface UnidadRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly duracionMinimaNoches: number;
  /** `rentas.unidad.owner_id` -- `null` si la unidad no tiene propietario asignado
   *  todavía. Solo lo necesita el owner statement (Fase 2, Flujo 5); opcional para no
   *  romper los seeds de Fase 1 que no lo pasan. */
  readonly ownerId?: string | null;
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

/** Fila de listado para `GET .../bloqueos` -- Fase 4, expone `crearBloqueo` (motor
 * puro ya existente desde Fase 1, nunca alcanzable por HTTP hasta ahora). Solo cubre
 * `capa='bloqueo'` (BLOQUEO_PROPIETARIO/MANTENIMIENTO/BUFFER_LIMPIEZA) -- nunca
 * mezcla reservas de canal aquí, mismo criterio que `OcupacionResumen`. */
export interface BloqueoRecord {
  readonly id: string;
  readonly unidadId: string;
  readonly rango: RangoFechas;
  readonly razon: Extract<Razon, "BLOQUEO_PROPIETARIO" | "MANTENIMIENTO" | "BUFFER_LIMPIEZA">;
  readonly estado: EstadoOcupacion;
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

// ---------------------------------------------------------------------------
// Pricing CRUD (Fase 2, Flujo 4) -- ver migrations/004_pricing_escritura_rls.sql.
// ---------------------------------------------------------------------------

export interface NewTarifaBaseInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
  readonly vigenteDesde: string;
  readonly createdBy: string;
}

export interface TemporadaRecord extends TemporadaTarifa {
  readonly id: string;
}

export interface NewTemporadaInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly nombre: string;
  readonly rango: RangoFechas;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
  readonly createdBy: string;
}

export interface DescuentoDuracionRecord extends DescuentoDuracion {
  readonly id: string;
}

export interface NewDescuentoDuracionInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly nochesMinimas: number;
  readonly porcentajeDescuentoBasisPoints: number;
  readonly fuente: string;
  // Sin `createdBy`: `rentas.tarifa_descuento_duracion` (migrations/002) no tiene
  // columna `creado_por` -- a diferencia de tarifa_base/tarifa_temporada.
}

export interface ReglaMinStayRecord extends ReglaMinStay {
  readonly id: string;
}

export interface NewReglaMinStayInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly rango: RangoFechas;
  readonly diaSemanaCheckIn: number | null;
  readonly nochesMinimas: number;
  // Sin `createdBy`: `rentas.tarifa_min_stay` (migrations/002) no tiene columna
  // `creado_por`.
}

export interface NewReglaCanalPricingInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalId: string;
  readonly markupBasisPoints: number;
  readonly activo: boolean;
  // Sin `createdBy`: `rentas.tarifa_regla_canal` (migrations/002) no tiene columna
  // `creado_por`.
}

// ---------------------------------------------------------------------------
// Owner statement (Fase 2, Flujo 5) -- ver
// migrations/005_finanzas_statement_payout_schema.sql.
// ---------------------------------------------------------------------------

export interface OwnerRecord {
  readonly id: string;
  readonly name: string;
}

export interface UltimaVersionOwnerStatement {
  readonly id: string;
  readonly version: number;
  readonly hashContenido: string;
}

export interface NewOwnerStatementInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly ownerId: string;
  readonly periodo: RangoFechas;
  readonly version: number;
  readonly moneda: string;
  readonly totales: TotalesOwnerStatement;
  readonly lineas: readonly LineaOwnerStatement[];
  readonly hashContenido: string;
  readonly motivoVersion: string | null;
  readonly generadoPor: string;
}

export interface OwnerStatementSummary {
  readonly id: string;
  readonly ownerId: string;
  readonly propertyId: string;
  readonly periodo: RangoFechas;
  readonly version: number;
  readonly moneda: string;
  readonly netoCentavos: number;
  readonly generadoEn: string;
}

export interface OwnerStatementDetalle extends OwnerStatementSummary {
  readonly totales: TotalesOwnerStatement;
  readonly lineas: readonly LineaOwnerStatement[];
  readonly motivoVersion: string | null;
}

export type { ReservaParaStatement } from "./finanzas/statement.ts";

// ---------------------------------------------------------------------------
// Payout / conciliación (Fase 2, Flujo 6, alcance recortado -- ver diseño §1.4/§5).
// ---------------------------------------------------------------------------

export type { CandidataConciliacion, LineaConciliada } from "./finanzas/conciliacion.ts";

export interface NewPayoutInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly canalId: string;
  readonly moneda: string;
  readonly montoTotalCentavos: number;
  readonly fechaPayout: string;
  readonly referenciaExterna: string | null;
  readonly createdBy: string;
  readonly lineas: readonly LineaConciliada[];
}

export interface PayoutDetalle {
  readonly id: string;
  readonly propertyId: string;
  readonly canalCodigo: string;
  readonly moneda: string;
  readonly montoTotalCentavos: number;
  readonly fechaPayout: string;
  readonly referenciaExterna: string | null;
  readonly resumen: ResumenConciliacion;
  readonly lineas: readonly LineaConciliada[];
}
