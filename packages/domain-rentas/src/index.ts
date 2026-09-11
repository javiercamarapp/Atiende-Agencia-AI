export type { Capa, EstadoOcupacion, FechaLocal, Ocupacion, RangoFechas, Razon, TipoConflicto } from "./tipos.ts";
export { PRECEDENCIA_RAZON } from "./tipos.ts";

export { puedeTransicionar, transicionar } from "./estados.ts";

export { calcularNoches, diaDeLaSemana, esRangoValido, nochesDelRango, rangoCubreNoche, rangosSeSuperponen } from "./fechas.ts";

export type { EjecutorTransaccional, FilaSql } from "./ejecutor.ts";
export { bloquearUnidadEnTransaccion, esViolacionExclusion } from "./ejecutor.ts";

export { RentasDomainError } from "./errors.ts";
export type { RentasErrorCode } from "./errors.ts";

export {
  cancelarOcupacion,
  crearBloqueo,
  crearReservaConfirmada,
  modificarFechasReserva,
} from "./aplicacion/reservas.ts";
export type {
  EntradaCrearBloqueo,
  EntradaCrearReserva,
  InfoConflicto,
  ResultadoCancelarOcupacion,
  ResultadoCrearBloqueo,
  ResultadoCrearReserva,
  ResultadoModificarFechas,
} from "./aplicacion/reservas.ts";

export { calcularCotizacion, evaluarViolacionesMinStay } from "./pricing/cotizacion.ts";
export type {
  ContextoPricingUnidad,
  DescuentoAplicado,
  DescuentoDuracion,
  DesgloseNoche,
  EntradaCotizacion,
  ReglaCanal,
  ReglaMinStay,
  ResultadoCotizacion,
  TemporadaTarifa,
  ViolacionMinStay,
} from "./pricing/tipos.ts";

export { aplicarPorcentaje, centavosDesdeDecimal, decimalDesdeCentavos, restarCentavos, sumarCentavos } from "./finanzas/redondeo.ts";
export { calcularMovimientoReserva } from "./finanzas/movimiento.ts";
export type {
  BaseComisionGestor,
  CodigoMoneda,
  ConfiguracionComisionCanal,
  ConfiguracionComisionGestor,
  EntradaMovimientoReserva,
  LineaGastoEntrada,
  LineaImpuestoEntrada,
  MovimientoFinancieroReserva,
} from "./finanzas/tipos.ts";

export {
  CANCELAR_ROLES,
  ESCRITURA_CALENDARIO_ROLES,
  FINANZAS_ESCRITURA_ROLES,
  FINANZAS_LECTURA_ROLES,
  isRentasVerticalRole,
  PLATFORM_ROLE_BY_VERTICAL_ROLE,
  RENTAS_VERTICAL_ROLES,
} from "./roles.ts";
export type { RentasVerticalRole } from "./roles.ts";

export type {
  CanalRecord,
  NewGuestMinimoInput,
  NewReservaFinancieroInput,
  OcupacionParaMovimiento,
  OcupacionResumen,
  UnidadRecord,
} from "./types.ts";

export type { RentasRepository } from "./repository.ts";
export { InMemoryRentasRepository } from "./in-memory-repository.ts";
export { PostgresRentasRepository } from "./postgres-repository.ts";
export { InMemoryRentasCalendarStore } from "./calendar-store.ts";
export { InMemoryRentasTenancyEngine } from "./in-memory-tenancy-engine.ts";
export type { SeedTenancyMembership, SeedTenancyProperty } from "./in-memory-tenancy-engine.ts";
