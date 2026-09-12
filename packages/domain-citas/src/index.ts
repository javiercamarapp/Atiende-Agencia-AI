export type {
  AppointmentActorChannel,
  AppointmentRecord,
  AppointmentSource,
  AppointmentStatus,
  AvailabilityOverride,
  AvailabilityRule,
  BusyInterval,
  CancelAppointmentPayload,
  CreateAppointmentPayload,
  CustomerRecord,
  ProviderRecord,
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
  CancelResult,
  CitasRepository,
  ConversationMessage,
  CreateAppointmentResult,
  NewAppointmentInput,
  ReminderCandidateRow,
  RescheduleResult,
  WaitlistCandidateRow,
} from "./repository.ts";
export { InMemoryCitasRepository } from "./in-memory-repository.ts";
export { PostgresCitasRepository } from "./postgres-repository.ts";

export {
  BUSY_APPOINTMENT_STATUSES,
  cancelAppointment,
  cancelAppointmentFromPanel,
  createAppointment,
  findAppointmentsForCustomerPhone,
  isValidVoiceConversationId,
  normalizePhone,
  prepareCreateAppointment,
  prepareRescheduleAppointment,
  queryAvailability,
  rescheduleAppointment,
  validateCancelAppointmentPayload,
  validateCreateAppointmentPayload,
  validateRescheduleAppointmentPayload,
} from "./appointments.ts";
export type { CustomerAppointmentSummary, PreparedAppointment, PreparedReschedule, QueryAvailabilityInput, RescheduleOutcome } from "./appointments.ts";

export { lookupCitasCustomer } from "./customers.ts";
export type { CitasCustomerContext, UpcomingAppointmentContext } from "./customers.ts";

export { acknowledgeOnlyTurnHandler } from "./whatsapp/turn-handler.ts";
export type { WhatsAppTurnHandler } from "./whatsapp/turn-handler.ts";
export { verifyMetaSignature } from "./whatsapp/meta-signature.ts";
export { extractMetaPhoneNumberId, extractMetaTextMessages, resolveOrganizationByPhoneNumberId } from "./whatsapp/channel-config.ts";
export type { MetaTextMessage } from "./whatsapp/channel-config.ts";
export { createDefaultConversationGuard, handleInboundWhatsAppMessage, redactSensitiveInfo } from "./whatsapp/inbound.ts";
export type { CitasConversationGuard, InboundMessageOutcome } from "./whatsapp/inbound.ts";
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
