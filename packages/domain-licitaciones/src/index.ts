export { isoNow, assertExplicitOffset, isPast, sha256Hex, sha256Bytes, stableStringify, MEXICO_CITY_TZ } from "./types.ts";
export type {
  SourceRef,
  TenderRecord,
  ProposalRecord,
  ComplianceItemRecord,
  RequiredAnnexItem,
  CompanyDocumentRecord,
  ApprovedRateRecord,
  ExpedienteApprovalRecord,
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

export { evaluateExpedienteApproval } from "./expediente-approval.ts";
export type { Approval, ApprovalScope } from "./expediente-approval.ts";

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

export { IdempotencyConflictError, SubmissionDeadlineUnknownError, ReadinessStaleError } from "./errors.ts";

export type { LicitacionesRepository, IdempotencyParams, IdempotentResult } from "./repository.ts";
export { InMemoryLicitacionesRepository } from "./in-memory-repository.ts";
export { PostgresLicitacionesRepository } from "./postgres-repository.ts";
