export type { Capa, EstadoOcupacion, FechaLocal, Ocupacion, RangoFechas, Razon, TipoConflicto } from "./tipos.ts";
export { PRECEDENCIA_RAZON } from "./tipos.ts";

export { puedeTransicionar, transicionar } from "./estados.ts";

export { calcularNoches, diaDeLaSemana, esFechaCalendario, esRangoValido, nochesDelRango, rangoCubreNoche, rangosSeSuperponen } from "./fechas.ts";

export type { EjecutorTransaccional, FilaSql } from "./ejecutor.ts";
export { bloquearOwnerStatementEnTransaccion, bloquearUnidadEnTransaccion, esViolacionExclusion } from "./ejecutor.ts";

export { RentasDomainError, ReglaComisionCanalNoConfiguradaError } from "./errors.ts";
export { CODIGO_CANAL_DIRECTO, FUENTE_COMISION_DIRECTA_POR_DEFECTO, reglaComisionPorDefecto } from "./finanzas/regla-comision-por-defecto.ts";
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
export { importarReportePagos, NOTA_AJUSTE, NOTA_SIN_RESERVA, TOLERANCIA_COMISION_BASIS_POINTS } from "./finanzas/importacion.ts";
export type { EntradaImportarPagos, LineaResultadoImportacion, ResultadoImportacion, ResultadoLineaPresentado, ResumenImportacion } from "./finanzas/importacion.ts";
export { CANALES_CON_REPORTE_CSV, LIMITES_REPORTE, parsearReportePagos } from "./finanzas/csv/index.ts";
export type { ErrorFilaReporte, LineaReporteCanal, ResultadoParseoReporte } from "./finanzas/csv/index.ts";
export { extraerDatosCanal } from "./ical/parser.ts";
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
  CATALOGO_ESCRITURA_ROLES,
  CATALOGO_LECTURA_ROLES,
  STAFF_INVITE_ROLES,
  ESCRITURA_CALENDARIO_ROLES,
  ACCESO_HUESPED_ROLES,
  PRIVACIDAD_ROLES,
  FINANZAS_ESCRITURA_ROLES,
  FINANZAS_LECTURA_ROLES,
  isRentasVerticalRole,
  LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES,
  LIMPIEZA_ASIGNAR_A_OTROS_ROLES,
  LIMPIEZA_CREACION_MANUAL_ROLES,
  LIMPIEZA_RESPONSABLE_ROLES,
  LIMPIEZA_OPERACION_ROLES,
  MENSAJERIA_ESCRITURA_ROLES,
  MENSAJERIA_LECTURA_ROLES,
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
  ConfiguracionPricingUnidad,
  DescuentoDuracionRecord,
  EmailOutboxJobRow,
  IncidenciaMantenimientoRecord,
  ItemInventarioRecord,
  MessagingOutboxChannel,
  ActualizarLineaImportadaInput,
  CandidataImportacion,
  LineaColaImportacion,
  LineaImportadaExistente,
  MotivoRevisionMovimiento,
  MovimientoEnRevision,
  NewImportacionPagosInput,
  NewLineaImportadaInput,
  OrganizacionConReservasSinMovimiento,
  OrigenMovimiento,
  ReservaSinMovimiento,
  ResultadoLineaImportacion,
  NewDescuentoDuracionInput,
  NewGuestMinimoInput,
  NewOwnerStatementInput,
  NewPayoutInput,
  NewReglaCanalPricingInput,
  NewReglaMinStayInput,
  NewReservaFinancieroInput,
  NewTarifaBaseInput,
  NewTemporadaInput,
  ReglaCanalRecord,
  TarifaBaseRecord,
  TemporadaConfigRecord,
  UpdateDescuentoDuracionInput,
  UpdateReglaCanalInput,
  UpdateReglaMinStayInput,
  UpdateTemporadaInput,
  OcupacionCalendarioItem,
  OcupacionParaCorreo,
  OcupacionParaMovimiento,
  OcupacionResumen,
  OwnerRecord,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutDetalle,
  RegistrarAuditoriaInput,
  ReglaMinStayRecord,
  RentasAuditEntityType,
  RentasAuditLogFiltro,
  RentasAuditLogPagina,
  RentasAuditLogPaginacion,
  RentasAuditLogRow,
  RentasOrganizationSummary,
  RentasPropertySummary,
  ReservaProximaCheckIn,
  TareaListFiltro,
  TareaOperativaDetalle,
  TareaOperativaRecord,
  TemporadaRecord,
  UltimaVersionOwnerStatement,
  UnidadRecord,
} from "./types.ts";

export type { RentasRepository, OcupacionCalendarioPage, OcupacionCalendarioVentana, OcupacionVentanaOpciones } from "./repository.ts";
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
  RevokeOwnerRefreshTokenInput,
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
export { BACKOFF_FEED_BASE_SEGUNDOS, BACKOFF_FEED_MAX_SEGUNDOS, calcularBackoffFeedSegundos, eventosBitacoraDeCiclo, OPCIONES_RECLAMO_POR_DEFECTO } from "./sync/lease.ts";
export type { EventoBitacora, FeedReclamado, OpcionesReclamo, ResultadoReclamo, SeveridadBitacora, TipoEventoBitacora } from "./sync/lease.ts";
export { clasificarSaludFeed, UMBRAL_FEED_DESACTUALIZADO_MS } from "./sync/monitor.ts";
export type {
  AlertaSyncRecord,
  ConflictoMonitorRecord,
  EntradaHistorialConflicto,
  EstadoConflicto,
  EstadoSaludFeed,
  FeedMonitorRecord,
  FiltroEstadoConflictos,
  HistorialConflicto,
  ListadoBitacora,
  ListadoConflictos,
  OcupacionConflictoRecord,
  ResultadoDecisionConflicto,
  ResultadoMarcarResuelto,
} from "./sync/monitor.ts";
export {
  calcularSolape,
  clasificarVigenciaSolape,
  fechaLocalEnZona,
  formatearInstanteEnZona,
  MOTIVO_CONFLICTO_MAX,
  MOTIVO_CONFLICTO_MIN,
  normalizarDecisionConflicto,
  resolverZonaHoraria,
  resumirSyncPorCanal,
} from "./sync/conflictos.ts";
export type { AccionConflicto, DecisionConflictoNormalizada, ResumenSyncCanal, VigenciaSolape } from "./sync/conflictos.ts";
export { ejecutarLoteSync } from "./sync/lote.ts";
export type { DepsLoteSync, OpcionesLoteSync, ResultadoFeedLote, ResultadoLoteSync } from "./sync/lote.ts";
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
export type { RecordatorioCheckInSummary, WithRentasRepo } from "./checkin-reminders.ts";

// ---------------------------------------------------------------------------
// Onboarding self-serve del tenant de rentas (Fase 11) -- ver src/onboarding/*.
// Cierra el gap identificado por auditoría: el repo original permite que un cliente
// nuevo se dé de alta a sí mismo (organización + primera propiedad + al menos una
// unidad + admin + configuración inicial de rentas, un solo submit). Hallazgo de
// auditoría (severidad CRÍTICA, "el onboarding self-serve de rentas está bloqueado en
// producción") -- CERRADO: `rentas.register_tenant_onboarding` (función `security
// definer`, ver `packages/domain-rentas/migrations/
// 016_onboarding_security_definer.sql`, mismo patrón que `core.accept_staff_invite`)
// ya escribe `core.organization`/`core.property`/`core.staff_user`/`core.membership`
// y el resto de `rentas.*` sin necesitar `service_role` -- ver
// apps/api/src/production/rentas-onboarding-repository.ts para el wiring real.
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
  CapturaOnboardingUnidadInput,
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

// "Chatea con tus datos" -- catalogo de rentas (ver docs/DATA-CHAT.md). Nombres explicitos: el index NO reexporta el resto del modulo.
export { buildRentasDataChatCatalog, buildRentasDataChatTools, PostgresRentasDataChatReader, ALL_RENTAS_DATA_CHAT_SQL } from "./data-chat/index.ts";
export type { RentasDataChatReader, RentasDataChatWindow } from "./data-chat/index.ts";

// ---------------------------------------------------------------------------
// Rn-03 -- reportes de ocupación e ingresos por unidad, propietario, canal y mes (con
// exportación CSV/PDF) -- ver src/reportes/*. Solo lectura, sin migración nueva.
// ---------------------------------------------------------------------------
export * from "./reportes/index.ts";

// ---------------------------------------------------------------------------
// Rn-04 -- liberación de instrucciones de acceso al huésped N horas antes del check-in,
// solo con reserva confirmada y pagada según la política (migración 025) -- ver
// src/acceso/*. El cron vive en apps/api y NO está en vercel.json (decisión de Javier).
// ---------------------------------------------------------------------------
export { correoAccesoHuesped } from "./emails/acceso-templates.ts";
export type { AccesoCorreoDatos } from "./emails/acceso-templates.ts";
export { EVENTO_OUTBOX_ACCESO, MAX_LIBERACIONES_POR_CORRIDA, ejecutarLiberacionAcceso } from "./acceso/liberacion.ts";
export type { ContextoLiberacion, ResumenLiberacionAcceso, WithLiberacionTx } from "./acceso/liberacion.ts";
export { HORAS_ANTES_MAX, HORAS_ANTES_MIN, POLITICA_ACCESO_POR_DEFECTO } from "./acceso/tipos.ts";
export type { ErrorAccesoLiberacion, EventoAccesoRecord, EventoBitacoraAcceso, EventoOmitidoAcceso, InstruccionAcceso, LiberacionPendiente, PoliticaAcceso, ReservaAccesoRecord, ResultadoAcceso, ResultadoConfirmarPago, ResumenBarridoCifrado } from "./acceso/tipos.ts";
export { validarInstruccion, validarPolitica } from "./acceso/validacion.ts";
export type { EntradaInstruccion, EntradaPolitica } from "./acceso/validacion.ts";
export type { RentasAccesoRepository } from "./acceso/repository.ts";
export { InMemoryRentasAccesoRepository } from "./acceso/in-memory-repository.ts";
export { PostgresRentasAccesoRepository } from "./acceso/postgres-repository.ts";
// Rn-29 -- cifrado en reposo de las instrucciones de acceso (AES-256-GCM en la app; llave RENTAS_ACCESS_KEY).
export { accesoAad, createAccesoCipher, parseAccesoKey, resolverCipherAcceso } from "./acceso/cipher.ts";
export type { AccesoCipher, CampoAcceso } from "./acceso/cipher.ts";
export { AccesoDescifradoError, AccesoNoDisponibleError } from "./acceso/errores.ts";
// Rn-P3-09 -- mensaje manual para la OTA y lista de accesos pendientes de entregar.
export { mensajeAccesoParaOta } from "./acceso/mensaje-ota.ts";
export type { PendienteEntregaOta, ReservaParaMensajeOta, ResultadoEntregaManual } from "./acceso/tipos.ts";
// Rn-P3-08 -- pre-check-in publico por reserva (codigo de confirmacion + ultimos 4 digitos del telefono).
export { AVISO_PRECHECKIN_VERSION, PRECHECKIN_BLOQUEO_MINUTOS, PRECHECKIN_MAX_FALLOS, PRECHECKIN_TOKEN_MINUTOS } from "./precheckin/tipos.ts";
export type { ConfigPrecheckin, EntradaCapturaDb, InfoPrecheckin, ResultadoCapturaDb, ResultadoCapturar, ResultadoPrecheckin, ResultadoVerificar, VerificacionPrecheckinDb } from "./precheckin/tipos.ts";
export { normalizarCodigo, normalizarWhatsapp, validarCaptura, validarReglamento, validarVerificacion } from "./precheckin/validacion.ts";
export type { EntradaCaptura, EntradaVerificacion, Validacion } from "./precheckin/validacion.ts";
export { claveIntento, generarToken, hashToken } from "./precheckin/claves.ts";
export { avisoPrivacidadPrecheckin, textoSugeridoPrecheckin } from "./precheckin/textos.ts";
export type { AvisoPrecheckin } from "./precheckin/textos.ts";
export { capturarPrecheckin, verificarPrecheckin } from "./precheckin/servicio.ts";
export type { RentasPrecheckinRepository } from "./precheckin/repository.ts";
export { InMemoryRentasPrecheckinRepository } from "./precheckin/in-memory-repository.ts";
export type { CapturaGuardada, ReservaPrecheckinSembrada } from "./precheckin/in-memory-repository.ts";
export { PostgresRentasPrecheckinRepository } from "./precheckin/postgres-repository.ts";

// ---- Rn-18 / Rn-19: reglas de comision de canal y catalogo (propiedades, unidades, propietarios) ----
export { InMemoryRentasCatalogoRepository } from "./catalogo/in-memory-repository.ts";
export { PostgresRentasCatalogoRepository } from "./catalogo/postgres-repository.ts";
export type { RentasCatalogoRepository } from "./catalogo/repository.ts";
export { MONEDAS_PERMITIDAS } from "./catalogo/tipos.ts";
export type {
  CanalRecordCatalogo,
  EntradaActualizarPropiedad,
  EntradaActualizarPropietario,
  EntradaActualizarReglaComision,
  EntradaActualizarUnidad,
  EntradaCrearPropiedad,
  EntradaCrearPropietario,
  EntradaCrearUnidad,
  EntradaReglaComision,
  MonedaPermitida,
  MotivoRechazoCatalogo,
  PropiedadCatalogoRecord,
  PropietarioRecord,
  ReglaComisionRecord,
  ResultadoCatalogo,
  UnidadCatalogoRecord,
} from "./catalogo/tipos.ts";
export {
  esUuid,
  esZonaHorariaIana,
  validarEntradaActualizarPropiedad,
  validarEntradaActualizarPropietario,
  validarEntradaActualizarRegla,
  validarEntradaActualizarUnidad,
  validarEntradaCrearPropiedad,
  validarEntradaCrearPropietario,
  validarEntradaCrearUnidad,
  validarEntradaRegla,
} from "./catalogo/validacion.ts";

// ---- Rn-20: correo de invitacion de staff ----
export { correoInvitacionStaff } from "./emails/staff-invite-template.ts";
export type { StaffInviteCorreo } from "./emails/staff-invite-template.ts";
export { tryEnqueueStaffInviteEmail, STAFF_INVITE_EMAIL_SAVEPOINT_NAME } from "./staff-invite-email.ts";

// ---- Rn-26: Resumen operativo (agregados sin PII) ----
export * from "./resumen/index.ts";
// Rn-24 / Rn-25 -- mensajes automaticos por evento (borradores desde plantillas aprobadas; migracion rentas 029).
export * from "./mensajes-automaticos/index.ts";

// ---- Rn-07: solicitudes ARCO propias de rentas (migracion 028) ----
export * from "./privacidad/index.ts";
