export type {
  AppointmentActorChannel,
  AppointmentRecord,
  AppointmentSource,
  AppointmentStatus,
  AvailabilityOverride,
  AvailabilityRule,
  BusyInterval,
  CalendarAccountSyncStatus,
  CancelAppointmentPayload,
  CreateAppointmentPayload,
  CustomerRecord,
  GoogleSyncStatus,
  ProviderCalendarAccountRecord,
  ProviderRecord,
  ReassignAppointmentPayload,
  RescheduleAppointmentPayload,
  ServiceRecord,
  Slot,
} from "./types.ts";

export { AppointmentAlternativesError, AppointmentConflictError, AppointmentNotFoundError, AppointmentValidationError } from "./errors.ts";

export { computeAvailableSlots, dayOfWeekInTimeZone, isSlotWithinAvailability, zonedDateStr, zonedTimeToUtc } from "./availability.ts";
export type { ComputeAvailableSlotsInput } from "./availability.ts";

export { CITAS_ROLES, isCitasRole, PLATFORM_ROLE_BY_VERTICAL_ROLE } from "./roles.ts";
export type { CitasRole } from "./roles.ts";

export { actorHash, consumeRateLimit, requestActor } from "./rate-limit.ts";

export type {
  AppointmentSyncRow,
  CancelResult,
  CitasRepository,
  ConnectProviderCalendarAccountInput,
  ConversationMessage,
  CreateAppointmentResult,
  CustomerPage,
  MessagingOutboxRow,
  NewAppointmentInput,
  ReassignResult,
  ReminderCandidateRow,
  RescheduleResult,
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
export { MAX_SYNC_ATTEMPTS, nextSyncBackoffMs, SYNC_BATCH_SIZE, syncPendingAppointments, tryTriggerGoogleSync } from "./calendar-sync.ts";
export type { ResolveCalendarPort, SyncSummary } from "./calendar-sync.ts";
export { OAUTH_STATE_TTL_MS, signGoogleCalendarOAuthState, verifyGoogleCalendarOAuthState } from "./google-calendar-oauth-state.ts";
export type { GoogleCalendarOAuthState } from "./google-calendar-oauth-state.ts";

export {
  BUSY_APPOINTMENT_STATUSES,
  cancelAppointment,
  cancelAppointmentFromPanel,
  createAppointment,
  findAppointmentsForCustomerPhone,
  isValidVoiceConversationId,
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
export type { CustomerAppointmentSummary, PreparedAppointment, PreparedReassign, PreparedReschedule, QueryAvailabilityInput, ReassignOutcome, RescheduleOutcome } from "./appointments.ts";

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
} from "./whatsapp/llm-turn-handler.ts";
export type { WhatsAppLlmAgentConfig, WhatsAppLlmAgentOptions } from "./whatsapp/llm-turn-handler.ts";

export {
  MAX_WAITLIST_NOTIFICATIONS,
  notifyWaitlistAfterReschedule,
  runConfirmacionCitaCore,
  runOptimizadorCore,
  timeWindowFor,
  tryNotifyWaitlistOfFreedSlot,
} from "./reminders.ts";
export type { ConfirmacionCitaSummary, OptimizadorResult, TimeWindow } from "./reminders.ts";
