export { isoNow, assertExplicitOffset, isPast, sha256Hex, sha256Bytes, stableStringify, MEXICO_CITY_TZ, TENDER_STATUSES, isTenderStatus } from "./types.ts";
export type {
  SourceRef,
  TenderRecord,
  TenderStatus,
  ProposalRecord,
  ComplianceItemRecord,
  RequiredAnnexItem,
  CompanyDocumentRecord,
  ApprovedRateRecord,
  CompanyCapabilityRecord,
  CompanyExperienceItemRecord,
  CompanySignerRecord,
  PackageManifestRecord,
  SubmissionRecord,
  MatchingProfileRecord,
  GoNoGoDecisionRecord,
  TenderResolutionRecord,
} from "./types.ts";

export { dateOnlyToMexicoCityIso, timestampToIso, nowIso, resolveExpedienteAsOfIso } from "./dates.ts";

export { toCents, fromCents, addCents, sumCents, multiplyRateHalfUp, multiplyQuantityHalfUp, compareCents, assertValidDecimalString, MAX_QUANTITY } from "./money.ts";
export type { DecimalString } from "./money.ts";

export { integerToWords, centsToPesosWords } from "./number-to-words.ts";

export { CompanyDataService, InMemoryCompanyDataResolver, isResolved } from "./company-data.ts";
export type {
  ApprovalStatus,
  CompanyCapability,
  CompanyExperienceRecord,
  CompanyDocument,
  CompanySigner,
  ApprovedRate,
  CompanyDataResolver,
  BlockingReasonCode,
  FieldResolution,
  FieldResolutionOk,
  FieldResolutionMissing,
  FieldResolutionBlocked,
} from "./company-data.ts";

export { IntegrityChecklist } from "./integrity-checklist.ts";
export type {
  ChecklistDimension,
  ChecklistResultStatus,
  ChecklistItemResult,
  ChecklistReport,
  FileArtifact,
  FormatLimitsConfig,
  SignatureRequirement,
  IntegrityChecklistInput,
} from "./integrity-checklist.ts";

export { EconomicProposalBuilder, assertValidIvaRate, DEFAULT_MAX_IVA_RATE } from "./economic-proposal.ts";
export type {
  EconomicLineItemRequest,
  EconomicLineItemResolved,
  EconomicLineItemBlocked,
  EconomicTotals,
  EconomicProposalResult,
  EconomicProposalConfig,
} from "./economic-proposal.ts";

export { sealInputs, computeInputsHash, requireValidHashedInputs, InvalidInputsHashError } from "./sealed-inputs.ts";
export type { InputsHash, HashedInputs, ExpedienteInputs, ExpedienteInputCompanyDocument, ExpedienteInputRate, ExpedienteInputTemplate } from "./sealed-inputs.ts";

export { evaluateExpedienteApproval, ApprovalWorkflow, APPROVER_ROLES, SUBMITTER_ROLES, resetApprovalCounters } from "./approval-workflow.ts";
export type { Approval, ApprovalScope, ChangeDetected, ApprovalWorkflowSnapshot } from "./approval-workflow.ts";

export { ProposalVersionRegistry, buildProposalInputRecords } from "./proposal-version-registry.ts";
export type { ProposalVersion, ProposalInputRecord, PersistedProposalVersion } from "./proposal-version-registry.ts";

export { PackageAssembler, USER_RESPONSIBILITY_NOTICE, verifyManifest } from "./package-assembler.ts";
export type {
  PackageStatus,
  PackageDocumentInput,
  PackageManifestDocumentEntry,
  PackageManifest,
  AssembleInput,
  AssembleResult,
  ManifestVerificationMismatch,
  ManifestVerificationResult,
} from "./package-assembler.ts";

export { writePackageZip, readPackageZip, storeFile, decodeBase64Content, InvalidFileContentError, MAX_BASE64_LENGTH } from "./storage.ts";
export type { StoredFile } from "./storage.ts";

export { LICITACIONES_ROLES, isLicitacionesRole, WRITE_ROLES, DECISION_ROLES, GO_NO_GO_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE } from "./roles.ts";
export type { LicitacionesRole } from "./roles.ts";

// ---- Fase 3: matching/scoring y go/no-go ----
export { MatchingEngine, DEFAULT_WEIGHTS, normalizeText, normalizedIncludes, toOrganizationMatchingProfile, buildMatchInputsSnapshot, computeMatchInputsHash } from "./matching-engine.ts";
export type { OrganizationMatchingProfile, BudgetRange, MatchWeights, MatchResult, MatchCriterionResult, EligibilityStatus, EligibilityCriterionResult, EligibilityResult, MatchExplanationEnricher, MatchInputsSnapshot } from "./matching-engine.ts";

export { buildGoNoGoDecision } from "./go-no-go.ts";
export type { GoNoGoDecisionInput, GoNoGoDecisionToPersist } from "./go-no-go.ts";

export {
  RuleBasedExtractor,
  RequirementMatrixBuilder,
  detectConflicts,
  deriveSectionKeysFromRequirementMatrix,
  extractDeadline,
  buildMexicoCityIso,
  classifyType,
  classifyResponsibleRole,
  nextRequirementId,
  resetRequirementCounters,
  SECTION_KEY_BY_REQUIREMENT_TYPE,
} from "./requirement-matrix.ts";
export type {
  Obligatoriedad,
  RequirementType,
  RequirementStatus,
  RequirementSource,
  TopicKey,
  RequirementItem,
  ConflictKind,
  Conflict,
  TenderPageText,
  TenderDocumentText,
  RequirementExtractor,
  RequirementMatrixResult,
} from "./requirement-matrix.ts";

export { LlmRequirementExtractor, LLM_EXTRACTOR_CONFIDENCE } from "./llm-requirement-extractor.ts";
export type { LlmRequirementExtractorOptions } from "./llm-requirement-extractor.ts";

// ---- Fase 9: runner de agentes de IA con guardrails anticorrupción/no-fabricación ----
export {
  TechnicalProposalDraftAgent,
  DEFAULT_TECHNICAL_PROPOSAL_DRAFT_AGENT_ROLE,
  scanForGuardrailViolations,
  GuardrailBlockedError,
  DraftAgentRoleNotAllowedError,
  DraftAgentNoProposalError,
  DraftAgentGenerationFailedError,
  DraftApprovalRejectedError,
} from "./technical-proposal-draft-agent.ts";
export type {
  GuardrailCategory,
  GuardrailStage,
  GuardrailMatch,
  GuardrailScanResult,
  GuardrailAuditEvent,
  TechnicalProposalDraftAgentOptions,
  DraftProposalTextRequest,
  DraftSuggestion,
  ReviewProposalTextRequest,
  ReviewVerdict,
  ReviewResult,
  ApprovedDraft,
} from "./technical-proposal-draft-agent.ts";

export {
  TechnicalProposalBuilder,
  NOT_APPLICABLE_TITLE_PREFIX,
  isNotApplicableSection,
  extractNotApplicableRequirements,
} from "./technical-proposal.ts";
export type {
  ProposalStatement,
  SectionBlocker,
  ProposalSection,
  TechnicalProposal,
  RequirementFulfillmentMapping,
} from "./technical-proposal.ts";

export { IdempotencyConflictError, SubmissionDeadlineUnknownError, ReadinessStaleError, ApprovalRejectedError, GoNoGoRejectedError } from "./errors.ts";

export type {
  LicitacionesRepository,
  IdempotencyParams,
  IdempotentResult,
  RequirementItemRecord,
  RequirementFulfillmentMappingRecord,
  TenderUpsertInput,
  TenderUpsertResult,
  MatchingProfileUpsertInput,
  GoNoGoDecisionCreateInput,
} from "./repository.ts";
export { InMemoryLicitacionesRepository } from "./in-memory-repository.ts";
export { PostgresLicitacionesRepository } from "./postgres-repository.ts";

// ---- Fase 5 pieza 1: andamiaje de ingesta (REQ-004/005/146..150) ----
export { SOURCE_CONNECTOR_IDS, isSourceConnectorId, SOURCE_HEALTH_STATES, SourceNotConfiguredError, CaptchaDetectedError, InterfaceChangedError, ConnectorRegistry, LICITACIONES_CONNECTOR_REGISTRY } from "./connector-registry.ts";
export type { SourceConnectorId, SourceHealthState, SourceCadence, SourceLiveVerification, SourceConnectorKind, SourceConnectorDescriptor } from "./connector-registry.ts";
export { isSourceHealthState, classifySourceFailure, computeStaleForMs, evaluateSourceFreshness, DEFAULT_STALE_THRESHOLD_MS } from "./source-run.ts";
export type { SourceRunInput, SourceRunRecord, SourceRunEvidence, SourceFreshnessRecord } from "./source-run.ts";

// ---- Fase 5 pieza 2: historial de versiones de convocatoria (REQ-017/041/151..155) ----
export { TenderVersionRegistry, computeTenderSnapshotHash, requirementNaturalKey, toRequirementSnapshot } from "./tender-version-registry.ts";
export type {
  TenderDiffStatus,
  TenderFieldSnapshot,
  TenderFieldName,
  RequirementSnapshot,
  TenderVersionSnapshot,
  TenderFieldChange,
  TenderRequirementChange,
  TenderVersionDiff,
  TenderVersion,
  PersistedTenderVersion,
} from "./tender-version-registry.ts";
export type { TenderChangeNotificationRecord, RecordTenderVersionResult } from "./repository.ts";

// ---- Fase 6: seguimiento post-adjudicación (REQ-051..055) ----
export { CONTRACT_STATES, CONTRACT_INITIAL_STATUS, CONTRACT_TERMINAL_STATES, CONTRACT_TRANSITIONS, CONTRACT_ALERT_STATES, CONTRACT_DECISION_TRANSITIONS, isContractStatus, checkTransition } from "./contract-lifecycle.ts";
export type { ContractStatus, TransitionCheckResult } from "./contract-lifecycle.ts";

export { addBusinessDays, daysBetween as businessDaysBetween, CALENDAR_LIMITATION_NOTE } from "./business-days.ts";

export {
  LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS,
  LAASSP_ART_73_LEGAL_REFERENCE,
  computePaymentDueDate,
  classifyInvoiceStatus,
  summarizeReceivables,
} from "./contract-billing.ts";
export type { PaymentDeadlineResult, ContractInvoiceStatus, InvoiceStatusInput, ReceivableLineInput, ReceivablesTotals } from "./contract-billing.ts";

export { CONTRACT_FIELD_KEYS, extractContractFields } from "./contract-extraction.ts";
export type { ContractFieldKey, ExtractedContractField, ContractFieldPageText } from "./contract-extraction.ts";

// ---- Fase 11: pipeline real de extracción de texto de PDF (bases de licitación, propuestas, contrato firmado) ----
export { extractDocumentText, splitPersistedTextIntoPages, PAGE_BREAK } from "./text-extraction.ts";
export type { TextExtractionStatus, TextExtractionResult, ExtractedPageText, PdfBombLimit } from "./text-extraction.ts";

export {
  INCONFORMIDAD_DISCLAIMER,
  LAASSP_ART_95_INCONFORMIDAD_BUSINESS_DAYS,
  LAASSP_ART_95_INCONFORMIDAD_TRATADOS_BUSINESS_DAYS,
  LAASSP_ART_95_LEGAL_REFERENCE,
  computeInconformidadDeadline,
  buildInconformidadContent,
} from "./inconformidad.ts";
export type { InconformidadFundamento, InconformidadViability, InconformidadDeadlineResult, InconformidadContentInput, InconformidadContent } from "./inconformidad.ts";

export { NO_DISPONIBLE, OWN_PROPOSAL_STATUSES, isOwnProposalStatus, normalizeOrNoDisponible, sanitizeCriteriaComparison } from "./fallo-autopsy.ts";
export type { OwnProposalStatus, CriteriaComparisonItem } from "./fallo-autopsy.ts";

export { DEFAULT_RENEWAL_LEAD_DAYS, daysBetween as renewalDaysBetween, computeRenewalAlertCandidates, urgencyForLeadDays, computeUpcomingRenewals } from "./renewal-radar.ts";
export type { RenewalCandidateContract, RenewalAlertCandidate, RenewalUrgency, RenewalUpcomingCandidate } from "./renewal-radar.ts";

export { INCONFORMIDAD_REVIEW_ROLES } from "./roles.ts";
export { ContractTransitionRejectedError, TenderResolutionRejectedError, CompanyDataDuplicateKeyError } from "./errors.ts";

// ---- Fase 16: resolución won/lost + escritura de "datos de empresa" ----
export { TENDER_RESOLUTIONS, TENDER_RESOLVABLE_FROM_STATUSES, isTenderResolution, checkTenderResolution } from "./tender-resolution.ts";
export type { TenderResolution, TenderResolutionCheckResult } from "./tender-resolution.ts";

export type {
  ContractRecord,
  ContractStatusHistoryRecord,
  ContractMetadataUpdateInput,
  ContractTransitionInput,
  ContractDocumentRecord,
  ContractExtractedFieldRecord,
  AddContractDocumentInput,
  ConfirmContractExtractedFieldInput,
  ContractInvoiceRecord,
  CreateContractInvoiceInput,
  ReceivablesSummary,
  InconformidadDraftRecord,
  CreateInconformidadDraftInput,
  FalloAutopsyRecord,
  CreateFalloAutopsyInput,
  CompanyLessonLearnedRecord,
  RenewalAlertRecord,
  ScanRenewalAlertsInput,
  ScanRenewalAlertsResult,
  TenderResolutionCreateInput,
  CompanyDataApprovalStatus,
  CompanyDocumentCreateInput,
  CompanyDocumentUpdateInput,
  ApprovedRateCreateInput,
  ApprovedRateUpdateInput,
  CompanyCapabilityCreateInput,
  CompanyCapabilityUpdateInput,
  CompanyExperienceCreateInput,
  CompanyExperienceUpdateInput,
  CompanySignerCreateInput,
  CompanySignerUpdateInput,
} from "./repository.ts";

// ---- Fase 8: ingesta automática real (compras_mx_historico) + recordatorios de plazo ----
export { createComprasMxHistoricoConnector, mapComprasMxHistoricoRow, COMPRAS_MX_HISTORICO_ID } from "./connectors/compras-mx-historico.ts";
export { streamCsvRows, parseCsv } from "./connectors/csv.ts";
export type { CsvRowEvent, CsvDataRow, CsvRowError, CsvParseResult } from "./connectors/csv.ts";
export { assertLegitimateCsvBody } from "./connectors/response-classifier.ts";
export type { LicitacionesSourceConnector, TenderSourceIngestCandidate, DiscoverParams, ConnectorContext, ConnectorLogger, DroppedRowInfo } from "./connectors/types.ts";
export type { TenderSourceIngestResult, TenderDeadlineReminderRecord, ScanDeadlineRemindersInput, ScanDeadlineRemindersResult } from "./repository.ts";

// ---- Fase 10: despacho proactivo real (correo) de alertas ----
export type { EmailOutboxJobRow, OrganizationNotificationRecipient, OverdueContractInvoiceAlert } from "./repository.ts";
export { sendEmailOutboxJob, dispatchPendingEmailJobs, MAX_EMAIL_DISPATCH_ATTEMPTS } from "./email-dispatch.ts";
export type { ResendConfig, EmailDispatchSummary } from "./email-dispatch.ts";
export {
  enqueueDeadlineReminderEmailsCore,
  enqueueRenewalAlertEmailsCore,
  enqueueOverdueInvoiceEmailsCore,
  tryEnqueueDeadlineReminderEmails,
  tryEnqueueRenewalAlertEmails,
  tryEnqueueOverdueInvoiceEmails,
} from "./alert-notifications.ts";
export type { AlertEmailEnqueueResult } from "./alert-notifications.ts";
