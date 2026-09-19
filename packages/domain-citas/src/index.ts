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
  RescheduleAppointmentPayload,
  ServicePatch,
  ServiceRecord,
  Slot,
} from "./types.ts";

export { AppointmentAlternativesError, AppointmentConflictError, AppointmentForbiddenError, AppointmentNotFoundError, AppointmentValidationError } from "./errors.ts";

export { computeAvailableSlots, dayOfWeekInTimeZone, isSlotWithinAvailability, zonedDateStr, zonedTimeToUtc } from "./availability.ts";
export type { ComputeAvailableSlotsInput } from "./availability.ts";

export { CITAS_ROLES, isCitasRole, PLATFORM_ROLE_BY_VERTICAL_ROLE, STAFF_INVITE_ROLES } from "./roles.ts";
export type { CitasRole } from "./roles.ts";

export { actorHash, consumeRateLimit, requestActor } from "./rate-limit.ts";

export type {
  AppointmentSyncRow,
  CancelResult,
  CitasRepository,
  CompleteResult,
  ConfirmResult,
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
  BUSY_APPOINTMENT_STATUSES,
  cancelAppointment,
  cancelAppointmentFromPanel,
  completeAppointmentFromPanel,
  confirmAppointmentFromPanel,
  createAppointment,
  createAppointmentFromPanel,
  findAppointmentsForCustomerPhone,
  isValidVoiceConversationId,
  markAppointmentNoShowFromPanel,
  normalizePhone,
  prepareCreateAppointment,
  prepareReassignAppointment,
  prepareRescheduleAppointment,
  queryAvailability,
  reassignAppointment,
  rescheduleAppointment,
  validateCancelAppointmentPayload,
  validateCreateAppointmentPayload,
  validateReassignAppointmentPayload,
  validateRescheduleAppointmentPayload,
} from "./appointments.ts";
export type { CreateAppointmentFromPanelPayload, CustomerAppointmentSummary, PreparedAppointment, PreparedReassign, PreparedReschedule, QueryAvailabilityInput, ReassignOutcome, RescheduleOutcome } from "./appointments.ts";

export { lookupCitasCustomer } from "./customers.ts";
export type { CitasCustomerContext, UpcomingAppointmentContext } from "./customers.ts";

export { acknowledgeOnlyTurnHandler } from "./whatsapp/turn-handler.ts";
export type { WhatsAppTurnHandler } from "./whatsapp/turn-handler.ts";
export { verifyMetaSignature } from "./whatsapp/meta-signature.ts";
export { extractMetaPhoneNumberId, extractMetaTextMessages, resolveOrganizationByPhoneNumberId } from "./whatsapp/channel-config.ts";
export type { MetaTextMessage } from "./whatsapp/channel-config.ts";
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
  runConfirmacionCitaCore,
  runListaEsperaCore,
  runOptimizadorCore,
  sortWaitlistByPosition,
  timeWindowFor,
  tryNotifyWaitlistOfFreedSlot,
} from "./reminders.ts";
export type { ConfirmacionCitaSummary, ListaEsperaEvent, ListaEsperaSummary, OptimizadorResult, TimeWindow } from "./reminders.ts";

// ---- Fase 6 §1 — guardia de crisis + FAQs canónicas por rubro ----
export {
  ALL_VERTICALS,
  CRISIS_ESCALATION_MESSAGE,
  CRISIS_KEYWORDS,
  detectCrisisKeyword,
  findVerticalFaqAnswer,
  getVerticalFaqs,
  normalizeForCrisisCheck,
  requiresCrisisGuardrail,
  VERTICAL_FAQS,
} from "./vertical-config.ts";
export type { Vertical, VerticalFaq } from "./vertical-config.ts";
export { runCrisisGuardrail } from "./crisis-guardrail.ts";
export type { CrisisGuardrailResult } from "./crisis-guardrail.ts";

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
