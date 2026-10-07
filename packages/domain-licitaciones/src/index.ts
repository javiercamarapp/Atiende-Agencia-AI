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

export { computeCompanyProfileHash } from "./company-profile-hash.ts";
export type { CompanyProfileSnapshot } from "./company-profile-hash.ts";
export { sealInputs, computeInputsHash, requireValidHashedInputs, InvalidInputsHashError } from "./sealed-inputs.ts";
export type { InputsHash, HashedInputs, ExpedienteInputs, ExpedienteInputCompanyDocument, ExpedienteInputRate, ExpedienteInputTemplate } from "./sealed-inputs.ts";

export { evaluateExpedienteApproval, evaluateExpedienteStages, isExpedienteApprovalStage, EXPEDIENTE_APPROVAL_STAGES, ApprovalWorkflow, APPROVER_ROLES, SUBMITTER_ROLES, resetApprovalCounters } from "./approval-workflow.ts";
export type { Approval, ApprovalScope, ChangeDetected, ApprovalWorkflowSnapshot, ExpedienteApprovalStage, ExpedienteStageEvaluation } from "./approval-workflow.ts";

export { ProposalVersionRegistry, buildProposalInputRecords } from "./proposal-version-registry.ts";
export type { ProposalVersion, ProposalInputRecord, PersistedProposalVersion } from "./proposal-version-registry.ts";

export { PackageAssembler, USER_RESPONSIBILITY_NOTICE, verifyManifest, verifyZipAgainstStoredManifest } from "./package-assembler.ts";
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

export { LICITACIONES_ROLES, isLicitacionesRole, WRITE_ROLES, DECISION_ROLES, GO_NO_GO_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE, STAFF_INVITE_ROLES } from "./roles.ts";
export type { LicitacionesRole } from "./roles.ts";

export { correoInvitacionStaff } from "./emails/staff-invite-template.ts";

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

// ---- L-04: sala de guerra por convocatoria + preguntas de la junta de aclaraciones ----
export {
  WAR_ROOM_ITEM_KINDS,
  WAR_ROOM_ITEM_STATUSES,
  WAR_ROOM_SEVERITIES,
  WAR_ROOM_ENTRY_KINDS,
  SEMAPHORE_RED_HOURS,
  SEMAPHORE_YELLOW_HOURS,
  SalaGuerraValidationError,
  SalaGuerraNotAvailableError,
  isUuid,
  parseWarRoomItemCreate,
  parseWarRoomItemPatch,
  parseWarRoomEntryCreate,
  deadlineSemaphore,
  worstSemaphore,
  isItemClosed,
  buildWarRoomBoard,
} from "./sala-guerra.ts";
export type {
  WarRoomItemKind,
  WarRoomItemStatus,
  WarRoomSeverity,
  WarRoomEntryKind,
  WarRoomItemRecord,
  WarRoomEntryRecord,
  WarRoomItemCreateInput,
  WarRoomItemPatch,
  SemaphoreColor,
  SemaphoreState,
  DeadlineSemaphore,
  WarRoomBoardItem,
  WarRoomBoardSummary,
  WarRoomBoard,
  BuildWarRoomBoardInput,
} from "./sala-guerra.ts";
export {
  JUNTA_QUESTION_STATUSES,
  JUNTA_QUESTION_TOPICS,
  JUNTA_QUESTION_PRIORITIES,
  JUNTA_QUESTION_TRANSITIONS,
  SIMILARITY_THRESHOLD,
  JuntaQuestionDuplicateError,
  JuntaQuestionRejectedError,
  questionTokens,
  questionDedupeKey,
  questionSimilarity,
  findSimilarQuestions,
  suggestQuestionPriority,
  sortJuntaQuestions,
  parseQuestionCapture,
  parseQuestionPatch,
  parseJuntaConfig,
  parseTransitionRequest,
  canTransitionQuestion,
  assertQuestionTransition,
  assertQuestionEditable,
  buildJuntaSummary,
} from "./junta-aclaraciones.ts";
export type {
  JuntaQuestionStatus,
  JuntaQuestionTopic,
  JuntaQuestionPriority,
  JuntaQuestionRecord,
  JuntaConfigRecord,
  JuntaQuestionReminderRecord,
  JuntaQuestionCreateInput,
  JuntaQuestionRejectionCode,
  SimilarQuestion,
  PrioritySuggestion,
  ParsedQuestionCapture,
  JuntaQuestionPatch,
  JuntaConfigInput,
  JuntaTransitionRequest,
  JuntaSummary,
} from "./junta-aclaraciones.ts";
export { PostgresSalaGuerraRepository, InMemorySalaGuerraRepository } from "./sala-guerra-repository.ts";
export type { SalaGuerraRepository, ScanJuntaRemindersInput, ScanJuntaRemindersResult, InMemorySalaGuerraOptions } from "./sala-guerra-repository.ts";
export { JuntaQuestionDraftAgent, DEFAULT_JUNTA_QUESTION_AGENT_ROLE, MAX_DRAFT_QUESTIONS, extractFigures, findFabricatedFigures } from "./junta-question-draft-agent.ts";
export type { DraftJuntaQuestionsRequest, JuntaQuestionDraftProposal, RejectedJuntaQuestionDraft, JuntaQuestionDraftResult } from "./junta-question-draft-agent.ts";

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

export { IdempotencyConflictError, SubmissionDeadlineUnknownError, ReadinessStaleError, ApprovalRejectedError, ExpedienteStageNotAvailableError, GoNoGoRejectedError, TenantConfigNotMigratedError } from "./errors.ts";

export type {
  LicitacionesRepository,
  IdempotencyParams,
  IdempotentResult,
  RequirementItemRecord,
  RequirementFulfillmentMappingRecord,
  TenderUpsertInput,
  TenderUpsertResult,
  TenderPage,
  MatchingProfileUpsertInput,
  GoNoGoDecisionCreateInput,
  LicitacionesTenantConfigRecord,
  LicitacionesTenantConfigPatch,
} from "./repository.ts";
export { InMemoryLicitacionesRepository } from "./in-memory-repository.ts";
export { PostgresLicitacionesRepository, dateColumnToExplicitOffsetIso } from "./postgres-repository.ts";

// ---- Fase 5 pieza 1: andamiaje de ingesta (REQ-004/005/146..150) ----
export { SOURCE_CONNECTOR_IDS, isSourceConnectorId, SOURCE_HEALTH_STATES, SourceNotConfiguredError, CaptchaDetectedError, InterfaceChangedError, RateLimitedError, SourceUnavailableError, ConnectorRegistry, LICITACIONES_CONNECTOR_REGISTRY } from "./connector-registry.ts";
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
export type { TenderChangeNotificationRecord, RecordTenderVersionResult, TenderAuditLogEntry, TenderAuditLogPage } from "./repository.ts";

// ---- Fase 6: seguimiento post-adjudicación (REQ-051..055) ----
export { CONTRACT_STATES, CONTRACT_INITIAL_STATUS, CONTRACT_TERMINAL_STATES, CONTRACT_TRANSITIONS, CONTRACT_ALERT_STATES, CONTRACT_DECISION_TRANSITIONS, CONTRACT_STEP_UP_TRANSITIONS, isContractStatus, checkTransition } from "./contract-lifecycle.ts";
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

// L-23 -- regimen legal por fecha de convocatoria; L-24 -- registro normativo versionado.
export {
  LAASSP_2025_ENTRADA_EN_VIGOR,
  LAASSP_2000_PLAZO_PAGO_DIAS_NATURALES,
  PlazoRegimenNoVerificableError,
  resolveRegimenLegal,
  computePaymentDueDateByRegime,
  computeInconformidadDeadlineByRegime,
  buildInconformidadContentByRegime,
} from "./regimen-legal.ts";
export type { RegimenLegalId, RegimenFuente, RegimenLegalResolucion, PaymentDeadlineByRegimeResult, InconformidadDeadlineByRegime } from "./regimen-legal.ts";
export { NORMAS_LICITACIONES, fichaNormaPorId, fichasParaCita, extraerCitasNormativas } from "./normas.ts";
export {
  PROVENANCE_ENTITIES,
  PROVENANCE_SOURCES,
  PROVENANCE_REQUIRED_ENTITIES,
  PRODUCT_SERVICE_KINDS,
  LOCATION_KINDS,
  RESTRICTION_KINDS,
  STAKEHOLDER_KINDS,
  ProvenanceIndex,
  normalizeParticipationPct,
} from "./company-profile.ts";
export type {
  CompanyProfileRecord,
  CompanyProductServiceRecord,
  CompanyLocationRecord,
  CompanyRestrictionRecord,
  CompanyStakeholderRecord,
  FieldProvenanceRecord,
  ProvenanceEntity,
  ProvenanceSource,
  ProductServiceKind,
  LocationKind,
  RestrictionKind,
  StakeholderKind,
  ProfileApprovalStatus,
} from "./company-profile.ts";
export { InMemoryCompanyProfileStore } from "./company-profile-memory.ts";
export { loadCompanyMatchingContext, matchingAsOfDate } from "./company-matching-context.ts";
export type { CompanyMatchingContext } from "./matching-engine.ts";
export { FULFILLMENT_MAPPING_KINDS, PROFILE_MAPPING_KINDS } from "./technical-proposal.ts";
export type { FulfillmentMappingKind } from "./technical-proposal.ts";
export { estratificarMipyme, isMipymeSector, MIPYME_SECTORES, MIPYME_FICHA_ID } from "./mipyme.ts";
export type { MipymeSector, MipymeEstrato, MipymeInput, MipymeResultado } from "./mipyme.ts";
export type { NormaFicha, NormaLey, NormaEstadoVerificacion, NormaVigencia, NormaCitaEnCodigo } from "./normas.ts";

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
export { ContractTransitionRejectedError, TenderResolutionRejectedError, CompanyDataDuplicateKeyError, CompanyDataNotFoundError, CompanyProfileNotAvailableError } from "./errors.ts";

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
  CompanyItemKind,
  CompanyItemDecision,
  CompanyItemDecisionOutcome,
  CompanyItemDecisionInput,
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
  CompanyProfileUpsertInput,
  CompanyProductServiceCreateInput,
  CompanyProductServiceUpdateInput,
  CompanyLocationCreateInput,
  CompanyLocationUpdateInput,
  CompanyRestrictionCreateInput,
  CompanyRestrictionUpdateInput,
  CompanyStakeholderCreateInput,
  CompanyStakeholderUpdateInput,
  CompanyProfileCollectionKind,
} from "./repository.ts";

// ---- Fase 8: ingesta automática real (compras_mx_historico) + recordatorios de plazo ----
export { createComprasMxHistoricoConnector, mapComprasMxHistoricoRow, COMPRAS_MX_HISTORICO_ID } from "./connectors/compras-mx-historico.ts";
export { streamCsvRows, parseCsv } from "./connectors/csv.ts";
export type { CsvRowEvent, CsvDataRow, CsvRowError, CsvParseResult } from "./connectors/csv.ts";
export { assertLegitimateCsvBody, assertLegitimateJsonBody } from "./connectors/response-classifier.ts";
export type { LicitacionesSourceConnector, TenderSourceIngestCandidate, DiscoverParams, ConnectorContext, ConnectorLogger, DroppedRowInfo } from "./connectors/types.ts";
export type { TenderSourceIngestResult, TenderDeadlineReminderRecord, ScanDeadlineRemindersInput, ScanDeadlineRemindersResult } from "./repository.ts";

// ---- Fase 9: conectores OCDS de licitaciones VIGENTES (Nuevo León / CDMX) + agregador comercial ----
export { mapOcdsReleaseToCandidate, isVigenteTender, isDroppedResult } from "./connectors/ocds/map-ocds-release.ts";
export type { MapOcdsReleaseResult, MapOcdsReleaseOptions } from "./connectors/ocds/map-ocds-release.ts";
export type { OcdsRelease, OcdsRecord, OcdsReleasePackage, OcdsRecordPackage, OcdsTender, OcdsItem, OcdsClassification, OcdsAmount, OcdsPeriod, OcdsOrganizationReference } from "./connectors/ocds/types.ts";
export { createNlOcdsConnector, NL_OCDS_ID } from "./connectors/ocds/nl-ocds-connector.ts";
export { createCdmxOcdsConnector, CDMX_OCDS_ID } from "./connectors/ocds/cdmx-ocds-connector.ts";
export { mapCdmxCsvRow, parsePropuestasFechaToDeadline, CDMX_CSV_HEADER } from "./connectors/ocds/map-cdmx-csv-row.ts";
export { createAggregatorConnector, mapAggregatorItem, AGGREGATOR_ID } from "./connectors/aggregator.ts";
export type { AggregatorTenderItem, AggregatorPageResponse, AggregatorConnectorConfig } from "./connectors/aggregator.ts";

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

// "Chatea con tus datos": catalogo cerrado de herramientas de solo lectura (ver docs/DATA-CHAT.md).
export * from "./data-chat/index.ts";

// ---- L-05: WhatsApp (avisos de plazos/convocatorias/fallos y decision go/no-go por boton) ----
export {
  DECISION_TOKEN_TTL_HOURS,
  OPT_IN_CONFIRMED_BODY,
  OPT_OUT_CONFIRMED_BODY,
  WHATSAPP_BUTTON_PREFIX,
  WHATSAPP_TOPICS,
  WhatsAppNotAvailableError,
  WhatsAppValidationError,
  buildDecisionReplyBody,
  buildDecisionRequestMessage,
  buildNoticeMessage,
  buttonIdForToken,
  generateActionToken,
  normalizePhoneE164,
  parseActionButtonId,
  parseOptKeyword,
  phoneFromMeta,
  sha256TokenHash,
} from "./whatsapp.ts";
export type { GeneratedActionToken, NoticeKind, OptKeyword, OutboxWhatsAppPayload, TenderSummaryForMessage, TokenConsumeResult, WhatsAppDecisionAction, WhatsAppTopic } from "./whatsapp.ts";
export { InMemoryWhatsAppRepository, PostgresWhatsAppRepository, createLicitacionesMessagingOutboxPort } from "./whatsapp-repository.ts";
export type {
  ActiveContact,
  InMemoryWhatsAppOutboxRow,
  IssueTokenInput,
  TokenConsumeOutcome,
  WhatsAppContactInput,
  WhatsAppContactRecord,
  WhatsAppContactStatus,
  WhatsAppEventRecord,
  WhatsAppRepository,
} from "./whatsapp-repository.ts";
export { enqueueDeadlineReminderWhatsApp, enqueueTenderNotices, requestGoNoGoDecisionsByWhatsApp } from "./whatsapp-service.ts";
export type { DecisionRequestInput, DecisionRequestResult, NoticeInput } from "./whatsapp-service.ts";
export { computeLiveGoNoGoMatch } from "./go-no-go-live.ts";
export type { LiveGoNoGoMatchSnapshot } from "./go-no-go-live.ts";

// L-08 -- KYC negativo contra la lista 69-B del SAT (proveedores y competidores).
export {
  KYC_MAX_BATCH,
  KYC_MAX_PARTIES,
  KYC_ROLES,
  KYC_SITUACIONES,
  KycNotAvailableError,
  KycRateLimitError,
  KycValidationError,
  armarConsultaResultado,
  armarFichasResultado,
  clasificarSituacion,
  isKycRole,
  isKycSituacion,
  normalizeRfc,
  parseNombreFicha,
  parseRfc,
  parseRfcBatch,
  splitRfcText,
} from "./kyc-69b.ts";
export type {
  Kyc69bSituacion,
  KycConsultaFila,
  KycConsultaResultado,
  KycFicha,
  KycFichaConSemaforo,
  KycFichasResultado,
  KycRfcTipo,
  KycRole,
  KycSemaforo,
  KycSemaforoInfo,
  RfcValido,
} from "./kyc-69b.ts";
export { InMemoryKyc69bRepository, PostgresKyc69bRepository } from "./kyc-69b-repository.ts";
export type { Kyc69bRepository, KycConsultaBitacora, KycFichaInput, KycListaEstado, KycListaFixture, KycListaFixtureFila } from "./kyc-69b-repository.ts";

// ---- L-22: calendario de días inhábiles ----
export {
  DIAS_INHABILES_COBERTURA_OFICIAL,
  DIAS_INHABILES_OFICIALES,
  DIAS_INHABILES_SUGERIDOS,
  DIAS_INHABILES_TIME_ZONE,
  DIAS_INHABILES_VALIDACION_NOTE,
  DiaInhabilDuplicateError,
  DiaInhabilNotAvailableError,
  DiaInhabilValidationError,
  buildCalendarioPlazos,
  calendarioAvisos,
  countBusinessDaysBetween,
  describirPlazo,
  isBusinessDay,
  isValidDateOnly,
  mensajeRecordatorioPlazo,
  mexicoCityDateKey,
  nextBusinessDayOnOrAfter,
  officialOnlyCalendar,
  parseDiaInhabilCreate,
} from "./dias-inhabiles.ts";
export type {
  BuildCalendarioInput,
  CalendarioPlazos,
  DiaInhabil,
  DiaInhabilAlcance,
  DiaInhabilCreateInput,
  DiaInhabilRecord,
  DiaInhabilSugerido,
  DiaInhabilVerificacion,
  PlazoDescripcion,
} from "./dias-inhabiles.ts";
export { calendarNoteOf, holidayDatesOf } from "./business-days.ts";
export type { DiasInhabilesInput } from "./business-days.ts";
export { InMemoryDiasInhabilesRepository, PostgresDiasInhabilesRepository } from "./dias-inhabiles-repository.ts";
export type { DiasInhabilesRepository } from "./dias-inhabiles-repository.ts";

// L-25: gate final de la sala de guerra (funcion pura) y L-29: bitacora por convocatoria (mezcla pura).
export { evaluarGateSalaGuerra, buildCuentaRegresiva, resolveGateTimeZone, GATE_HOLGURA_HORAS, GATE_DEFAULT_TIME_ZONE } from "./gate-sala-guerra.ts";
export type { GateColor, GateConditionId, GateLink, GateCondition, GateZipCheck, GatePackageInput, GateApprovalsInput, GateSalaGuerraInput, GateCuentaRegresiva, GateSalaGuerraResult } from "./gate-sala-guerra.ts";
export { BITACORA_FUENTES, BITACORA_DEFAULT_LIMIT, BITACORA_MAX_LIMIT, isBitacoraFuente, buildBitacoraEventos, paginarBitacora } from "./bitacora-convocatoria.ts";
export type { BitacoraFuente, BitacoraEvento, BitacoraFuentes, BitacoraFiltros, BitacoraPagina } from "./bitacora-convocatoria.ts";

// L-30/L-32: lecturas/escrituras de sistema para los avisos de la campana y el re-tamizado KYC (migracion 034).
export { PostgresAvisosSistemaRepository } from "./avisos-sistema-repository.ts";
export type { AvisosSistemaRepository, KycRetamizadoOrganizacion, KycRetamizadoResultado } from "./avisos-sistema-repository.ts";

// L-27: post-adjudicacion estructurada (garantias, hitos, convenios modificatorios, plazos de firma/entrega; migracion 035).
export {
  CONVENIO_TIPOS,
  GARANTIA_ESTADOS,
  GARANTIA_ESTADOS_DE_DECISION,
  GARANTIA_POR_VENCER_DIAS,
  GARANTIA_TIPOS,
  GARANTIA_TRANSICIONES,
  HITO_ESTADOS,
  PLAZOS_POST_ADJUDICACION_NORMA_ID,
  PLAZOS_POST_ADJUDICACION_NOTA,
  PostAdjudicacionForbiddenError,
  PostAdjudicacionNotAvailableError,
  PostAdjudicacionNotFoundError,
  PostAdjudicacionStateError,
  PostAdjudicacionValidationError,
  assertGarantiaTransicion,
  calcularPlazos,
  evaluarGarantia,
  evaluarHito,
  isAlertaTipo,
  isGarantiaEstado,
  isGarantiaFinal,
  isGarantiaTipo,
  isHitoEstado,
  parseConvenioInput,
  parseDeltaCents,
  parseGarantiaInput,
  parseGarantiaPatch,
  parseHitoInput,
  parseHitoPatch,
  parseMontoCents,
  parsePlazosInput,
  parsePorcentajeBp,
  resumirPostAdjudicacion,
  sumarAjustesDeMonto,
} from "./post-adjudicacion.ts";
export type {
  BitacoraEntrada,
  ContractPlazos,
  Convenio,
  ConvenioInput,
  ConvenioTipo,
  Garantia,
  GarantiaEstado,
  GarantiaInput,
  GarantiaPatch,
  GarantiaTipo,
  GarantiaVigencia,
  Hito,
  HitoEstado,
  HitoInput,
  HitoPatch,
  HitoVigencia,
  PlazosCalculados,
  PlazosInput,
  PostAdjudicacionAlertaCandidata,
  PostAdjudicacionAlertaTipo,
  ResumenPostAdjudicacion,
  Responsable,
} from "./post-adjudicacion.ts";
export { InMemoryPostAdjudicacionRepository, PostgresPostAdjudicacionRepository } from "./post-adjudicacion-repository.ts";
export type { GarantiaCreate, InMemoryPostAdjudicacionOptions, PostAdjudicacionActor, PostAdjudicacionRepository } from "./post-adjudicacion-repository.ts";
export { AUDIT_ENTITIES, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT, isAuditEntity, sanitizeCorrelationId, newCorrelationId, pickAuditFields, appendAuditoria, listAuditoria } from "./audit-trail.ts";
export type { AuditEntity, AuditTrailInput, AuditTrailEntry, AuditTrailFilters, AuditTrailPage } from "./audit-trail.ts";
