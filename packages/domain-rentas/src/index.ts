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
  CALENDARIO_LECTURA_ROLES,
  CANCELAR_ROLES,
  ESCRITURA_CALENDARIO_ROLES,
  FINANZAS_ESCRITURA_ROLES,
  FINANZAS_LECTURA_ROLES,
  isRentasVerticalRole,
  LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES,
  LIMPIEZA_OPERACION_ROLES,
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
  EmailOutboxJobRow,
  MessagingOutboxChannel,
  NewDescuentoDuracionInput,
  NewGuestMinimoInput,
  NewOwnerStatementInput,
  NewPayoutInput,
  NewReglaCanalPricingInput,
  NewReglaMinStayInput,
  NewReservaFinancieroInput,
  NewTarifaBaseInput,
  NewTemporadaInput,
  OcupacionCalendarioItem,
  OcupacionParaCorreo,
  OcupacionParaMovimiento,
  OcupacionResumen,
  OwnerRecord,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutDetalle,
  ReglaMinStayRecord,
  RentasOrganizationSummary,
  RentasPropertySummary,
  ReservaProximaCheckIn,
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

// ---------------------------------------------------------------------------
// Limpieza/mantenimiento (Fase 8) -- ver src/limpieza/*. Cierra el gap identificado
// por auditoría: "limpieza" existía únicamente como valor de `Razon` (BUFFER_LIMPIEZA,
// desde la Fase 1) sin ningún módulo que creara tareas, checklists, inventario o
// incidencias -- ver README de este paquete.
// ---------------------------------------------------------------------------
export * from "./limpieza/index.ts";

// ---------------------------------------------------------------------------
// Correo transaccional al huésped (Fase 9) -- confirmación al crear una reserva +
// recordatorio de check-in 24-48h antes, ambos deterministas/sin IA (nunca pasan por
// la cola de aprobación humana de ./mensajeria/colaAprobacion.ts, ver comentario de
// cabecera de ./emails/reserva-templates.ts). Cierra el gap identificado por
// auditoría: el repo original enviaba estos dos correos reales y
// apps/api/.../rentas/reservas.ts lo documentaba explícitamente como diferido
// ("no hay motor de correo migrado a atiende-fusion todavía") — domain-citas ya
// había traído ese motor en su propia Fase 6 §3; esta fase lo porta a rentas.
// ---------------------------------------------------------------------------
export { correoReservaConfirmada, correoReservaRecordatorioCheckIn } from "./emails/reserva-templates.ts";
export type { Correo as ReservaCorreo, ReservaCorreoDatos } from "./emails/reserva-templates.ts";
export { enqueueReservaEmailCore, tryEnqueueReservaEmail } from "./reserva-email-notifications.ts";
export type { ReservaEmailEvent, ReservaEmailResult } from "./reserva-email-notifications.ts";
export { dispatchPendingEmailJobs, MAX_EMAIL_DISPATCH_ATTEMPTS, sendEmailOutboxJob } from "./email-dispatch.ts";
export type { EmailDispatchSummary, ResendConfig } from "./email-dispatch.ts";
export { runRecordatorioCheckInCore } from "./checkin-reminders.ts";
export type { RecordatorioCheckInSummary } from "./checkin-reminders.ts";

// ---------------------------------------------------------------------------
// Onboarding self-serve del tenant de rentas (Fase 11) -- ver src/onboarding/*.
// Cierra el gap identificado por auditoría: el repo original permite que un cliente
// nuevo se dé de alta a sí mismo (organización + primera propiedad + admin +
// configuración inicial de rentas, un solo submit); en atiende-fusion,
// `core.organization`/`core.property`/`core.staff_user`/`core.membership` son
// service_role-write-only (gap de plataforma real, documentado en
// ./onboarding/repository.ts junto con su solución conocida -- mismo patrón
// `security definer` que `core.accept_staff_invite`). Esta fase construye la
// porción de rentas que SÍ es del paquete: validación/normalización de la captura
// (./onboarding/captura.ts) + el puerto de persistencia con su adaptador real (SQL
// correcto, sin mocks) listo para conectarse en cuanto esa decisión de plataforma se
// tome -- ver apps/api/src/production/rentas-onboarding-repository.ts para cómo se
// documenta el bloqueo en la capa de aplicación.
// ---------------------------------------------------------------------------
export { validarCapturaOnboardingRentas, slugificarNombreOrganizacion } from "./onboarding/captura.ts";
export type {
  CapturaOnboardingAdminInput,
  CapturaOnboardingConfiguracionInicialInput,
  CapturaOnboardingOrganizacionInput,
  CapturaOnboardingPrimerOwnerInput,
  CapturaOnboardingPropiedadInput,
  CapturaOnboardingRentasInput,
  CapturaOnboardingRentasValidada,
  NuevoTenantRentasInput,
  ResultadoRegistroTenantRentas,
  TipoOrganizacionRentas,
} from "./onboarding/tipos.ts";
export type { RentasOnboardingRepository } from "./onboarding/repository.ts";
export { InMemoryRentasOnboardingRepository } from "./onboarding/in-memory-repository.ts";
export { PostgresRentasOnboardingRepository } from "./onboarding/postgres-repository.ts";

// ---------------------------------------------------------------------------
// Acceso auditado "romper cristal" (Fase 10) -- ver src/break-glass/*. Superadmin de
// plataforma lee datos de un tenant específico fuera del flujo normal de RLS, con
// razón obligatoria y bitácora inmutable encadenada por hash (migrations/
// 012_break_glass_audit.sql). Cierra el gap identificado por auditoría: el módulo
// genérico de impersonación de @atiende/core-authz (view-as) ya existía, pero sin
// razón obligatoria, sin tabla Postgres real, y con dedupe diario -- lo opuesto de lo
// que un incidente de emergencia necesita registrar.
// ---------------------------------------------------------------------------
export * from "./break-glass/index.ts";
