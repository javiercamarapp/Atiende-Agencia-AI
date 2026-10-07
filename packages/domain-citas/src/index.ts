export type {
  AppointmentActorChannel,
  AppointmentRecord,
  AppointmentSource,
  AppointmentStatus,
  AvailabilityOverride,
  AvailabilityOverrideInput,
  AvailabilityRule,
  AvailabilityRulePatch,
  BusyInterval,
  CalendarAccountSyncStatus,
  CancelAppointmentPayload,
  CitasAuditEntityType,
  CitasAuditLogFiltro,
  CitasAuditLogPagina,
  CitasAuditLogPaginacion,
  CitasAuditLogRow,
  CreateAppointmentPayload,
  CustomerRecord,
  GoogleSyncStatus,
  NewAvailabilityRuleInput,
  NewProviderInput,
  NewServiceInput,
  ProviderCalendarAccountRecord,
  ProviderPatch,
  ProviderRecord,
  ReassignAppointmentPayload,
  RegistrarCitasAuditoriaInput,
  RescheduleAppointmentPayload,
  ServicePatch,
  ServiceRecord,
  Slot,
} from "./types.ts";

export { AppointmentAlternativesError, AppointmentConflictError, AppointmentForbiddenError, AppointmentNotFoundError, AppointmentValidationError } from "./errors.ts";

export { computeAvailableSlots, dayOfWeekInTimeZone, isSlotWithinAvailability, zonedDateStr, zonedTimeToUtc } from "./availability.ts";
export type { ComputeAvailableSlotsInput } from "./availability.ts";

export {
  AGENTE_CONFIG_POR_OMISION,
  AGENTE_LIMITES,
  PHONE_NUMBER_ID_RE,
  TONOS_AGENTE_CITAS,
  TONO_ETIQUETAS,
  TONO_INSTRUCCION,
  configAgenteDesdeFila,
  diferenciasConfigAgente,
  estadoConexion,
  fotoConfigAgente,
  reglasComoLista,
  validarConfigAgente,
  validarPhoneNumberId,
} from "./whatsapp/agent-config.ts";
export type {
  AgenteConfigGuardado,
  ConectarNumeroResultado,
  DesconectarNumeroResultado,
  DiferenciaCampoAgente,
  EstadoConexionWhatsapp,
  TonoAgenteCitas,
  WhatsappAgentConfig,
  WhatsappAgentConfigRecord,
  WhatsappConnection,
} from "./whatsapp/agent-config.ts";
export { previewPromptAgente, reglasDelNegocioBlock } from "./whatsapp/llm-turn-handler.ts";
export { eventoRecordatorioFallido } from "./notification-events.ts";
export type { EventoRecordatorioFallido, MotivoRecordatorioFallido, SeveridadNotificacion } from "./notification-events.ts";
export { CITAS_ROLES, DATA_CHAT_ROLES, isCitasRole, PLATFORM_ROLE_BY_VERTICAL_ROLE, STAFF_INVITE_ROLES } from "./roles.ts";
export type { CitasRole } from "./roles.ts";

export { actorHash, consumeRateLimit, requestActor } from "./rate-limit.ts";

export type {
  AppointmentSyncRow,
  CalendarSyncIssuesSummary,
  CancelResult,
  CitasRepository,
  CompleteResult,
  ConfirmResult,
  CustomerConfirmResult,
  ConnectProviderCalendarAccountInput,
  ConversationMessage,
  CreateAppointmentResult,
  CreateFromPanelResult,
  CustomerPage,
  EmailOutboxJobRow,
  EmergencyEscalationInput,
  EmergencyEscalationRecord,
  MessagingOutboxRow,
  NewAppointmentFromPanelInput,
  NewAppointmentInput,
  NoShowResult,
  ReassignResult,
  ReminderCandidateRow,
  RescheduleResult,
  RetryCalendarSyncResult,
  TenantConfigPatch,
  TenantConfigRecord,
  WaitlistCandidateRow,
} from "./repository.ts";
export { InMemoryCitasRepository } from "./in-memory-repository.ts";
export { PostgresCitasRepository } from "./postgres-repository.ts";

// ---- Fase 3 — sincronización con Google Calendar (ver diseño §3-§8) ----
export {
  assertGoogleCalendarPortContract,
  CalendarEventNotFoundError,
  exchangeGoogleAuthorizationCode,
  FakeGoogleCalendarPort,
  GoogleCalendarApiError,
  isInvalidGrantError,
  RealGoogleCalendarPort,
} from "./google-calendar-port.ts";
export type {
  CalendarEventResult,
  CreateEventInput,
  DeleteEventInput,
  ExchangeAuthorizationCodeInput,
  ExchangeAuthorizationCodeResult,
  GoogleCalendarPort,
  RealGoogleCalendarPortConfig,
  UpdateEventInput,
} from "./google-calendar-port.ts";
export { createGoogleCalendarPortResolver } from "./google-calendar-factory.ts";
export type { GoogleOAuthPlatformConfig } from "./google-calendar-factory.ts";
export {
  MAX_SYNC_ATTEMPTS,
  nextSyncBackoffMs,
  sanitizeProviderSyncReason,
  SYNC_BATCH_SIZE,
  syncPendingAppointments,
  syncPendingAppointmentsMultiProvider,
  tryTriggerCalendarSync,
  tryTriggerGoogleSync,
} from "./calendar-sync.ts";
export type { ResolveCalendarPort, ResolveCalendarSyncPort, ResolvedCalendarSync, SyncSummary } from "./calendar-sync.ts";
export { createCalendarSyncPortResolver } from "./calendar-sync-resolver-factory.ts";
export type { CalendarSyncPortResolverFactories } from "./calendar-sync-resolver-factory.ts";
export { OAUTH_STATE_TTL_MS, signGoogleCalendarOAuthState, verifyGoogleCalendarOAuthState } from "./google-calendar-oauth-state.ts";
export type { GoogleCalendarOAuthState } from "./google-calendar-oauth-state.ts";

export {
  assertCustomerOwnsAppointment,
  BUSY_APPOINTMENT_STATUSES,
  cancelAppointment,
  cancelAppointmentFromPanel,
  completeAppointmentFromPanel,
  confirmAppointmentFromPanel,
  createAppointment,
  createAppointmentFromPanel,
  findAppointmentsForCustomerPhone,
  isUsablePhone,
  isValidVoiceConversationId,
  markAppointmentNoShowFromPanel,
  normalizePhone,
  prepareCreateAppointment,
  prepareReassignAppointment,
  prepareRescheduleAppointment,
  queryAvailability,
  reassignAppointment,
  rescheduleAppointment,
  retryAppointmentCalendarSyncFromPanel,
  validateCancelAppointmentPayload,
  validateCreateAppointmentPayload,
  validateReassignAppointmentPayload,
  validateRescheduleAppointmentPayload,
} from "./appointments.ts";
export type { CreateAppointmentFromPanelPayload, CustomerAppointmentSummary, PreparedAppointment, PreparedReassign, PreparedReschedule, QueryAvailabilityInput, ReassignOutcome, RescheduleOutcome } from "./appointments.ts";

export { lookupCitasCustomer, updateCustomerEmailFromPanel } from "./customers.ts";
export type { CitasCustomerContext, UpcomingAppointmentContext } from "./customers.ts";

export { acknowledgeOnlyTurnHandler } from "./whatsapp/turn-handler.ts";
export type { WhatsAppTurnHandler } from "./whatsapp/turn-handler.ts";
export { verifyMetaSignature } from "./whatsapp/meta-signature.ts";
export { computeCitasResumen, RESUMEN_HORIZONTE_PENDIENTES_DIAS, RESUMEN_VENTANA_DIAS } from "./resumen.ts";
export type { CitasResumen, ResumenPorEstado } from "./resumen.ts";
export { computeOnboardingChecklist, evaluarReservaPublica } from "./onboarding.ts";
export type { ChecklistOnboarding, PasoOnboarding, PasoOnboardingEstado, PasoOnboardingId, ReservaPublicaEvaluacion } from "./onboarding.ts";
export { isUrgentCancellationMessage } from "./whatsapp/urgent-cancellation.ts";
export { appointmentReminderButtons, buildAppointmentButtonId, parseAppointmentButtonId } from "./whatsapp/appointment-button-ids.ts";
export type { AppointmentButtonAction } from "./whatsapp/appointment-button-ids.ts";
export { formatAppointmentWhen, resolveAppointmentButton } from "./whatsapp/appointment-buttons.ts";
export type { AppointmentButtonOutcome } from "./whatsapp/appointment-buttons.ts";
export { extractMetaInboundMessages, extractMetaPhoneNumberId, extractMetaTextMessages, resolveOrganizationByPhoneNumberId } from "./whatsapp/channel-config.ts";
export type { MetaInboundMessage, MetaInteractiveReply, MetaTextMessage } from "./whatsapp/channel-config.ts";
export { createDefaultConversationGuard, handleInboundWhatsAppMessage, redactSensitiveInfo } from "./whatsapp/inbound.ts";
export type { CitasConversationGuard, InboundMessageOutcome } from "./whatsapp/inbound.ts";
export { createCitasMessagingOutboxPort } from "./whatsapp/outbox-adapter.ts";
export {
  APPOINTMENT_HARD_RULES,
  createLlmWhatsAppTurnHandler,
  currentDateContext,
  FALLBACK_CONFIG,
  getAgentConfig,
  providerFailureReply,
  saludoSegunHora,
  TOOLS,
  verticalFaqsBlock,
} from "./whatsapp/llm-turn-handler.ts";
export type { WhatsAppLlmAgentConfig, WhatsAppLlmAgentOptions } from "./whatsapp/llm-turn-handler.ts";

export {
  DEFAULT_LISTA_ESPERA_LIMIT,
  MAX_LISTA_ESPERA_LIMIT,
  MAX_WAITLIST_NOTIFICATIONS,
  notifyWaitlistAfterReschedule,
  previewListaEspera,
  runConfirmacionCitaCore,
  runListaEsperaCore,
  runOptimizadorCore,
  sortWaitlistByPosition,
  timeWindowFor,
  tryNotifyWaitlistOfFreedSlot,
} from "./reminders.ts";
export type { ConfirmacionCitaSummary, ListaEsperaEvent, ListaEsperaPreview, ListaEsperaSummary, OptimizadorResult, TimeWindow } from "./reminders.ts";

// ---- Fase 6 §1 — guardia de crisis + FAQs canónicas por rubro ----
export {
  ALL_VERTICALS,
  CRISIS_ESCALATION_MESSAGE,
  CRISIS_KEYWORDS,
  CRISIS_VOICE_MESSAGE,
  crisisGuardActivaPara,
  detectCrisisKeyword,
  findVerticalFaqAnswer,
  getVerticalFaqs,
  normalizeForCrisisCheck,
  requiresCrisisGuardrail,
  VERTICAL_FAQS,
} from "./vertical-config.ts";
export type { Vertical, VerticalFaq } from "./vertical-config.ts";
export { registrarEscalacionCrisis, runCrisisGuardrail } from "./crisis-guardrail.ts";
export type { CrisisGuardrailResult, EntradaEscalacionCrisis } from "./crisis-guardrail.ts";

// ---- Fase 6 §2 — CalendarSyncPort genérico + adaptadores Cal.com/CalDAV ----
export { assertAvailabilityContract, assertCalendarSyncPortContract, CalendarCapabilityUnsupportedError, CalendarConflictError, FakeCalendarSyncPort, GoogleCalendarSyncAdapter, isRangeBookable, rangesOverlap } from "./calendar-sync-port.ts";
export type {
  AvailabilityInterval,
  AvailabilityKind,
  AvailabilityQuery,
  AvailabilityResult,
  CalendarEventResult as GenericCalendarEventResult,
  CalendarPlatform,
  CalendarSyncPort,
  CreateCalendarEventInput,
  DeleteCalendarEventInput,
  UpdateCalendarEventInput,
} from "./calendar-sync-port.ts";
export { CalComApiError, RealCalComPort } from "./calcom-port.ts";
export type { CalComEventType, CalComPortConfig } from "./calcom-port.ts";
export { buildVEventIcs, IcsBuildError, IcsParseError, parseVEventIcs } from "./caldav-ics.ts";
export type { ParsedVEvent, VEventDraft } from "./caldav-ics.ts";
export { CalDavApiError, RealCalDavPort } from "./caldav-port.ts";
export type { CalDavPortConfig } from "./caldav-port.ts";
export { crearValidadorUrlCaldav } from "./net/validar-url-caldav.ts";
export type { MotivoRechazoUrlCaldav, ResolverDns, ResultadoValidacionUrlCaldav } from "./net/validar-url-caldav.ts";
export type {
  CalendarProviderSyncStatus,
  ConnectProviderCalComAccountInput,
  ConnectProviderCalDavAccountInput,
  ProviderCalComAccountRecord,
  ProviderCalDavAccountRecord,
} from "./repository.ts";

// C-16 -- centro de avisos (seguimiento de escalaciones de crisis, resumen para notificaciones).
export { ESCALACION_SEGUIMIENTO_DESTINOS } from "./repository.ts";
export type {
  AvisosResumenSistema,
  EscalacionSeguimientoDestino,
  EscalacionSeguimientoEstado,
  EscalacionesPage,
  EscalacionVista,
  RecordatorioEntregaFila,
  SetEscalacionSeguimientoResult,
} from "./repository.ts";

// ---- Fase 6 §3 — notificaciones por correo (plantillas + dispatcher fail-closed) ----
export { escapeHtml, renderCorreo } from "./emails/layout.ts";
export type { EtiquetaPlantilla, FilaPlantilla, SeccionPlantilla } from "./emails/layout.ts";
export { correoCitaCancelada, correoCitaCreada, correoCitaModificada, correoCitaReagendada, correoCitaRecordatorio } from "./emails/appointment-templates.ts";
export type { CitaCorreo, CitaReagendadaCorreo, Correo } from "./emails/appointment-templates.ts";
export { correoInvitacionStaff } from "./emails/staff-invite-template.ts";
export type { StaffInviteCorreo, StaffInviteVerticalRole } from "./emails/staff-invite-template.ts";
export { enqueueAppointmentEmailCore, tryEnqueueAppointmentEmail } from "./appointment-email-notifications.ts";
export type { AppointmentEmailEvent, AppointmentEmailExtra, AppointmentEmailResult } from "./appointment-email-notifications.ts";
export { dispatchPendingEmailJobs, MAX_EMAIL_DISPATCH_ATTEMPTS, sendEmailOutboxJob } from "./email-dispatch.ts";
export type { EmailDispatchSummary, ResendConfig } from "./email-dispatch.ts";

// C-02 -- derechos ARCO (migrations/024_citas_data_rights.sql).
export {
  ARCO_MENU_REPLY,
  ARCO_THIRD_PARTY_REPLY,
  DATA_RIGHT_LABEL,
  DATA_RIGHT_OPEN_STATUSES,
  DATA_RIGHT_STAFF_TARGET_STATUSES,
  DATA_RIGHT_STATUSES,
  DATA_RIGHT_TYPES,
  DATA_RIGHTS_EXECUTION_DAYS,
  DATA_RIGHTS_RESPONSE_DAYS,
  dataRightsDeadlineState,
  dataRightsFolio,
} from "./data-rights.ts";
export type {
  ConfirmDataRightsOutcome,
  DataRightsDeadlineState,
  DataRightsEventRow,
  DataRightsPaginacion,
  DataRightsRequestRow,
  DataRightsRequestsFiltro,
  DataRightsRequestsPage,
  DataRightStaffTargetStatus,
  DataRightStatus,
  DataRightType,
  RegisterDataRightsOutcome,
  UpdateDataRightsStatusResult,
} from "./data-rights.ts";
export { detectArcoConfirmation, detectArcoIntent, normalizeArcoText, runArcoFastPath } from "./arco-intent.ts";
export type { ArcoConfirmationIntent, ArcoFastPathResult, ArcoIntent } from "./arco-intent.ts";

// C-04 -- mensajes de WhatsApp editables (migrations/026_citas_whatsapp_mensajes_config.sql).
export {
  ANTICIPACION_POR_OMISION_HORAS,
  MENSAJE_ETIQUETAS,
  MENSAJE_KINDS,
  MENSAJE_LIMITES,
  MENSAJES_CONFIG_POR_OMISION,
  VALORES_DE_MUESTRA,
  VARIABLES_BASE,
  configDesdeFoto,
  dentroDelHorarioDeEnvio,
  diferenciasConfigMensajes,
  fotoConfigMensajes,
  horaLocal,
  legacyReminderBody,
  mensajeActivo,
  plantillaEfectiva,
  previewMensajes,
  renderizarMensaje,
  sanitizarValor,
  textoPorOmision,
  textoPropio,
  validarConfigMensajes,
  validarTextoMensaje,
  variablesDe,
  ventanaDeRecordatorio,
} from "./whatsapp/message-config.ts";
export type {
  DiferenciaCampo,
  MensajeConfigGuardado,
  MensajeKind,
  ValoresMensaje,
  VariableMensaje,
  VistaPreviaMensaje,
  WhatsappMessageConfig,
  WhatsappMessageConfigHistoryEntry,
  WhatsappMessageConfigRecord,
} from "./whatsapp/message-config.ts";
export { armarMensaje, enqueueAppointmentWhatsappCore, formatearFechaYHora, resolverValoresCita, tryEnqueueAppointmentWhatsapp } from "./whatsapp/message-send.ts";
export type { AppointmentWhatsappEvent, AppointmentWhatsappResult } from "./whatsapp/message-send.ts";

// ---- C-10 -- "Chatea con tus datos" de citas (ver docs/DATA-CHAT.md) ----
export { ALL_CITAS_DATA_CHAT_SQL, buildCitasDataChatCatalog, buildCitasDataChatTools, CitasDataChatUnavailableError, PostgresCitasDataChatReader } from "./data-chat/index.ts";
export type { CitasDataChatReader, CitasDataChatWindow } from "./data-chat/index.ts";

// PL-31 -- ventana de 24 h de Meta y plantillas HSM por organizacion para los avisos proactivos.
export { VENTANA_SEGURA_MS, armarParametrosPlantilla, decidirEnvioProactivo, encolarCorreoListaEspera, variantesTelefonoEntrante } from "./whatsapp/proactivo.ts";
export type { DecisionProactivo, PlantillaParaEncolar, PlantillaWhatsappAprobada } from "./whatsapp/proactivo.ts";
export { EVENTOS_PLANTILLA_CITAS, PLANTILLA_ESTADOS, PLANTILLA_IDIOMA_RE, PLANTILLA_MAX_VARIABLES, PLANTILLA_NOMBRE_RE, eventoPlantillaCitas, validarPlantillaWhatsapp } from "./whatsapp/plantillas.ts";
export type { EstadoPlantillaWhatsapp, EventoPlantillaCitas, PlantillaWhatsappInput, PlantillaWhatsappRecord, ResultadoValidacionPlantilla } from "./whatsapp/plantillas.ts";

// ---- C-11 -- bandeja de conversaciones de WhatsApp con handoff a humano (migracion 031) ----
export {
  ConversacionesConflictoError,
  ConversacionesNoDisponibleError,
  ConversacionesRechazadaError,
  ConversacionesValidacionError,
  HANDOFF_ESTADOS,
  HandoffYaTomadoError,
  InMemoryConversacionesRepository,
  InMemoryHandoffAgentGate,
  NOTA_MAX,
  PostgresConversacionesRepository,
  PostgresHandoffAgentGate,
  RESPUESTA_MAX,
  SinNumeroWhatsappError,
} from "./conversaciones/index.ts";
export type {
  BandejaFiltro,
  BandejaItem,
  BandejaPagina,
  ConversacionDetalle,
  ConversacionesLectura,
  ConversacionesRepository,
  ConversacionSemilla,
  HandoffAgentGate,
  HandoffDetalle,
  HandoffEstado,
  InMemoryConversacionesOptions,
  MensajeConversacion,
  NotaInterna,
} from "./conversaciones/index.ts";

// ---- Agente de VOZ de citas sobre @atiende/voice-core (VOZ-CIT) ----
// El simulador y sus guiones es-MX se importan desde `@atiende/domain-citas/voz/simulador` (solo pruebas y la prueba ciega manual).
export { FRANJAS_LISTA_ESPERA, MAX_LISTA_ESPERA_ACTIVAS_POR_TELEFONO, enrollInWaitlist } from "./waitlist-enrollment.ts";
export type { FranjaListaEspera, InsertWaitlistResult, NewWaitlistEntryInput, WaitlistEnrollment, WaitlistEnrollmentPayload } from "./waitlist-enrollment.ts";
export * from "./voz/index.ts";
