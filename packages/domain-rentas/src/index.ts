export type { Capa, EstadoOcupacion, FechaLocal, Ocupacion, RangoFechas, Razon, TipoConflicto } from "./tipos.ts";
export { PRECEDENCIA_RAZON } from "./tipos.ts";

export { puedeTransicionar, transicionar } from "./estados.ts";

export { calcularNoches, diaDeLaSemana, esRangoValido, nochesDelRango, rangoCubreNoche, rangosSeSuperponen } from "./fechas.ts";

export type { EjecutorTransaccional, FilaSql } from "./ejecutor.ts";
export { bloquearOwnerStatementEnTransaccion, bloquearUnidadEnTransaccion, esViolacionExclusion } from "./ejecutor.ts";

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

export { encontrarMinStaySolapada, encontrarTemporadaSolapada } from "./pricing/validacion.ts";
export type { ReglaMinStayExistente, TemporadaExistente } from "./pricing/validacion.ts";

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

export { calcularHashStatement, esMismoContenidoQueVersionAnterior, generarOwnerStatement } from "./finanzas/statement.ts";
export type { LineaOwnerStatement, ParametrosOwnerStatement, ResultadoOwnerStatement, ReservaParaStatement, TipoLineaOwnerStatement, TotalesOwnerStatement } from "./finanzas/statement.ts";

export { conciliarPayout } from "./finanzas/conciliacion.ts";
export type { CandidataConciliacion, EstadoConciliacion, LineaConciliada, LineaPayoutEntrada, ResultadoConciliacion, ResumenConciliacion } from "./finanzas/conciliacion.ts";

export {
  CANCELAR_ROLES,
  ESCRITURA_CALENDARIO_ROLES,
  FINANZAS_ESCRITURA_ROLES,
  FINANZAS_LECTURA_ROLES,
  isRentasVerticalRole,
  PLATFORM_ROLE_BY_VERTICAL_ROLE,
  PRICING_ESCRITURA_ROLES,
  RENTAS_VERTICAL_ROLES,
} from "./roles.ts";
export type { RentasVerticalRole } from "./roles.ts";

export type {
  BloqueoRecord,
  CanalRecord,
  DescuentoDuracionRecord,
  NewDescuentoDuracionInput,
  NewGuestMinimoInput,
  NewOwnerStatementInput,
  NewPayoutInput,
  NewReglaCanalPricingInput,
  NewReglaMinStayInput,
  NewReservaFinancieroInput,
  NewTarifaBaseInput,
  NewTemporadaInput,
  OcupacionParaMovimiento,
  OcupacionResumen,
  OwnerRecord,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutDetalle,
  ReglaMinStayRecord,
  TemporadaRecord,
  UltimaVersionOwnerStatement,
  UnidadRecord,
} from "./types.ts";

export type { RentasRepository } from "./repository.ts";
export { InMemoryRentasRepository } from "./in-memory-repository.ts";
export { PostgresRentasRepository } from "./postgres-repository.ts";
export { InMemoryRentasCalendarStore } from "./calendar-store.ts";
export { InMemoryRentasTenancyEngine } from "./in-memory-tenancy-engine.ts";
export type { SeedTenancyMembership, SeedTenancyProperty } from "./in-memory-tenancy-engine.ts";

// ---------------------------------------------------------------------------
// Portal de propietario (Fase 3) -- ver src/owner-portal/*, aislado a propósito del
// resto del paquete (identidad/JWT/RLS propios, nunca de staff). Ver diseño Fase 3
// rentas §1-§7.
// ---------------------------------------------------------------------------
export {
  RentasPropertyOwnerTokenExpiredError,
  RentasPropertyOwnerTokenInvalidError,
  signRentasPropertyOwnerAccessToken,
  signRentasPropertyOwnerRefreshToken,
  verifyRentasPropertyOwnerAccessToken,
  verifyRentasPropertyOwnerRefreshToken,
} from "./owner-portal/jwt.ts";
export type { RentasPropertyOwnerAccessTokenClaims, RentasPropertyOwnerRefreshTokenClaims } from "./owner-portal/jwt.ts";

export { generateInviteToken, hashInviteToken } from "./owner-portal/invite-token.ts";
export type { GeneratedInviteToken } from "./owner-portal/invite-token.ts";

export type {
  ConsumePortalInviteInput,
  FiltroOwnerPortalStatements,
  NewPortalInviteInput,
  OwnerCredentialForLogin,
  OwnerPortalOrganizacion,
  OwnerPortalProfileBase,
  OwnerPortalStatementDetalle,
  OwnerPortalStatementSummary,
  UnidadPropietarioRecord,
} from "./owner-portal/types.ts";

export type { RentasOwnerPortalRepository } from "./owner-portal/repository.ts";
export { InMemoryRentasOwnerPortalRepository } from "./owner-portal/in-memory-repository.ts";
export { PostgresRentasOwnerPortalRepository } from "./owner-portal/postgres-repository.ts";
