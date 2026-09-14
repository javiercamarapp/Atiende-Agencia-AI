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
  MENSAJERIA_ESCRITURA_ROLES,
  MENSAJERIA_PLANTILLA_APROBACION_ROLES,
  PLATFORM_ROLE_BY_VERTICAL_ROLE,
  PRICING_ESCRITURA_ROLES,
  RENTAS_VERTICAL_ROLES,
  SYNC_CALENDARIO_ESCRITURA_ROLES,
  SYNC_CALENDARIO_LECTURA_ROLES,
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

// ---------------------------------------------------------------------------
// Sincronización de calendario por canal (Fase 5) -- ver src/ical/*, src/sync/*.
// Parser/generador iCal RFC 5545 puro + motor de sync/reconciliación best-effort,
// mismo principio que domain-citas/calendar-sync.ts: rentas es SIEMPRE la fuente de
// verdad, el canal externo es downstream.
// ---------------------------------------------------------------------------
export { IcsParseError, LIMITES_ICS_POR_DEFECTO, parsearIcs } from "./ical/parser.ts";
export type { CalendarioIcsNormalizado, EstadoEventoIcs, LimitesParserIcs, VEventNormalizado, ValorFechaIcs } from "./ical/parser.ts";
export type { CodigoErrorIcs } from "./ical/tipos.ts";
export { fechaLocalDesdeFechaHoraConZona, fechaLocalDesdeInstante, resolverFechaLocal } from "./ical/resolver-fecha.ts";
export { calcularHashContenidoBloqueo, construirUidExportado, esUidNamespacePropio, exportarFeedIcs, NAMESPACE_UID_EXPORT } from "./ical/exportador.ts";
export type { BloqueoExportable, EntradaHashBloqueo, FeedExportado } from "./ical/exportador.ts";

export { aplicarResultadoCiclo, ESTADO_FEED_INICIAL, OPCIONES_CUARENTENA_POR_DEFECTO } from "./sync/cuarentena.ts";
export type { AlertaCuarentena, EstadoFeedCanal, OpcionesCuarentena, ResultadoAplicarCiclo, ResultadoCicloFetch } from "./sync/cuarentena.ts";
export { calcularBackoffMs, OPCIONES_BACKOFF_POR_DEFECTO, reconciliarCompleto } from "./sync/reconciliacion.ts";
export type { OpcionesBackoff, ResultadoReconciliacionCompleta, UidActivoInterno } from "./sync/reconciliacion.ts";
export { detectarEco } from "./sync/anti-eco.ts";
export type { CapaAntiEco, EntradaDeteccionEco, ResultadoDeteccionEco } from "./sync/anti-eco.ts";
export { resolverVersionEvento } from "./sync/resolucion-version.ts";
export type { AccionResolucion, ResultadoResolucion, VersionEvento } from "./sync/resolucion-version.ts";
export { FakeIcalFeedPort, RealIcalFeedPort } from "./sync/calendar-sync-port.ts";
export type { CalendarSyncPort, FetchFeedInput, FetchFeedResult } from "./sync/calendar-sync-port.ts";
export { SsrfError, redactarUrlParaLog, validarIpPermitida, validarTodasLasIps } from "./sync/net/ssrf.ts";
export type { MotivoRechazoSsrf, ResultadoValidacionIp } from "./sync/net/ssrf.ts";
export { fetchIcsSeguro } from "./sync/net/fetch-ics-seguro.ts";
export type { OpcionesFetchIcs, ResultadoFetchIcs } from "./sync/net/fetch-ics-seguro.ts";
export { ejecutarCicloImportacion, exportarFeedParaUnidad } from "./sync/motor.ts";
export type { ContextoExportacion, ContextoSincronizacion, EventoDescartadoPorError, ResultadoImportarCiclo, RevisionUidReciclado } from "./sync/motor.ts";
export type { RentasCalendarSyncRepository } from "./sync/repository.ts";
export type { BloqueoExportadoPrevio, EntradaUpsertEventoImportado, FeedExternoRecord, NewFeedExternoInput, OcupacionActivaExportable, VersionPreviaAlmacenada } from "./sync/tipos.ts";
export { InMemoryRentasCalendarSyncRepository } from "./sync/in-memory-repository.ts";
export { PostgresRentasCalendarSyncRepository } from "./sync/postgres-repository.ts";

// ---------------------------------------------------------------------------
// Mensajería con huésped + automatización agéntica (Fase 7) -- ver src/mensajeria/*,
// src/agentes/*. "Un agente redacta la respuesta al huésped -- y esa respuesta no
// sale hasta que alguien la aprueba": ./mensajeria/colaAprobacion.ts es la garantía
// de dominio de esa frase (ninguna función del paquete transiciona
// pendiente_aprobacion -> enviado sin pasar por un clic humano), ./agentes/* es la
// lógica de negocio específica de rentas (matriz de tools por rol, generador de
// borrador respaldado por @atiende/agent-core::LlmGateway) que le falta a la
// primitiva genérica de agentes del monorepo para poder generar ese borrador.
// ---------------------------------------------------------------------------
export * from "./mensajeria/index.ts";
export * from "./agentes/index.ts";
