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
  isValidVoiceConversationId,
  normalizePhone,
  prepareCreateAppointment,
  prepareRescheduleAppointment,
  rescheduleAppointment,
  validateCancelAppointmentPayload,
  validateCreateAppointmentPayload,
  validateRescheduleAppointmentPayload,
} from "./appointments.ts";
export type { PreparedAppointment, PreparedReschedule, RescheduleOutcome } from "./appointments.ts";

export {
  MAX_WAITLIST_NOTIFICATIONS,
  notifyWaitlistAfterReschedule,
  runConfirmacionCitaCore,
  runOptimizadorCore,
  timeWindowFor,
  tryNotifyWaitlistOfFreedSlot,
} from "./reminders.ts";
export type { ConfirmacionCitaSummary, OptimizadorResult, TimeWindow } from "./reminders.ts";
