export { isoNow, assertExplicitOffset, isPast, sha256Hex, sha256Bytes, stableStringify, MEXICO_CITY_TZ } from "./types.ts";
export type {
  SourceRef,
  TenderRecord,
  ProposalRecord,
  ComplianceItemRecord,
  RequiredAnnexItem,
  CompanyDocumentRecord,
  ApprovedRateRecord,
  PackageManifestRecord,
  SubmissionRecord,
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

export { LICITACIONES_ROLES, isLicitacionesRole, WRITE_ROLES, DECISION_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE } from "./roles.ts";
export type { LicitacionesRole } from "./roles.ts";

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

export { IdempotencyConflictError, SubmissionDeadlineUnknownError, ReadinessStaleError, ApprovalRejectedError } from "./errors.ts";

export type { LicitacionesRepository, IdempotencyParams, IdempotentResult, RequirementItemRecord, RequirementFulfillmentMappingRecord } from "./repository.ts";
export { InMemoryLicitacionesRepository } from "./in-memory-repository.ts";
export { PostgresLicitacionesRepository } from "./postgres-repository.ts";
