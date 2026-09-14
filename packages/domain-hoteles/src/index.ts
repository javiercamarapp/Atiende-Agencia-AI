export {
  CHARGE_CONCEPTS,
  computeChargeAmounts,
  computeNoShowPenaltyAmounts,
  evaluateNoShowPenaltyBase,
  evaluateDiscountAuthorization,
  evaluateFolioClose,
  assertRoomChargeIdentityVerified,
  ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY,
} from "./folioEngine.ts";
export type {
  ChargeConcept,
  ChargeCalcInput,
  ChargeCalcResult,
  NoShowPenaltyCalcInput,
  NoShowReservationInput,
  DiscountAuthorizationInput,
  DiscountAuthorizationResult,
  RoomChargeIdentityClaim,
  RoomChargeIdentityVerificationInput,
  RoomChargeIdentityVerificationResult,
  FolioCloseReason,
  FolioCloseInput,
  FolioCloseResult,
} from "./folioEngine.ts";

// ---- Fase 3 — máquina de estados de reservas (H02) ----
export {
  RESERVATION_STATUSES,
  isReservationStatus,
  canTransition,
  isCancellable,
  isModifiable,
  rolesAllowedForTransition,
  canRolePerformTransition,
  evaluateCancellation,
} from "./reservationStateMachine.ts";
export type {
  ReservationStatus,
  CancellationPolicyConfig,
  CancellationEvaluationInput,
  CancellationEvaluationResult,
} from "./reservationStateMachine.ts";

export { applyTaxes, assertValidTaxConfig } from "./taxes.ts";
export type { TaxConfig, TaxBreakdown } from "./taxes.ts";

export { roundCurrency } from "./money.ts";

export {
  looksLikeAllergyDeclaration,
  resolveAllergyDeclared,
  canAssureDishIsSafe,
  assertCanAssureDishIsSafe,
  describeSafetyAssuranceMessage,
  AllergySafetyAssuranceBlockedError,
} from "./fnbAllergyGuard.ts";
export type { AllergyDeclaredVia, ResolveAllergyDeclaredInput, ResolveAllergyDeclaredResult, FnbOrderSafetyState } from "./fnbAllergyGuard.ts";

export { QuoteError, QuoteInputValidationError, parseQuoteInput, computeQuote, nightsBetween } from "./quote.ts";
export type { NightlyRate, QuoteInput, QuoteNightBreakdown, Quote } from "./quote.ts";

export { occupancyPct, effectiveCapacity, canBook } from "./overbooking.ts";
export type { OverbookingConfig } from "./overbooking.ts";

export {
  HOTEL_ROLES,
  isHotelRole,
  MONEY_ROLES,
  ADMIN_ROLES,
  TOMAR_PEDIDO_ROLES,
  CONFIRMAR_COCINA_ROLES,
  MANAGE_RESERVATIONS_ROLES,
  PLATFORM_ROLE_BY_VERTICAL_ROLE,
  FRAUD_SCAN_ROLES,
  FRAUD_VIEW_ROLES,
  FRAUD_RESOLVER_ROLES,
  CFDI_HOSPEDAJE_ROLES,
  NIGHT_AUDIT_ROLES,
  MAINTENANCE_TICKET_CREATE_ROLES,
  MAINTENANCE_TICKET_MANAGE_ROLES,
  HOUSEKEEPING_SHIFT_PUBLISH_ROLES,
  ATTENDANCE_ADMIN_ROLES,
  REVENUE_GATE_MANAGE_ROLES,
  REVENUE_AUTOPILOT_APPROVAL_ROLES,
  REVENUE_BACKTEST_ROLES,
  PL_ROLES,
  REPUTACION_SUBMIT_ROLES,
  REPUTACION_VIEW_ROLES,
  REPUTACION_ACTION_RESOLVE_ROLES,
} from "./roles.ts";
export type { HotelRole } from "./roles.ts";

export { IdempotencyConflictError, FraudAlertAlreadyResolvedError } from "./errors.ts";

// ---- Fase 5 — H16-014/REQ-REC-014: fraude interno (SOLO los 2 patrones que operan
// sobre folioEngine.ts ya portado; ver domain-hoteles/src/fraude/deteccion.ts para
// el alcance completo) ----
export { FRAUD_PATTERNS, recipientRolesForPattern, detectDiscountOutsidePolicy, detectFolioReopenedAfterAudit } from "./fraude/deteccion.ts";
export type { FraudPattern, FraudFinding, DiscountPolicyInput, FolioReopenInput } from "./fraude/deteccion.ts";
export type { FraudAlertRecord, FraudAlertStatus, NewFraudAlertInput, DiscountChargeForFraudScan, ReopenedFolioChargeForFraudScan } from "./types.ts";

// ---- Fase 5 — H5/REQ-BO-001/002: CFDI de hospedaje ----
export {
  RFC_PUBLICO_GENERAL,
  RFC_GENERICO_EXTRANJERO,
  resolveReceptorHospedaje,
  ReceptorHospedajeInvalidoError,
  summarizeFacturableCharges,
  computeDsa,
  computeCfdiHospedajeBreakdown,
  TIPO_RELACION_APLICACION_ANTICIPO,
  validateAnticipoRelacion,
  validarCfdiHospedaje,
} from "./cfdi/reglas-fiscales-hospedaje.ts";
export type {
  ReceptorHospedajeInput,
  ReceptorHospedajeResult,
  CargoFacturable,
  ResumenCargosFacturables,
  DesgloseCfdiHospedaje,
  AnticipoRelacionInput,
  DatosCfdiHospedaje,
  ResultadoValidacionCfdiHospedaje,
} from "./cfdi/reglas-fiscales-hospedaje.ts";
export type { CfdiEmisionRecord, CfdiEmisionTipo, CfdiEmisionStatus, NewCfdiEmisionInput, HospedajeFiscalConfig } from "./types.ts";

export type { PaymentsPort, PaymentChargeInput, PaymentChargeResult } from "./payments-port.ts";
export { InMemoryPaymentsPort } from "./payments-port.ts";

export type {
  FolioStatus,
  FolioCloseReason as FolioRecordCloseReason,
  PaymentMethod,
  PaymentStatus,
  ChargeRecord,
  PaymentRecord,
  FolioRecord,
  NewChargeInput,
  NewPaymentInput,
  FnbOrderItem,
  FnbOrderRecord,
  NewFnbOrderInput,
  TaxConfigRecord,
  NightlyRateRecord,
  GuestIdentity,
  ReservationRecord,
  NewReservationInput,
  CancellationPolicyRecord,
} from "./types.ts";

export type { HotelesRepository, IdempotencyParams, IdempotentResult, MessagingOutboxRow } from "./repository.ts";
export { InMemoryHotelesRepository } from "./in-memory-repository.ts";
export { PostgresHotelesRepository } from "./postgres-repository.ts";

// ---- Fase 2 — Server Tools de voz + agente de WhatsApp con LLM real ----
export type { ConversationMessage, ContactoNoOperativoRecord, ContactoNoOperativoSource, NewContactoNoOperativoInput, VoiceAgentConfig, WhatsAppPropertyRoute } from "./types.ts";

export { actorHash, requestActor, consumeRateLimit } from "./rate-limit.ts";
export { registerContactoNoOperativo } from "./contacto-no-operativo.ts";

export { verifyMetaSignature } from "./whatsapp/meta-signature.ts";
export { extractMetaTextMessages, extractMetaPhoneNumberId, resolvePropertyByPhoneNumberId } from "./whatsapp/channel-config.ts";
export type { MetaTextMessage } from "./whatsapp/channel-config.ts";
export type { HotelesWhatsAppTurnHandler } from "./whatsapp/turn-handler.ts";
export { acknowledgeOnlyTurnHandler } from "./whatsapp/turn-handler.ts";
export { handleInboundWhatsAppMessage, redactSensitiveInfo } from "./whatsapp/inbound.ts";
export type { InboundMessageOutcome } from "./whatsapp/inbound.ts";
export { createHotelesMessagingOutboxPort } from "./whatsapp/outbox-adapter.ts";
export {
  createLlmHotelesWhatsAppTurnHandler,
  TOOLS as WHATSAPP_HOTELES_TOOLS,
  FALLBACK_CONFIG as WHATSAPP_HOTELES_FALLBACK_CONFIG,
  getAgentConfig as getWhatsAppHotelesAgentConfig,
  providerFailureReply as whatsappHotelesProviderFailureReply,
} from "./whatsapp/llm-turn-handler.ts";
export type { WhatsAppHotelesAgentConfig, WhatsAppHotelesLlmAgentOptions } from "./whatsapp/llm-turn-handler.ts";

// ---- Fase 6 — H5/REQ-REV-013: night audit propio (capa pura, extiende folioEngine.ts) ----
export {
  planNightlyHospedajeCharges,
  buildNightAuditSummary,
  businessDateToClose,
  localHour,
  isPastNightAuditRunHour,
  DEFAULT_PROPERTY_TIMEZONE,
} from "./night-audit/engine.ts";
export type {
  InHouseReservationForNightAudit,
  NightAuditAnomalyType,
  NightAuditAnomaly,
  NightAuditChargeDecision,
  NightAuditHospedajePlan,
  NightAuditSummary,
} from "./night-audit/engine.ts";
export type { NightAuditRunRecord, NightAuditRunStatus, ActiveHotelProperty } from "./types.ts";

// ---- Fase 7 — descubrimiento de organización/property para el panel web de staff ----
export type { HotelOrganizationSummary, PropertySummary } from "./types.ts";

// ---- Fase 6 — REQ-HK-008: turnos de camaristas/lavandería (LFT, puro) ----
export {
  classifyShiftType,
  shiftDurationMinutes,
  ordinaryDailyLimitMinutes,
  validateTurnosLft,
  assertTurnosLftPublishable,
  TurnosLftViolationError,
  DEFAULT_WEEKLY_HOUR_LIMIT_SCHEDULE,
} from "./housekeeping/turnos-lft.ts";
export type {
  ShiftType,
  ProposedShift,
  WeeklyHourLimitMilestone,
  ShiftLftViolationType,
  ShiftLftViolation,
  ValidateTurnosLftInput,
  ValidateTurnosLftResult,
} from "./housekeeping/turnos-lft.ts";
export type { HousekeepingShiftRecord, NewHousekeepingShiftInput } from "./types.ts";

// ---- Fase 6 — REQ-HK-011: tickets de mantenimiento ----
export type {
  MaintenanceTicketRecord,
  MaintenanceTicketOrigin,
  MaintenanceTicketSeverity,
  MaintenanceTicketStatus,
  NewMaintenanceTicketInput,
} from "./types.ts";

// ---- Fase 8 — REQ-BO-024 (LFT art.132 fr.XXXIV): checador de asistencia
// inalterable + cruce contra el horario programado, puro (sin I/O) ----
export { pairAttendanceEvents, crossCheckAttendance, buildStpsAttendanceCsv } from "./checador/attendance.ts";
export type {
  AttendanceEventType,
  AttendanceEvent,
  AttendanceSchedule,
  AttendanceShift,
  AttendanceAnomaly,
  AttendanceCrossCheckStatus,
  AttendanceCrossCheckResult,
  CrossCheckAttendanceInput,
  StpsExportRow,
} from "./checador/attendance.ts";
export type {
  AttendanceEventRecord,
  NewAttendanceEventInput,
  StaffScheduleRecord,
  NewStaffScheduleInput,
} from "./types.ts";

// ---- Fase 9 — REQ-REV-003/004/005/007: motor de revenue management (pricing) ----
export {
  REVENUE_GATE_STATES,
  MIN_SHADOW_DAYS,
  PROPONE_VARIATION_PCT_MIN,
  PROPONE_VARIATION_PCT_MAX,
  RevenueGateError,
  daysElapsed,
  hasMetMinimumShadowPeriod,
  isPromotion,
  isDemotion,
  evaluateGateTransition,
  assertValidProponeVariationPct,
  isPriceChangeWithinProponeLimit,
  evaluateRevenueProposal,
} from "./revenue/revenueEngineGate.ts";
export type {
  RevenueGateState,
  PromotionContext,
  GateTransitionEvaluation,
  RevenueProposalCheck,
} from "./revenue/revenueEngineGate.ts";

export { buildWalkForwardWindows, evaluateWalkForwardBacktest } from "./revenue/walkForwardBacktest.ts";
export type {
  CounterfactualMethod,
  DailyPricingRecord,
  WalkForwardWindowSpec,
  WalkForwardWindow,
  WindowEvaluation,
  WalkForwardBacktestInput,
  WalkForwardBacktestResult,
} from "./revenue/walkForwardBacktest.ts";

export {
  PriceExplanationError,
  assertValidPriceRecommendationInput,
  explainPriceRecommendation,
} from "./revenue/priceRecommendationExplainer.ts";
export type {
  PickupFactor,
  CompsetFactor,
  EventoFactor,
  TipoCambioFactor,
  PriceFactor,
  PriceFactorKind,
  PriceRecommendationInput,
  ExplainedFactor,
  PriceDirection,
  PriceRecommendationExplanation,
} from "./revenue/priceRecommendationExplainer.ts";

export {
  PARITY_MODES,
  ParityGuardError,
  assertValidParityChannelConfig,
  assertValidParityGuardConfig,
  computeParityFloor,
  evaluateParityGuard,
} from "./revenue/parity-guard.ts";
export type {
  ParityMode,
  ParityChannelConfig,
  ParityGuardConfig,
  ParityChannelViolation,
  ParityCheckResult,
} from "./revenue/parity-guard.ts";

export { BenchmarkGuardError, assertBenchmarkQueryAllowed } from "./revenue/compsetGuard.ts";
export type { BenchmarkQueryRequest } from "./revenue/compsetGuard.ts";

// ---- Fase 10 — REQ-BO-010 (P0): back-office financiero, P&L USALI + punto de
// equilibrio dinámico (capa pura). Forecast de 90 días y proyección de caja a 13
// semanas DELIBERADAMENTE fuera de esta fase -- ver header de
// `pl/usaliPL.ts`/`migrations/012_pl_usali.sql`. ----
export {
  USALI_REVENUE_DEPARTMENTS,
  USALI_UNDISTRIBUTED_DEPARTMENTS,
  USALI_ALL_DEPARTMENTS,
  USALI_EXPENSE_CATEGORIES,
  buildDepartmentalStatements,
  buildUsaliPL,
  computeDynamicBreakeven,
  buildOwnersReport,
} from "./pl/usaliPL.ts";
export type {
  UsaliRevenueDepartment,
  UsaliUndistributedDepartment,
  UsaliDepartment,
  UsaliExpenseCategory,
  DepartmentRevenueRow,
  DepartmentExpenseRow,
  DepartmentStatement,
  UndistributedRow,
  UsaliPL,
  BuildUsaliPLInput,
  DynamicBreakevenInput,
  DynamicBreakevenResult,
  OwnersReportKpis,
  OwnersReportInput,
  OwnersReport,
} from "./pl/usaliPL.ts";
export type {
  ExpenseEntryRecord,
  NewExpenseEntryInput,
  PlRevenueByDateRow,
  PlExpenseByDateRow,
  PlOccupiedRoomNightsByDateRow,
} from "./types.ts";

// ---- Fase 11 — REQ-CRM-002/003 (P1/F): reputación/CRM. Clasificador de reseñas por
// tema + sentimiento (dominio puro, ninguna dependencia de Google/Booking API -- ver
// header de reputacion/clasificador.ts), decisión de acción reglada (ticket de
// mantenimiento / mensaje proactivo / compensación reglada), e índice de reputación
// agregado (reputacion/indice.ts). Modelo de datos en migrations/013_reputacion.sql.
// Ingesta automática real desde Google/Booking/TripAdvisor y la orquestación de
// `apps/api` que ejecutaría cada acción quedan deliberadamente FUERA de esta fase
// (ver README.md §Fase 11 y el comentario de cabecera de la migración). ----
export {
  KNOWN_REVIEW_TOPICS,
  TOPIC_KEYWORDS,
  TICKET_TOPICS,
  COMPENSATION_CATALOG,
  normalizar as normalizarTextoResena,
  detectarTemas,
  analizarSentimiento,
  decidirAcciones,
  clasificarResena,
} from "./reputacion/clasificador.ts";
export type {
  KnownReviewTopic,
  ReviewTopicId,
  TopicMatch,
  SentimentLabel,
  SentimentResult,
  StayState,
  CompensacionPropuesta,
  AccionReputacion,
  DecidirAccionesInput,
  ClasificarResenaInput,
  ResultadoClasificacion,
} from "./reputacion/clasificador.ts";

export { SENTIMENT_LABELS, calcularIndiceReputacion } from "./reputacion/indice.ts";
export type {
  ResenaClasificadaParaIndice,
  TemaAgregado,
  IndiceReputacion,
  CalcularIndiceReputacionOptions,
} from "./reputacion/indice.ts";

export type {
  GuestReviewSource,
  GuestReviewStayState,
  GuestReviewSentiment,
  GuestReviewTopicRecord,
  GuestReviewRecord,
  NewGuestReviewInput,
  GuestReviewActionType,
  GuestReviewActionStatus,
  GuestReviewActionRecord,
  NewGuestReviewActionInput,
} from "./types.ts";
