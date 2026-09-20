// PostgresLicitacionesRepository — adaptador de producción de
// `LicitacionesRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que consume
// `core-auth/src/middleware.ts`). Ejecuta las queries reales contra el
// esquema `licitaciones` de migrations/001-003 (RLS real vía
// `licitaciones.can_access_org`/`can_write_org`/`can_decide_org`).
import { createHash } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import { CompanyDataDuplicateKeyError, CompanyDataNotFoundError, ContractTransitionRejectedError, IdempotencyConflictError, TenderResolutionRejectedError } from "./errors.ts";
import { checkTenderResolution } from "./tender-resolution.ts";
import type {
  ApprovedRateCreateInput,
  ApprovedRateUpdateInput,
  CompanyCapabilityCreateInput,
  CompanyCapabilityUpdateInput,
  CompanyDocumentCreateInput,
  CompanyDocumentUpdateInput,
  CompanyExperienceCreateInput,
  CompanyExperienceUpdateInput,
  CompanySignerCreateInput,
  CompanySignerUpdateInput,
  GoNoGoDecisionCreateInput,
  IdempotencyParams,
  IdempotentResult,
  LicitacionesRepository,
  MatchingProfileUpsertInput,
  RecordTenderVersionResult,
  TenderChangeNotificationRecord,
  TenderResolutionCreateInput,
  TenderPage,
  TenderUpsertInput,
  TenderUpsertResult,
} from "./repository.ts";
import type {
  AddContractDocumentInput,
  CompanyLessonLearnedRecord,
  ConfirmContractExtractedFieldInput,
  ContractDocumentRecord,
  ContractExtractedFieldRecord,
  ContractInvoiceRecord,
  ContractMetadataUpdateInput,
  ContractRecord,
  ContractStatusHistoryRecord,
  ContractTransitionInput,
  CreateContractInvoiceInput,
  CreateFalloAutopsyInput,
  CreateInconformidadDraftInput,
  EmailOutboxJobRow,
  FalloAutopsyRecord,
  InconformidadDraftRecord,
  OrganizationNotificationRecipient,
  OverdueContractInvoiceAlert,
  ReceivablesSummary,
  RenewalAlertRecord,
  ScanRenewalAlertsInput,
  ScanRenewalAlertsResult,
} from "./repository.ts";
import { CONTRACT_INITIAL_STATUS, checkTransition, isContractStatus } from "./contract-lifecycle.ts";
import type { ContractStatus } from "./contract-lifecycle.ts";
import { extractContractFields } from "./contract-extraction.ts";
import type { ContractFieldKey } from "./contract-extraction.ts";
import { classifyInvoiceStatus, computePaymentDueDate, summarizeReceivables } from "./contract-billing.ts";
import { buildInconformidadContent, INCONFORMIDAD_DISCLAIMER } from "./inconformidad.ts";
import type { InconformidadFundamento } from "./inconformidad.ts";
import { normalizeOrNoDisponible } from "./fallo-autopsy.ts";
import type { CriteriaComparisonItem, OwnProposalStatus } from "./fallo-autopsy.ts";
import { computeRenewalAlertCandidates, DEFAULT_RENEWAL_LEAD_DAYS } from "./renewal-radar.ts";
import type { RenewalCandidateContract } from "./renewal-radar.ts";
import { requireValidHashedInputs, sealInputs } from "./sealed-inputs.ts";
import type { ExpedienteInputs, HashedInputs } from "./sealed-inputs.ts";
import { sha256Bytes, sha256Hex } from "./types.ts";
import { ApprovalWorkflow } from "./approval-workflow.ts";
import type { Approval, ApprovalScope, ChangeDetected } from "./approval-workflow.ts";
import { ProposalVersionRegistry, buildProposalInputRecords } from "./proposal-version-registry.ts";
import type { PersistedProposalVersion, ProposalInputRecord } from "./proposal-version-registry.ts";
import { WRITE_ROLES } from "./roles.ts";
import type { LicitacionesRole } from "./roles.ts";
import type { RequirementFulfillmentMappingRecord, RequirementItemRecord } from "./repository.ts";
import { buildGoNoGoDecision } from "./go-no-go.ts";
import { TenderVersionRegistry, computeTenderSnapshotHash, toRequirementSnapshot } from "./tender-version-registry.ts";
import type { PersistedTenderVersion, TenderVersionDiff, TenderVersionSnapshot } from "./tender-version-registry.ts";
import { LICITACIONES_CONNECTOR_REGISTRY } from "./connector-registry.ts";
import type { SourceConnectorId } from "./connector-registry.ts";
import { evaluateSourceFreshness } from "./source-run.ts";
import type { SourceFreshnessRecord, SourceRunInput, SourceRunRecord } from "./source-run.ts";
import type { TenderSourceIngestResult, TenderDeadlineReminderRecord, ScanDeadlineRemindersInput, ScanDeadlineRemindersResult } from "./repository.ts";
import type { TenderSourceIngestCandidate } from "./connectors/types.ts";
import type {
  ApprovedRateRecord,
  CompanyDocumentRecord,
  CompanyCapabilityRecord,
  CompanyExperienceItemRecord,
  CompanySignerRecord,
  ComplianceItemRecord,
  GoNoGoDecisionRecord,
  MatchingProfileRecord,
  PackageManifestRecord,
  ProposalRecord,
  RequiredAnnexItem,
  SubmissionRecord,
  TenderRecord,
  TenderResolutionRecord,
  TenderStatus,
} from "./types.ts";

// Ventana de protección contra reintento de un Idempotency-Key — mismo
// criterio que domain-hoteles/domain-restaurantes.
const IDEMPOTENCY_KEY_TTL_DAYS = 7;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `licitaciones.company_document.expires_at` y
 * `licitaciones.approved_rate.valid_from`/`valid_until` son columnas `date`
 * (001_licitaciones_schema.sql) que este repositorio lee con `::text` (el
 * parser nativo de `pg` para OID 1082 devolvería un `Date`, no la cadena que
 * el resto de este archivo espera) — pero esa cadena `YYYY-MM-DD` por sí
 * sola NO trae el offset horario explícito que `assertExplicitOffset`
 * (types.ts) exige incondicionalmente en cuanto el valor no es `null`
 * (`CompanyDataService.resolveDocumentByType`/`resolveApprovedRate`,
 * company-data.ts). Sin esta normalización, cualquier fecha de vigencia
 * real hacía lanzar esos dos métodos SIEMPRE, tumbando con 500 tanto
 * `POST .../proposal/economic/generate` como la generación de la propuesta
 * técnica en producción — el repositorio en memoria nunca reproduce este bug
 * porque conserva tal cual la cadena ISO-con-offset que le pasan los
 * tests/fixtures, en vez de pasar por una columna `date` real de Postgres.
 *
 * Convención: medianoche UTC ("YYYY-MM-DDT00:00:00Z"), consistente con
 * `isoNow()` (types.ts), que ya usa "Z" como offset canónico — la columna es
 * `date`, sin componente de hora que preservar. Si el valor ya trae offset
 * (o es `null`), se devuelve tal cual: la función es idempotente y segura de
 * aplicar más de una vez.
 */
export function dateColumnToExplicitOffsetIso(value: string | null): string | null {
  if (value === null) return null;
  return DATE_ONLY_PATTERN.test(value) ? `${value}T00:00:00Z` : value;
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

interface TenderRow {
  id: string;
  organization_id: string;
  title: string;
  submission_deadline: string | null;
  updated_at: string;
  source: string;
  external_id: string | null;
  contracting_body: string | null;
  cpv_codes: string[];
  budget_amount: string | null;
  currency: string;
  state: string | null;
  procedure_type_raw: string | null;
  status: TenderStatus;
}

// Fase 3: se centraliza la lista de columnas para que `findTender`,
// `listTenders` y `upsertTenderManual` (los 3 lugares que leen la fila
// completa de `licitaciones.tender`) nunca diverjan entre sí.
const TENDER_COLUMNS =
  "id, organization_id, title, submission_deadline::text as submission_deadline, updated_at::text as updated_at, " +
  "source, external_id, contracting_body, cpv_codes, budget_amount::text as budget_amount, currency, state, procedure_type_raw, status";

function mapTender(row: TenderRow): TenderRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    submissionDeadline: row.submission_deadline,
    updatedAt: row.updated_at,
    source: row.source,
    externalId: row.external_id,
    contractingBody: row.contracting_body,
    cpvCodes: row.cpv_codes,
    budgetAmount: row.budget_amount === null ? null : Number(row.budget_amount),
    currency: row.currency,
    state: row.state,
    procedureTypeRaw: row.procedure_type_raw,
    status: row.status,
  };
}

// Fase 8 -- `licitaciones.tender_deadline_reminder` (migración 017).
interface DeadlineReminderRow {
  id: string;
  organization_id: string;
  tender_id: string;
  submission_deadline: string;
  days_remaining: number;
  message: string;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

function mapDeadlineReminder(row: DeadlineReminderRow): TenderDeadlineReminderRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    tenderId: row.tender_id,
    submissionDeadline: row.submission_deadline,
    daysRemaining: row.days_remaining,
    message: row.message,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
  };
}

interface MatchingProfileRow {
  organization_id: string;
  keywords: string[];
  excluded_keywords: string[];
  classifier_codes: string[];
  entities: string[];
  states: string[];
  budget_min: string | null;
  budget_max: string | null;
  updated_by: string | null;
  updated_at: string;
}

function mapMatchingProfile(row: MatchingProfileRow): MatchingProfileRecord {
  return {
    organizationId: row.organization_id,
    keywords: row.keywords,
    excludedKeywords: row.excluded_keywords,
    classifierCodes: row.classifier_codes,
    entities: row.entities,
    states: row.states,
    budgetMin: row.budget_min === null ? null : Number(row.budget_min),
    budgetMax: row.budget_max === null ? null : Number(row.budget_max),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

interface GoNoGoDecisionRow {
  id: string;
  organization_id: string;
  tender_id: string;
  decision: "go" | "no_go";
  reasons: string[];
  match_score: string;
  match_eligibility_status: GoNoGoDecisionRecord["matchEligibilityStatus"];
  match_inputs_hash: string;
  decided_by: string;
  decided_at: string;
}

function mapGoNoGoDecision(row: GoNoGoDecisionRow): GoNoGoDecisionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    tenderId: row.tender_id,
    decision: row.decision,
    reasons: row.reasons,
    matchScore: Number(row.match_score),
    matchEligibilityStatus: row.match_eligibility_status,
    matchInputsHash: row.match_inputs_hash,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

interface TenderResolutionRow {
  id: string;
  organization_id: string;
  tender_id: string;
  resolution: "won" | "lost";
  from_status: TenderStatus;
  reason: string;
  resolved_by: string;
  resolved_at: string;
}

function mapTenderResolution(row: TenderResolutionRow): TenderResolutionRecord {
  return { id: row.id, organizationId: row.organization_id, tenderId: row.tender_id, resolution: row.resolution, fromStatus: row.from_status, reason: row.reason, resolvedBy: row.resolved_by, resolvedAt: row.resolved_at };
}

interface ProposalRow {
  id: string;
  organization_id: string;
  tender_id: string;
  title: string;
  iva_rate: string;
  economic_totals: unknown | null;
  generation_report: ProposalRecord["generationReport"] | null;
  correlation_id: string | null;
  created_by: string;
  created_at: string;
}

function mapProposal(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    tenderId: row.tender_id,
    title: row.title,
    ivaRate: Number(row.iva_rate),
    economicTotals: row.economic_totals,
    generationReport: row.generation_report,
    correlationId: row.correlation_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const PROPOSAL_COLUMNS = "id, organization_id, tender_id, title, iva_rate, economic_totals, generation_report, correlation_id, created_by, created_at::text as created_at";

interface ApprovalRow {
  id: string;
  scope: ApprovalScope;
  scope_ref: string;
  approver_id: string;
  approver_role: string;
  inputs_hash: string;
  decided_at: string;
  status: "vigente" | "invalidada";
  invalidated_at: string | null;
  invalidated_reason: string | null;
}

const APPROVAL_COLUMNS = "id, scope, scope_ref, approver_id, approver_role, inputs_hash, decided_at::text as decided_at, status, invalidated_at::text as invalidated_at, invalidated_reason";

function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    scope: row.scope,
    scopeRef: row.scope_ref,
    approvedBy: row.approver_id,
    approvedByRole: row.approver_role as LicitacionesRole,
    approvedAt: row.decided_at,
    inputsHash: row.inputs_hash as Approval["inputsHash"],
    status: row.status,
    ...(row.invalidated_at !== null ? { invalidatedAt: row.invalidated_at } : {}),
    ...(row.invalidated_reason !== null ? { invalidatedReason: row.invalidated_reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fase 6 -- seguimiento post-adjudicación (REQ-051..055). Mismo patrón de
// mapeo fila->record que el resto de este archivo (columnas explícitas,
// nunca `select *`, para que un cambio de esquema se note en el tipo).
// ---------------------------------------------------------------------------

interface ContractRow {
  id: string;
  organization_id: string;
  tender_id: string;
  status: ContractStatus;
  end_date: string | null;
  contract_number: string | null;
  has_renewal_option: boolean;
  renewal_option_notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const CONTRACT_COLUMNS =
  "id, organization_id, tender_id, status, end_date::text as end_date, contract_number, has_renewal_option, renewal_option_notes, created_by, created_at::text as created_at, updated_at::text as updated_at";

function mapContract(row: ContractRow): ContractRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    tenderId: row.tender_id,
    status: row.status,
    endDate: row.end_date,
    contractNumber: row.contract_number,
    hasRenewalOption: row.has_renewal_option,
    renewalOptionNotes: row.renewal_option_notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ContractStatusHistoryRow {
  id: string;
  contract_id: string;
  from_status: ContractStatus | null;
  to_status: ContractStatus;
  reason: string;
  actor_id: string;
  evidence_ref: string | null;
  created_at: string;
}

function mapContractStatusHistory(row: ContractStatusHistoryRow): ContractStatusHistoryRecord {
  return {
    id: row.id,
    contractId: row.contract_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actorId: row.actor_id,
    evidenceRef: row.evidence_ref,
    createdAt: row.created_at,
  };
}

interface ContractDocumentRow {
  id: string;
  contract_id: string;
  document_label: string;
  page_count: number;
  uploaded_by: string;
  created_at: string;
}

function mapContractDocument(row: ContractDocumentRow): ContractDocumentRecord {
  return { id: row.id, contractId: row.contract_id, documentLabel: row.document_label, pageCount: row.page_count, uploadedBy: row.uploaded_by, createdAt: row.created_at };
}

interface ContractExtractedFieldRow {
  id: string;
  contract_document_id: string;
  field_key: ContractFieldKey;
  extracted_value: string;
  source_page: number | null;
  source_clause: string | null;
  confidence: string;
  status: "sugerido" | "confirmado" | "corregido";
  confirmed_value: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
}

const CONTRACT_EXTRACTED_FIELD_COLUMNS =
  "id, contract_document_id, field_key, extracted_value, source_page, source_clause, confidence::text as confidence, status, confirmed_value, confirmed_by, confirmed_at::text as confirmed_at, created_at::text as created_at";

function mapContractExtractedField(row: ContractExtractedFieldRow): ContractExtractedFieldRecord {
  return {
    id: row.id,
    contractDocumentId: row.contract_document_id,
    fieldKey: row.field_key,
    extractedValue: row.extracted_value,
    sourcePage: row.source_page,
    sourceClause: row.source_clause,
    confidence: Number(row.confidence),
    status: row.status,
    confirmedValue: row.confirmed_value,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  };
}

interface ContractInvoiceRow {
  id: string;
  contract_id: string;
  concepto: string;
  amount: string;
  invoice_verified_on: string;
  due_date: string;
  legal_reference: string;
  paid_at: string | null;
  created_by: string;
  created_at: string;
}

const CONTRACT_INVOICE_COLUMNS =
  "id, contract_id, concepto, amount::text as amount, invoice_verified_on::text as invoice_verified_on, due_date::text as due_date, legal_reference, paid_at::text as paid_at, created_by, created_at::text as created_at";

function mapContractInvoice(row: ContractInvoiceRow): ContractInvoiceRecord {
  const base = {
    id: row.id,
    contractId: row.contract_id,
    concepto: row.concepto,
    amount: row.amount,
    invoiceVerifiedOn: row.invoice_verified_on,
    dueDate: row.due_date,
    legalReference: row.legal_reference,
    paidAt: row.paid_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  return { ...base, status: classifyInvoiceStatus(base) };
}

interface InconformidadDraftRow {
  id: string;
  organization_id: string;
  tender_id: string;
  version: number;
  status: "borrador" | "revisado";
  content_hash: string;
  hechos: string[];
  agravios: string[];
  pruebas: string[];
  fundamentos: InconformidadFundamento[];
  fallo_notified_on: string;
  bajo_tratados: boolean;
  business_days: number;
  due_date: string;
  legal_reference: string;
  viability: InconformidadDraftRecord["viability"];
  viability_recommendation: string;
  disclaimer: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by: string;
  created_at: string;
}

const INCONFORMIDAD_DRAFT_COLUMNS =
  "id, organization_id, tender_id, version, status, content_hash, hechos, agravios, pruebas, fundamentos, " +
  "fallo_notified_on::text as fallo_notified_on, bajo_tratados, business_days, due_date::text as due_date, legal_reference, " +
  "viability, viability_recommendation, disclaimer, reviewed_by, reviewed_at::text as reviewed_at, created_by, created_at::text as created_at";

function mapInconformidadDraft(row: InconformidadDraftRow): InconformidadDraftRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    tenderId: row.tender_id,
    version: row.version,
    status: row.status,
    contentHash: row.content_hash,
    hechos: row.hechos,
    agravios: row.agravios,
    pruebas: row.pruebas,
    fundamentos: row.fundamentos,
    falloNotifiedOn: row.fallo_notified_on,
    bajoTratados: row.bajo_tratados,
    businessDays: row.business_days,
    dueDate: row.due_date,
    legalReference: row.legal_reference,
    viability: row.viability,
    viabilityRecommendation: row.viability_recommendation,
    disclaimer: row.disclaimer,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface FalloAutopsyRow {
  id: string;
  organization_id: string;
  tender_id: string;
  own_proposal_status: OwnProposalStatus;
  disqualification_reason: string;
  own_score: string | null;
  winner_score: string | null;
  own_price: string | null;
  winner_price: string | null;
  winner_name: string;
  criteria_comparison: CriteriaComparisonItem[];
  created_by: string;
  created_at: string;
}

const FALLO_AUTOPSY_COLUMNS =
  "id, organization_id, tender_id, own_proposal_status, disqualification_reason, own_score::text as own_score, winner_score::text as winner_score, " +
  "own_price::text as own_price, winner_price::text as winner_price, winner_name, criteria_comparison, created_by, created_at::text as created_at";

function mapFalloAutopsy(row: FalloAutopsyRow): FalloAutopsyRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    tenderId: row.tender_id,
    ownProposalStatus: row.own_proposal_status,
    disqualificationReason: row.disqualification_reason,
    ownScore: row.own_score === null ? null : Number(row.own_score),
    winnerScore: row.winner_score === null ? null : Number(row.winner_score),
    ownPrice: row.own_price === null ? null : Number(row.own_price),
    winnerPrice: row.winner_price === null ? null : Number(row.winner_price),
    winnerName: row.winner_name,
    criteriaComparison: row.criteria_comparison,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface CompanyLessonLearnedRow {
  id: string;
  organization_id: string;
  fallo_autopsy_id: string;
  tender_id: string;
  lesson_text: string;
  created_at: string;
}

function mapCompanyLessonLearned(row: CompanyLessonLearnedRow): CompanyLessonLearnedRecord {
  return { id: row.id, organizationId: row.organization_id, falloAutopsyId: row.fallo_autopsy_id, tenderId: row.tender_id, lessonText: row.lesson_text, createdAt: row.created_at };
}

interface RenewalAlertRow {
  id: string;
  organization_id: string;
  contract_id: string;
  tender_id: string;
  predicted_date: string;
  lead_days: number;
  confidence: string;
  status: "pendiente" | "reconocida";
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

const RENEWAL_ALERT_COLUMNS =
  "id, organization_id, contract_id, tender_id, predicted_date::text as predicted_date, lead_days, confidence::text as confidence, status, " +
  "acknowledged_at::text as acknowledged_at, acknowledged_by, created_at::text as created_at";

function mapRenewalAlert(row: RenewalAlertRow): RenewalAlertRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    contractId: row.contract_id,
    tenderId: row.tender_id,
    predictedDate: row.predicted_date,
    leadDays: row.lead_days,
    confidence: Number(row.confidence),
    status: row.status,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    createdAt: row.created_at,
  };
}

export class PostgresLicitacionesRepository implements LicitacionesRepository {
  constructor(private readonly db: TenantDbSession) {}

  // ---- Fase 7 pieza 1: organización/property (panel web) — mismo patrón exacto
  // que `PostgresCitasRepository.findOrganizationBySlug`/`listPropertiesForOrganization`:
  // lee directo de `core.organization`/`core.property` (esquema núcleo compartido
  // entre verticales, migración 0001_core_schema.sql), sin tabla propia de
  // licitaciones para esto. ----

  async findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null> {
    const { rows } = await this.db.query<{ id: string; name: string; slug: string; status: "trial" | "active" | "suspended" }>(
      `select id, name, slug, status from core.organization where slug = $1 and vertical = 'licitaciones';`,
      [slug],
    );
    const row = rows[0];
    return row ? { id: row.id, name: row.name, slug: row.slug, isActive: row.status === "active" } : null;
  }

  async listPropertiesForOrganization(organizationId: string): Promise<readonly { propertyId: string; name: string }[]> {
    const { rows } = await this.db.query<{ property_id: string; name: string }>(
      `select id as property_id, name from core.property where organization_id = $1 and status = 'active' order by name asc;`,
      [organizationId],
    );
    return rows.map((row) => ({ propertyId: row.property_id, name: row.name }));
  }

  async findTender(organizationId: string, tenderId: string): Promise<TenderRecord | null> {
    const { rows } = await this.db.query<TenderRow>(`select ${TENDER_COLUMNS} from licitaciones.tender where id = $1 and organization_id = $2;`, [tenderId, organizationId]);
    const row = rows[0];
    return row ? mapTender(row) : null;
  }

  async getOrCreateProposal(organizationId: string, tenderId: string, userId: string, title: string): Promise<ProposalRecord> {
    const existing = await this.findProposal(organizationId, tenderId);
    if (existing) return existing;
    const { rows } = await this.db.query<ProposalRow>(
      `insert into licitaciones.proposal (organization_id, tender_id, title, created_by)
       values ($1, $2, $3, $4)
       on conflict (organization_id, tender_id) do update set title = licitaciones.proposal.title
       returning ${PROPOSAL_COLUMNS};`,
      [organizationId, tenderId, title, userId],
    );
    return mapProposal(rows[0]!);
  }

  async findProposal(organizationId: string, tenderId: string): Promise<ProposalRecord | null> {
    const { rows } = await this.db.query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from licitaciones.proposal where organization_id = $1 and tender_id = $2;`, [organizationId, tenderId]);
    const row = rows[0];
    return row ? mapProposal(row) : null;
  }

  // ---- Fase 3 pieza 1: alta manual de convocatoria (§6) ----

  async listTenders(organizationId: string): Promise<readonly TenderRecord[]> {
    const { rows } = await this.db.query<TenderRow>(`select ${TENDER_COLUMNS} from licitaciones.tender where organization_id = $1 order by updated_at desc;`, [organizationId]);
    return rows.map(mapTender);
  }

  async listTendersPage(organizationId: string, opts: { readonly limit: number; readonly offset: number }): Promise<TenderPage> {
    const { rows } = await this.db.query<TenderRow & { total: string }>(
      `select ${TENDER_COLUMNS}, count(*) over ()::text as total from licitaciones.tender where organization_id = $1 order by updated_at desc limit $2 offset $3;`,
      [organizationId, opts.limit, opts.offset],
    );
    const items = rows.map(mapTender);
    const total = rows[0] ? Number(rows[0].total) : 0;
    const nextOffset = opts.offset + items.length < total ? opts.offset + items.length : null;
    return { items, total, nextOffset };
  }

  async upsertTenderManual(organizationId: string, input: TenderUpsertInput): Promise<TenderUpsertResult> {
    // La comparación de "¿cambió submissionDeadline?" necesita el valor
    // PREVIO -- se lee antes del upsert (misma snapshot que verá el ON
    // CONFLICT) en vez de intentar una CTE combinada, para que el criterio
    // sea explícito y fácil de verificar en pruebas.
    let previousDeadline: string | null | undefined;
    if (input.externalId !== null) {
      const { rows } = await this.db.query<{ submission_deadline: string | null }>(
        `select submission_deadline::text as submission_deadline from licitaciones.tender where organization_id = $1 and source = 'manual' and external_id = $2;`,
        [organizationId, input.externalId],
      );
      if (rows[0]) previousDeadline = rows[0].submission_deadline;
    }

    const { rows } = await this.db.query<TenderRow & { inserted: boolean }>(
      `insert into licitaciones.tender (organization_id, title, submission_deadline, source, external_id, contracting_body, cpv_codes, budget_amount, currency, state, procedure_type_raw, created_by)
       values ($1, $2, $3, 'manual', $4, $5, $6::text[], $7, $8, $9, $10, $11)
       on conflict (organization_id, source, external_id) where external_id is not null
       do update set
         title = excluded.title,
         submission_deadline = excluded.submission_deadline,
         contracting_body = excluded.contracting_body,
         cpv_codes = excluded.cpv_codes,
         budget_amount = excluded.budget_amount,
         currency = excluded.currency,
         state = excluded.state,
         procedure_type_raw = excluded.procedure_type_raw,
         updated_at = now()
       returning ${TENDER_COLUMNS}, (xmax = 0) as inserted;`,
      [organizationId, input.title, input.submissionDeadline, input.externalId, input.contractingBody, input.cpvCodes, input.budgetAmount, input.currency, input.state, input.procedureTypeRaw, input.actorId],
    );
    const row = rows[0]!;
    const tender = mapTender(row);
    const created = row.inserted;

    await this.db.query(`insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id) values ($1, $2, $3, $4);`, [
      organizationId,
      tender.id,
      created ? "tender.manual_upsert.created" : "tender.manual_upsert.updated",
      input.actorId,
    ]);

    // Fase 5 pieza 1 (REQ-147): cada alta/actualización manual ES una
    // "corrida de ingesta" del único conector real hoy -- se registra tal
    // cual, con la MISMA forma que usaría un conector automatizado futuro.
    await this.recordSourceRun(organizationId, {
      source: "manual",
      state: "ok",
      startedAt: tender.updatedAt,
      finishedAt: tender.updatedAt,
      evidence: { message: created ? "Alta manual de convocatoria." : "Actualización manual de convocatoria.", coverage: { expected: 1, obtained: 1 } },
      correlationId: null,
    });

    // Fase 5 pieza 2: versiona la convocatoria y ejecuta la cascada de
    // invalidación en la MISMA operación -- generaliza el disparador anterior
    // (solo `submissionDeadline`, ver `submissionDeadlineChanged` abajo, que
    // se conserva por compatibilidad informativa) a CUALQUIER campo de bases
    // que haya cambiado (REQ-151/155).
    await this.recordTenderVersion(organizationId, tender.id, input.actorId);

    return { tender, created, submissionDeadlineChanged: !created && previousDeadline !== undefined && previousDeadline !== tender.submissionDeadline };
  }

  // ---- Fase 5 pieza 2: historial de versiones de convocatoria (REQ-017/041/151..155) ----

  async recordTenderVersion(organizationId: string, tenderId: string, actorId: string): Promise<RecordTenderVersionResult> {
    const tender = await this.findTender(organizationId, tenderId);
    if (!tender) throw new Error(`Tender "${tenderId}" no encontrado para la organización "${organizationId}" (recordTenderVersion).`);
    const requirementItems = await this.listRequirementItems(organizationId, tenderId);

    const snapshot: TenderVersionSnapshot = {
      fields: {
        title: tender.title,
        submissionDeadline: tender.submissionDeadline,
        contractingBody: tender.contractingBody ?? null,
        cpvCodes: tender.cpvCodes ?? [],
        budgetAmount: tender.budgetAmount ?? null,
        currency: tender.currency ?? "MXN",
        state: tender.state ?? null,
        procedureTypeRaw: tender.procedureTypeRaw ?? null,
      },
      requirements: requirementItems.map(toRequirementSnapshot),
    };
    const hash = computeTenderSnapshotHash(snapshot);

    const previousLatest = await this.latestTenderVersion(organizationId, tenderId);
    // REQ-152/154: snapshot idéntico al de la última versión -> no crea versión/cascada/notificación nueva (reingesta/reprocesamiento idempotente).
    if (previousLatest && previousLatest.hash === hash) {
      return { version: previousLatest, created: false, cascadedChanges: [], notification: null };
    }

    const diff: TenderVersionDiff = TenderVersionRegistry.diff(previousLatest?.snapshot ?? null, snapshot);
    const nextVersion = (previousLatest?.version ?? 0) + 1;

    const { rows: versionRows } = await this.db.query<{ created_at: string }>(
      `insert into licitaciones.tender_version (organization_id, tender_id, version, hash, snapshot, diff)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       on conflict (tender_id, version) do nothing
       returning created_at::text as created_at;`,
      [organizationId, tenderId, nextVersion, hash, JSON.stringify(snapshot), JSON.stringify(diff)],
    );
    // `on conflict do nothing` sin fila devuelta significaría una carrera con
    // otra corrida concurrente que ya insertó esta misma versión -- se relee
    // en vez de asumir "ahora" como fallback silencioso.
    const createdAt = versionRows[0]?.created_at ?? (await this.latestTenderVersion(organizationId, tenderId))!.createdAt;
    const persisted: PersistedTenderVersion = { version: nextVersion, hash, snapshot, diff, createdAt };

    const cascadedChanges: ChangeDetected[] = [];
    if (previousLatest && diff.hasChanges) {
      const proposal = await this.findProposal(organizationId, tenderId);
      if (proposal) {
        if (diff.changedFieldNames.length > 0) {
          cascadedChanges.push(
            await this.recordChange(organizationId, proposal.id, {
              scope: "expediente",
              scopeRef: "expediente",
              reason: `tender_version_changed:v${nextVersion}:${diff.changedFieldNames.join(",")}`,
            }),
          );
        }
        for (const sectionKey of diff.affectedSectionKeys) {
          // `technicalProposal.ts::saveTechnicalSections` persiste
          // `proposal_section.section_key` con el prefijo `"technical:"`
          // (p. ej. "technical:legal", nunca el "legal" bare de
          // `SECTION_KEY_BY_REQUIREMENT_TYPE") -- el `scopeRef` de la
          // aprobación granular de esa sección (ver
          // `cierre.ts::POST .../proposal/sections/:sectionKey/approval`) usa
          // EXACTAMENTE ese mismo valor con prefijo. `affectedSectionKeys`
          // se mantiene sin prefijo en el módulo de dominio (es un concepto
          // de REQUISITOS, no de "cómo se ensambla un documento técnico") --
          // la traducción a scopeRef vive aquí, en el único punto que conoce
          // ambas convenciones.
          cascadedChanges.push(
            await this.recordChange(organizationId, proposal.id, {
              scope: "seccion",
              scopeRef: `seccion:technical:${sectionKey}`,
              reason: `tender_version_changed:v${nextVersion}:requisitos_de_seccion:${sectionKey}`,
            }),
          );
        }
      }
    }

    const { rows: notificationRows } = await this.db.query<{ id: string; created_at: string }>(
      `insert into licitaciones.tender_change_notification (organization_id, tender_id, tender_version, reason, changed_field_names, affected_section_keys, notified_roles)
       values ($1, $2, $3, $4, $5::text[], $6::text[], $7::text[])
       returning id, created_at::text as created_at;`,
      [
        organizationId,
        tenderId,
        nextVersion,
        previousLatest ? `convocatoria_actualizada:v${nextVersion}` : "convocatoria_nueva",
        diff.changedFieldNames,
        diff.affectedSectionKeys,
        WRITE_ROLES,
      ],
    );
    const notification: TenderChangeNotificationRecord = {
      id: notificationRows[0]!.id,
      organizationId,
      tenderId,
      tenderVersion: nextVersion,
      reason: previousLatest ? `convocatoria_actualizada:v${nextVersion}` : "convocatoria_nueva",
      changedFieldNames: diff.changedFieldNames,
      affectedSectionKeys: diff.affectedSectionKeys,
      notifiedRoles: WRITE_ROLES,
      createdAt: notificationRows[0]!.created_at,
      acknowledgedAt: null,
      acknowledgedBy: null,
    };

    // Trazabilidad de quién disparó la corrida que produjo esta versión.
    await this.db.query(`insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id) values ($1, $2, 'tender.version_recorded', $3);`, [
      organizationId,
      tenderId,
      actorId,
    ]);

    return { version: persisted, created: true, cascadedChanges, notification };
  }

  async listTenderVersions(organizationId: string, tenderId: string): Promise<readonly PersistedTenderVersion[]> {
    const { rows } = await this.db.query<{ version: number; hash: string; snapshot: TenderVersionSnapshot; diff: TenderVersionDiff; created_at: string }>(
      `select version, hash, snapshot, diff, created_at::text as created_at from licitaciones.tender_version
       where organization_id = $1 and tender_id = $2 order by version asc;`,
      [organizationId, tenderId],
    );
    return rows.map((r) => ({ version: r.version, hash: r.hash, snapshot: r.snapshot, diff: r.diff, createdAt: r.created_at }));
  }

  async latestTenderVersion(organizationId: string, tenderId: string): Promise<PersistedTenderVersion | null> {
    const { rows } = await this.db.query<{ version: number; hash: string; snapshot: TenderVersionSnapshot; diff: TenderVersionDiff; created_at: string }>(
      `select version, hash, snapshot, diff, created_at::text as created_at from licitaciones.tender_version
       where organization_id = $1 and tender_id = $2 order by version desc limit 1;`,
      [organizationId, tenderId],
    );
    const row = rows[0];
    return row ? { version: row.version, hash: row.hash, snapshot: row.snapshot, diff: row.diff, createdAt: row.created_at } : null;
  }

  async listTenderChangeNotifications(organizationId: string, tenderId?: string): Promise<readonly TenderChangeNotificationRecord[]> {
    const { rows } = await this.db.query<{
      id: string;
      tender_id: string;
      tender_version: number;
      reason: string;
      changed_field_names: string[];
      affected_section_keys: string[];
      notified_roles: LicitacionesRole[];
      created_at: string;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
    }>(
      tenderId
        ? `select id, tender_id, tender_version, reason, changed_field_names, affected_section_keys, notified_roles, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by
           from licitaciones.tender_change_notification where organization_id = $1 and tender_id = $2 order by created_at desc;`
        : `select id, tender_id, tender_version, reason, changed_field_names, affected_section_keys, notified_roles, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by
           from licitaciones.tender_change_notification where organization_id = $1 order by created_at desc;`,
      tenderId ? [organizationId, tenderId] : [organizationId],
    );
    return rows.map((r) => ({
      id: r.id,
      organizationId,
      tenderId: r.tender_id,
      tenderVersion: r.tender_version,
      reason: r.reason,
      changedFieldNames: r.changed_field_names,
      affectedSectionKeys: r.affected_section_keys,
      notifiedRoles: r.notified_roles,
      createdAt: r.created_at,
      acknowledgedAt: r.acknowledged_at,
      acknowledgedBy: r.acknowledged_by,
    }));
  }

  async acknowledgeTenderChangeNotification(organizationId: string, notificationId: string, actorId: string): Promise<TenderChangeNotificationRecord> {
    const { rows } = await this.db.query<{
      id: string;
      tender_id: string;
      tender_version: number;
      reason: string;
      changed_field_names: string[];
      affected_section_keys: string[];
      notified_roles: LicitacionesRole[];
      created_at: string;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
    }>(
      `update licitaciones.tender_change_notification set acknowledged_at = now(), acknowledged_by = $1
       where organization_id = $2 and id = $3
       returning id, tender_id, tender_version, reason, changed_field_names, affected_section_keys, notified_roles, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by;`,
      [actorId, organizationId, notificationId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Notificación "${notificationId}" no encontrada para la organización "${organizationId}".`);
    return {
      id: row.id,
      organizationId,
      tenderId: row.tender_id,
      tenderVersion: row.tender_version,
      reason: row.reason,
      changedFieldNames: row.changed_field_names,
      affectedSectionKeys: row.affected_section_keys,
      notifiedRoles: row.notified_roles,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
    };
  }

  // ---- Fase 5 pieza 1: andamiaje de ingesta sobre fixtures/carga manual (REQ-004/005/146..150) ----

  async recordSourceRun(organizationId: string, input: SourceRunInput): Promise<SourceRunRecord> {
    // Fase "flujos de sistema": `recordSourceRun` SOLO se invoca hoy bajo
    // sesión de sistema (`apps/worker/src/jobs/licitaciones/discover-
    // tenders.ts`, sin caller de staff autenticado -- verificado con `grep
    // -rn` sobre `apps/api/src/routes`). Un `insert` directo contra
    // `licitaciones.source_run` queda bloqueado por la policy de INSERT
    // (`licitaciones.can_write_org`, exige `auth.uid()` real) -- se usa la
    // función `security definer` de solo-sistema
    // `licitaciones.system_record_source_run` (migración
    // `..._024_licitaciones_sistema_ingesta_escritura.sql`) en su lugar. Ver
    // el header de esa migración para el diagnóstico completo.
    const { rows } = await this.db.query<{ out_id: string; out_created_at: string }>(
      `select * from licitaciones.system_record_source_run($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
      [
        organizationId,
        input.source,
        input.state,
        input.startedAt,
        input.finishedAt,
        input.evidence.httpStatus ?? null,
        input.evidence.responseHash ?? null,
        input.evidence.message,
        input.evidence.coverage?.expected ?? null,
        input.evidence.coverage?.obtained ?? null,
        input.correlationId,
      ],
    );
    return { ...input, id: rows[0]!.out_id, organizationId, createdAt: rows[0]!.out_created_at };
  }

  async listSourceRuns(organizationId: string, filter?: { source?: SourceConnectorId; limit?: number }): Promise<readonly SourceRunRecord[]> {
    const { rows } = await this.db.query<{
      id: string;
      source: SourceConnectorId;
      state: SourceRunRecord["state"];
      started_at: string;
      finished_at: string;
      http_status: number | null;
      response_hash: string | null;
      message: string;
      coverage_expected: number | null;
      coverage_obtained: number | null;
      correlation_id: string | null;
      created_at: string;
    }>(
      filter?.source
        ? `select id, source, state, started_at::text as started_at, finished_at::text as finished_at, http_status, response_hash, message, coverage_expected, coverage_obtained, correlation_id, created_at::text as created_at
           from licitaciones.source_run where organization_id = $1 and source = $2 order by finished_at desc limit $3;`
        : `select id, source, state, started_at::text as started_at, finished_at::text as finished_at, http_status, response_hash, message, coverage_expected, coverage_obtained, correlation_id, created_at::text as created_at
           from licitaciones.source_run where organization_id = $1 order by finished_at desc limit $2;`,
      filter?.source ? [organizationId, filter.source, filter.limit ?? 500] : [organizationId, filter?.limit ?? 500],
    );
    return rows.map((r) => ({
      id: r.id,
      organizationId,
      source: r.source,
      state: r.state,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      evidence: {
        ...(r.http_status !== null ? { httpStatus: r.http_status } : {}),
        ...(r.response_hash !== null ? { responseHash: r.response_hash } : {}),
        message: r.message,
        ...(r.coverage_expected !== null && r.coverage_obtained !== null ? { coverage: { expected: r.coverage_expected, obtained: r.coverage_obtained } } : {}),
      },
      correlationId: r.correlation_id,
      createdAt: r.created_at,
    }));
  }

  async sourceFreshness(organizationId: string): Promise<readonly SourceFreshnessRecord[]> {
    // Dos consultas separadas (en vez de una sola con lógica combinada) para
    // que "la corrida más reciente de cualquier estado" y "la corrida
    // exitosa más reciente" nunca se confundan entre sí -- una fuente cuya
    // ÚLTIMA corrida fue exitosa pero tuvo una falla más antigua no debe
    // reportar la falla como "más reciente".
    const [lastAnyResult, lastSuccessResult] = await Promise.all([
      this.db.query<{ source: SourceConnectorId; state: SourceFreshnessRecord["lastRunState"] }>(
        `select distinct on (source) source, state from licitaciones.source_run where organization_id = $1 order by source, finished_at desc;`,
        [organizationId],
      ),
      this.db.query<{ source: SourceConnectorId; finished_at: string }>(
        `select distinct on (source) source, finished_at::text as finished_at from licitaciones.source_run where organization_id = $1 and state = 'ok' order by source, finished_at desc;`,
        [organizationId],
      ),
    ]);
    const now = new Date();
    return LICITACIONES_CONNECTOR_REGISTRY.all().map((descriptor) => {
      const lastAny = lastAnyResult.rows.find((r) => r.source === descriptor.id) ?? null;
      const lastSuccess = lastSuccessResult.rows.find((r) => r.source === descriptor.id) ?? null;
      return evaluateSourceFreshness(descriptor.id, lastSuccess ? { state: "ok", finishedAt: lastSuccess.finished_at } : null, lastAny ? { state: lastAny.state! } : null, now);
    });
  }

  // ---- Fase 8: ingesta automática real (compras_mx_historico) + recordatorios de plazo ----

  async ingestTendersFromSource(organizationId: string, source: SourceConnectorId, records: readonly TenderSourceIngestCandidate[]): Promise<TenderSourceIngestResult> {
    if (source === "manual") {
      throw new Error('ingestTendersFromSource: "source" no puede ser "manual" -- ese camino de escritura es upsertTenderManual(), nunca este.');
    }
    let created = 0;
    let updated = 0;
    const tenders: TenderRecord[] = [];

    // Fase "flujos de sistema": `ingestTendersFromSource` SOLO se invoca hoy
    // bajo sesión de sistema (`apps/worker/src/jobs/licitaciones/discover-
    // tenders.ts`, sin caller de staff autenticado). Un `insert` directo
    // contra `licitaciones.tender` queda bloqueado por las policies de
    // INSERT/UPDATE (`licitaciones.can_write_org`, exige `auth.uid()` real)
    // -- se usa la función `security definer` de solo-sistema
    // `licitaciones.system_ingest_tender` (migración
    // `..._024_licitaciones_sistema_ingesta_escritura.sql`) en su lugar. Ver
    // el header de esa migración para el diagnóstico completo. Un `insert`
    // por registro (en vez de un `insert ... select unnest(...)` masivo):
    // correcto y simple para el tamaño de lote real que produce esta fase (el
    // worker SIEMPRE pasa un `limit` acotado) -- no pretende ser la forma más
    // eficiente posible para miles de filas por corrida (gap de rendimiento
    // declarado, no un problema de corrección).
    for (const rec of records) {
      const { rows } = await this.db.query<{
        out_id: string;
        out_organization_id: string;
        out_title: string;
        out_submission_deadline: string | null;
        out_updated_at: string;
        out_source: string;
        out_external_id: string | null;
        out_contracting_body: string | null;
        out_cpv_codes: string[];
        out_budget_amount: string | null;
        out_currency: string;
        out_state: string | null;
        out_procedure_type_raw: string | null;
        out_status: TenderStatus;
        out_inserted: boolean;
      }>(
        `select * from licitaciones.system_ingest_tender($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11);`,
        [organizationId, rec.title, rec.submissionDeadline, source, rec.externalId, rec.contractingBody, rec.cpvCodes, rec.budgetAmount, rec.currency, rec.state, rec.procedureTypeRaw],
      );
      const row = rows[0]!;
      const tender = mapTender({
        id: row.out_id,
        organization_id: row.out_organization_id,
        title: row.out_title,
        submission_deadline: row.out_submission_deadline,
        updated_at: row.out_updated_at,
        source: row.out_source,
        external_id: row.out_external_id,
        contracting_body: row.out_contracting_body,
        cpv_codes: row.out_cpv_codes,
        budget_amount: row.out_budget_amount,
        currency: row.out_currency,
        state: row.out_state,
        procedure_type_raw: row.out_procedure_type_raw,
        status: row.out_status,
      });
      tenders.push(tender);
      if (row.out_inserted) created += 1;
      else updated += 1;
    }

    return { created, updated, tenders };
  }

  async listActiveOrganizations(): Promise<readonly { id: string }[]> {
    const { rows } = await this.db.query<{ id: string }>(`select id from core.organization where vertical = 'licitaciones' and status = 'active';`);
    return rows.map((r) => ({ id: r.id }));
  }

  async scanUpcomingDeadlineReminders(organizationId: string, input: ScanDeadlineRemindersInput = {}): Promise<ScanDeadlineRemindersResult> {
    const windowDays = input.windowDays ?? 3;
    const now = input.nowIso ? new Date(input.nowIso) : new Date();
    const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

    // Fase "flujos de sistema": `scanUpcomingDeadlineReminders` SOLO se
    // invoca hoy bajo sesión de sistema (`apps/worker/src/jobs/licitaciones/
    // deadline-reminders.ts`/`alert-notifications.ts`, sin caller de staff
    // autenticado). Tanto el SELECT contra `licitaciones.tender` (policy "org
    // ve sus convocatorias", exige `auth.uid()` real -- el mismo síntoma
    // exacto que motivó el PR #141 para `core.organization`/`core.property`:
    // 0 filas SIEMPRE, en silencio) como el INSERT contra
    // `licitaciones.tender_deadline_reminder` (policy de INSERT,
    // `licitaciones.can_write_org`) quedaban bloqueados -- se usan las
    // funciones `security definer` de solo-sistema
    // `licitaciones.system_list_tenders_with_upcoming_deadline`/
    // `system_record_deadline_reminder` (migración
    // `..._024_licitaciones_sistema_ingesta_escritura.sql`) en su lugar. Ver
    // el header de esa migración para el diagnóstico completo.
    const { rows } = await this.db.query<{ out_id: string; out_title: string; out_submission_deadline: string }>(
      `select * from licitaciones.system_list_tenders_with_upcoming_deadline($1, $2, $3);`,
      [organizationId, now.toISOString(), windowEnd.toISOString()],
    );

    let created = 0;
    const createdReminders: TenderDeadlineReminderRecord[] = [];
    for (const row of rows) {
      const submissionDeadline = row.out_submission_deadline;
      const title = row.out_title;
      const tenderId = row.out_id;
      const deadlineDateOnly = submissionDeadline.slice(0, 10);
      const daysRemaining = Math.ceil((new Date(submissionDeadline).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      const message = `La convocatoria "${title}" vence el ${submissionDeadline}.`;
      const { rows: insertedRows } = await this.db.query<{ out_id: string; out_created_at: string }>(
        `select * from licitaciones.system_record_deadline_reminder($1, $2, $3, $4::date, $5, $6);`,
        [organizationId, tenderId, submissionDeadline, deadlineDateOnly, daysRemaining, message],
      );
      const inserted = insertedRows[0];
      if (inserted) {
        created += 1;
        createdReminders.push({
          id: inserted.out_id,
          organizationId,
          tenderId,
          submissionDeadline,
          daysRemaining,
          message,
          createdAt: inserted.out_created_at,
          acknowledgedAt: null,
          acknowledgedBy: null,
        });
      }
    }

    return { scanned: rows.length, created, reminders: createdReminders };
  }

  async listTenderDeadlineReminders(organizationId: string, tenderId?: string): Promise<readonly TenderDeadlineReminderRecord[]> {
    const { rows } = await this.db.query<DeadlineReminderRow>(
      tenderId
        ? `select id, organization_id, tender_id, submission_deadline::text as submission_deadline, days_remaining, message, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by
           from licitaciones.tender_deadline_reminder where organization_id = $1 and tender_id = $2 order by created_at desc;`
        : `select id, organization_id, tender_id, submission_deadline::text as submission_deadline, days_remaining, message, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by
           from licitaciones.tender_deadline_reminder where organization_id = $1 order by created_at desc;`,
      tenderId ? [organizationId, tenderId] : [organizationId],
    );
    return rows.map(mapDeadlineReminder);
  }

  async acknowledgeTenderDeadlineReminder(organizationId: string, reminderId: string, actorId: string): Promise<TenderDeadlineReminderRecord> {
    const { rows } = await this.db.query<DeadlineReminderRow>(
      `update licitaciones.tender_deadline_reminder set acknowledged_at = now(), acknowledged_by = $3
       where organization_id = $1 and id = $2
       returning id, organization_id, tender_id, submission_deadline::text as submission_deadline, days_remaining, message, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by;`,
      [organizationId, reminderId, actorId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Recordatorio de vencimiento "${reminderId}" no encontrado para la organización "${organizationId}".`);
    return mapDeadlineReminder(row);
  }

  // ---- Fase 3 pieza 2: perfil de matching de la organización (§5) ----

  async findMatchingProfile(organizationId: string): Promise<MatchingProfileRecord | null> {
    const { rows } = await this.db.query<MatchingProfileRow>(
      `select organization_id, keywords, excluded_keywords, classifier_codes, entities, states, budget_min::text as budget_min, budget_max::text as budget_max, updated_by, updated_at::text as updated_at
       from licitaciones.matching_profile where organization_id = $1;`,
      [organizationId],
    );
    const row = rows[0];
    return row ? mapMatchingProfile(row) : null;
  }

  async upsertMatchingProfile(organizationId: string, input: MatchingProfileUpsertInput): Promise<MatchingProfileRecord> {
    const { rows } = await this.db.query<MatchingProfileRow>(
      `insert into licitaciones.matching_profile (organization_id, keywords, excluded_keywords, classifier_codes, entities, states, budget_min, budget_max, updated_by)
       values ($1, $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7, $8, $9)
       on conflict (organization_id) do update set
         keywords = excluded.keywords,
         excluded_keywords = excluded.excluded_keywords,
         classifier_codes = excluded.classifier_codes,
         entities = excluded.entities,
         states = excluded.states,
         budget_min = excluded.budget_min,
         budget_max = excluded.budget_max,
         updated_by = excluded.updated_by,
         updated_at = now()
       returning organization_id, keywords, excluded_keywords, classifier_codes, entities, states, budget_min::text as budget_min, budget_max::text as budget_max, updated_by, updated_at::text as updated_at;`,
      [organizationId, input.keywords, input.excludedKeywords, input.classifierCodes, input.entities, input.states, input.budgetMin, input.budgetMax, input.actorId],
    );
    return mapMatchingProfile(rows[0]!);
  }

  // ---- Fase 3 pieza 3: decisiones go/no-go (§7) ----

  async createGoNoGoDecision(organizationId: string, tenderId: string, input: GoNoGoDecisionCreateInput): Promise<GoNoGoDecisionRecord> {
    const tender = await this.findTender(organizationId, tenderId);
    if (!tender) throw new Error(`Tender "${tenderId}" no encontrado para la organización "${organizationId}".`);

    // Lanza `GoNoGoRejectedError` si el rol o los motivos no pasan la regla
    // -- ninguna fila se toca en ese caso (mismo criterio que
    // `ApprovalWorkflow.approve()` en `approve()` más abajo).
    const validated = buildGoNoGoDecision({
      decision: input.decision,
      reasons: input.reasons,
      actorId: input.actorId,
      actorRole: input.actorRole,
      matchScore: input.matchScore,
      matchEligibilityStatus: input.matchEligibilityStatus,
      matchInputsHash: input.matchInputsHash,
    });

    const { rows } = await this.db.query<GoNoGoDecisionRow>(
      `insert into licitaciones.go_no_go_decision (organization_id, tender_id, decision, reasons, match_score, match_eligibility_status, match_inputs_hash, decided_by)
       values ($1, $2, $3, $4::text[], $5, $6, $7, $8)
       returning id, organization_id, tender_id, decision, reasons, match_score::text as match_score, match_eligibility_status, match_inputs_hash, decided_by, decided_at::text as decided_at;`,
      [organizationId, tenderId, validated.decision, validated.reasons, validated.matchScore, validated.matchEligibilityStatus, validated.matchInputsHash, validated.decidedBy],
    );

    // §7: un go/no_go es el único camino que saca una convocatoria de
    // discovered/in_review -- se escribe en la MISMA operación.
    await this.db.query(`update licitaciones.tender set status = $1, updated_at = now() where organization_id = $2 and id = $3;`, [validated.decision, organizationId, tenderId]);

    return mapGoNoGoDecision(rows[0]!);
  }

  async listGoNoGoDecisions(organizationId: string, tenderId: string): Promise<readonly GoNoGoDecisionRecord[]> {
    const { rows } = await this.db.query<GoNoGoDecisionRow>(
      `select id, organization_id, tender_id, decision, reasons, match_score::text as match_score, match_eligibility_status, match_inputs_hash, decided_by, decided_at::text as decided_at
       from licitaciones.go_no_go_decision where organization_id = $1 and tender_id = $2 order by decided_at desc;`,
      [organizationId, tenderId],
    );
    return rows.map(mapGoNoGoDecision);
  }

  // ---- Fase 16: resolución won/lost (ver tender-resolution.ts) ----

  async resolveTender(organizationId: string, tenderId: string, input: TenderResolutionCreateInput): Promise<TenderRecord> {
    const tender = await this.findTender(organizationId, tenderId);
    if (!tender) throw new Error(`Tender "${tenderId}" no encontrado para la organización "${organizationId}".`);
    const fromStatus: TenderStatus = tender.status ?? "discovered";

    // Valida ANTES de tocar ninguna fila -- mismo criterio exacto que
    // `transitionContract`/`checkTransition` (contract-lifecycle.ts).
    const check = checkTenderResolution(fromStatus);
    if (!check.valid) throw new TenderResolutionRejectedError(fromStatus, input.resolution, check.allowedFromStatuses);

    await this.db.query(
      `insert into licitaciones.tender_resolution (organization_id, tender_id, resolution, from_status, reason, resolved_by)
       values ($1, $2, $3, $4, $5, $6);`,
      [organizationId, tenderId, input.resolution, fromStatus, input.reason, input.actorId],
    );
    // Misma operación (mismo criterio que `createGoNoGoDecision`): la fila de
    // historial y el `tender.status` nuevo se escriben juntos.
    const { rows } = await this.db.query<TenderRow>(`update licitaciones.tender set status = $1, updated_at = now() where organization_id = $2 and id = $3 returning ${TENDER_COLUMNS};`, [
      input.resolution,
      organizationId,
      tenderId,
    ]);
    return mapTender(rows[0]!);
  }

  async listTenderResolutions(organizationId: string, tenderId: string): Promise<readonly TenderResolutionRecord[]> {
    const { rows } = await this.db.query<TenderResolutionRow>(
      `select id, organization_id, tender_id, resolution, from_status, reason, resolved_by, resolved_at::text as resolved_at
       from licitaciones.tender_resolution where organization_id = $1 and tender_id = $2 order by resolved_at asc;`,
      [organizationId, tenderId],
    );
    return rows.map(mapTenderResolution);
  }

  // ---- Fase 16: escritura de "datos de empresa" ----

  async createCompanyDocument(organizationId: string, input: CompanyDocumentCreateInput): Promise<CompanyDocumentRecord> {
    const { rows } = await this.db.query<{ id: string; document_type: string; label: string; expires_at: string | null; approval_status: CompanyDocumentRecord["approvalStatus"] }>(
      `insert into licitaciones.company_document (organization_id, document_type, label, expires_at, approval_status)
       values ($1, $2, $3, $4, $5)
       returning id, document_type, label, expires_at::text as expires_at, approval_status;`,
      [organizationId, input.type, input.label, input.expiresAt, input.approvalStatus ?? "pendiente_aprobacion"],
    );
    const row = rows[0]!;
    return { id: row.id, type: row.document_type, label: row.label, expiresAt: dateColumnToExplicitOffsetIso(row.expires_at), approvalStatus: row.approval_status };
  }

  async updateCompanyDocument(organizationId: string, documentId: string, input: CompanyDocumentUpdateInput): Promise<CompanyDocumentRecord> {
    const { rows } = await this.db.query<{ id: string; document_type: string; label: string; expires_at: string | null; approval_status: CompanyDocumentRecord["approvalStatus"] }>(
      `update licitaciones.company_document set
         label = coalesce($3, label),
         expires_at = case when $4::boolean then $5::date else expires_at end,
         approval_status = coalesce($6, approval_status)
       where id = $1 and organization_id = $2
       returning id, document_type, label, expires_at::text as expires_at, approval_status;`,
      [documentId, organizationId, input.label ?? null, "expiresAt" in input, input.expiresAt ?? null, input.approvalStatus ?? null],
    );
    const row = rows[0];
    if (!row) throw new CompanyDataNotFoundError("Documento de empresa", documentId);
    return { id: row.id, type: row.document_type, label: row.label, expiresAt: dateColumnToExplicitOffsetIso(row.expires_at), approvalStatus: row.approval_status };
  }

  async createApprovedRate(organizationId: string, input: ApprovedRateCreateInput): Promise<ApprovedRateRecord> {
    const existing = await this.db.query<{ id: string }>(`select id from licitaciones.approved_rate where organization_id = $1 and concept = $2;`, [organizationId, input.concept]);
    if (existing.rows.length > 0) throw new CompanyDataDuplicateKeyError("tarifa aprobada", input.concept);

    const { rows } = await this.db.query<{ id: string; concept: string; unit_price: string; approval_status: ApprovedRateRecord["approvalStatus"]; valid_from: string; valid_until: string | null }>(
      `insert into licitaciones.approved_rate (organization_id, concept, unit_price, approval_status, valid_from, valid_until)
       values ($1, $2, $3, $4, coalesce($5::date, current_date), $6)
       returning id, concept, unit_price, approval_status, valid_from::text as valid_from, valid_until::text as valid_until;`,
      [organizationId, input.concept, input.unitPrice, input.approvalStatus ?? "pendiente_aprobacion", input.validFrom ?? null, input.validUntil ?? null],
    );
    const row = rows[0]!;
    return { id: row.id, concept: row.concept, unitPrice: row.unit_price, currency: "MXN", approvalStatus: row.approval_status, validFrom: dateColumnToExplicitOffsetIso(row.valid_from)!, validUntil: dateColumnToExplicitOffsetIso(row.valid_until) };
  }

  async updateApprovedRate(organizationId: string, rateId: string, input: ApprovedRateUpdateInput): Promise<ApprovedRateRecord> {
    const { rows } = await this.db.query<{ id: string; concept: string; unit_price: string; approval_status: ApprovedRateRecord["approvalStatus"]; valid_from: string; valid_until: string | null }>(
      `update licitaciones.approved_rate set
         unit_price = coalesce($3, unit_price),
         approval_status = coalesce($4, approval_status),
         valid_from = coalesce($5::date, valid_from),
         valid_until = case when $6::boolean then $7::date else valid_until end
       where id = $1 and organization_id = $2
       returning id, concept, unit_price, approval_status, valid_from::text as valid_from, valid_until::text as valid_until;`,
      [rateId, organizationId, input.unitPrice ?? null, input.approvalStatus ?? null, input.validFrom ?? null, "validUntil" in input, input.validUntil ?? null],
    );
    const row = rows[0];
    if (!row) throw new CompanyDataNotFoundError("Tarifa aprobada", rateId);
    return { id: row.id, concept: row.concept, unitPrice: row.unit_price, currency: "MXN", approvalStatus: row.approval_status, validFrom: dateColumnToExplicitOffsetIso(row.valid_from)!, validUntil: dateColumnToExplicitOffsetIso(row.valid_until) };
  }

  async listAllApprovedRates(organizationId: string): Promise<readonly ApprovedRateRecord[]> {
    const { rows } = await this.db.query<{ id: string; concept: string; unit_price: string; approval_status: ApprovedRateRecord["approvalStatus"]; valid_from: string; valid_until: string | null }>(
      `select id, concept, unit_price, approval_status, valid_from::text as valid_from, valid_until::text as valid_until from licitaciones.approved_rate where organization_id = $1 order by concept asc;`,
      [organizationId],
    );
    return rows.map((r) => ({ id: r.id, concept: r.concept, unitPrice: r.unit_price, currency: "MXN" as const, approvalStatus: r.approval_status, validFrom: dateColumnToExplicitOffsetIso(r.valid_from)!, validUntil: dateColumnToExplicitOffsetIso(r.valid_until) }));
  }

  async createCompanyCapability(organizationId: string, input: CompanyCapabilityCreateInput): Promise<CompanyCapabilityRecord> {
    const existing = await this.db.query<{ id: string }>(`select id from licitaciones.company_capability where organization_id = $1 and name = $2;`, [organizationId, input.name]);
    if (existing.rows.length > 0) throw new CompanyDataDuplicateKeyError("capacidad", input.name);

    const { rows } = await this.db.query<{ id: string; name: string; description: string; evidence_doc_id: string | null; approval_status: CompanyCapabilityRecord["approvalStatus"] }>(
      `insert into licitaciones.company_capability (organization_id, name, description, evidence_doc_id, approval_status)
       values ($1, $2, $3, $4, $5)
       returning id, name, description, evidence_doc_id, approval_status;`,
      [organizationId, input.name, input.description, input.evidenceDocId ?? null, input.approvalStatus ?? "pendiente_aprobacion"],
    );
    const row = rows[0]!;
    return { id: row.id, name: row.name, description: row.description, evidenceDocId: row.evidence_doc_id, approvalStatus: row.approval_status };
  }

  async updateCompanyCapability(organizationId: string, capabilityId: string, input: CompanyCapabilityUpdateInput): Promise<CompanyCapabilityRecord> {
    const { rows } = await this.db.query<{ id: string; name: string; description: string; evidence_doc_id: string | null; approval_status: CompanyCapabilityRecord["approvalStatus"] }>(
      `update licitaciones.company_capability set
         description = coalesce($3, description),
         evidence_doc_id = case when $4::boolean then $5::uuid else evidence_doc_id end,
         approval_status = coalesce($6, approval_status)
       where id = $1 and organization_id = $2
       returning id, name, description, evidence_doc_id, approval_status;`,
      [capabilityId, organizationId, input.description ?? null, "evidenceDocId" in input, input.evidenceDocId ?? null, input.approvalStatus ?? null],
    );
    const row = rows[0];
    if (!row) throw new CompanyDataNotFoundError("Capacidad", capabilityId);
    return { id: row.id, name: row.name, description: row.description, evidenceDocId: row.evidence_doc_id, approvalStatus: row.approval_status };
  }

  async createCompanyExperience(organizationId: string, input: CompanyExperienceCreateInput): Promise<CompanyExperienceItemRecord> {
    const { rows } = await this.db.query<{ id: string; description: string; evidence_doc_id: string; approval_status: CompanyExperienceItemRecord["approvalStatus"] }>(
      `insert into licitaciones.company_experience (organization_id, description, evidence_doc_id, approval_status)
       values ($1, $2, $3, $4)
       returning id, description, evidence_doc_id, approval_status;`,
      [organizationId, input.description, input.evidenceDocId, input.approvalStatus ?? "pendiente_aprobacion"],
    );
    const row = rows[0]!;
    return { id: row.id, description: row.description, evidenceDocId: row.evidence_doc_id, approvalStatus: row.approval_status };
  }

  async updateCompanyExperience(organizationId: string, experienceId: string, input: CompanyExperienceUpdateInput): Promise<CompanyExperienceItemRecord> {
    const { rows } = await this.db.query<{ id: string; description: string; evidence_doc_id: string; approval_status: CompanyExperienceItemRecord["approvalStatus"] }>(
      `update licitaciones.company_experience set
         description = coalesce($3, description),
         evidence_doc_id = coalesce($4, evidence_doc_id),
         approval_status = coalesce($5, approval_status)
       where id = $1 and organization_id = $2
       returning id, description, evidence_doc_id, approval_status;`,
      [experienceId, organizationId, input.description ?? null, input.evidenceDocId ?? null, input.approvalStatus ?? null],
    );
    const row = rows[0];
    if (!row) throw new CompanyDataNotFoundError("Experiencia", experienceId);
    return { id: row.id, description: row.description, evidenceDocId: row.evidence_doc_id, approvalStatus: row.approval_status };
  }

  async createCompanySigner(organizationId: string, input: CompanySignerCreateInput): Promise<CompanySignerRecord> {
    const existing = await this.db.query<{ id: string }>(`select id from licitaciones.company_signer where organization_id = $1 and role = $2;`, [organizationId, input.role]);
    if (existing.rows.length > 0) throw new CompanyDataDuplicateKeyError("firmante", input.role);

    const { rows } = await this.db.query<{ id: string; name: string; role: string; authorized: boolean }>(
      `insert into licitaciones.company_signer (organization_id, name, role, authorized) values ($1, $2, $3, $4) returning id, name, role, authorized;`,
      [organizationId, input.name, input.role, input.authorized ?? false],
    );
    return rows[0]!;
  }

  async updateCompanySigner(organizationId: string, signerId: string, input: CompanySignerUpdateInput): Promise<CompanySignerRecord> {
    const { rows } = await this.db.query<{ id: string; name: string; role: string; authorized: boolean }>(
      `update licitaciones.company_signer set name = coalesce($3, name), authorized = coalesce($4, authorized) where id = $1 and organization_id = $2 returning id, name, role, authorized;`,
      [signerId, organizationId, input.name ?? null, input.authorized ?? null],
    );
    const row = rows[0];
    if (!row) throw new CompanyDataNotFoundError("Firmante", signerId);
    return row;
  }

  async listComplianceItems(organizationId: string, proposalId: string): Promise<readonly ComplianceItemRecord[]> {
    const { rows } = await this.db.query<{ id: string; dimension: string; result: ComplianceItemRecord["result"]; notes: string; evidence_ref: string | null; checked_at: string }>(
      `select id, dimension, result, notes, evidence_ref, checked_at::text as checked_at
       from licitaciones.compliance_item where organization_id = $1 and proposal_id = $2 order by dimension asc;`,
      [organizationId, proposalId],
    );
    return rows.map((r) => ({ id: r.id, dimension: r.dimension, result: r.result, notes: r.notes, evidenceRef: r.evidence_ref, checkedAt: r.checked_at }));
  }

  async replaceComplianceItems(organizationId: string, tenderId: string, proposalId: string, items: readonly ComplianceItemRecord[]): Promise<void> {
    await this.db.query(`delete from licitaciones.compliance_item where organization_id = $1 and proposal_id = $2;`, [organizationId, proposalId]);
    for (const item of items) {
      await this.db.query(
        `insert into licitaciones.compliance_item (organization_id, tender_id, proposal_id, dimension, result, notes, evidence_ref, checked_at)
         values ($1, $2, $3, $4, $5, $6, $7, now());`,
        [organizationId, tenderId, proposalId, item.dimension, item.result, item.notes, item.evidenceRef],
      );
    }
  }

  async listRequiredAnnexes(organizationId: string, tenderId: string): Promise<readonly RequiredAnnexItem[]> {
    const { rows } = await this.db.query<{ id: string; description: string; topic_key: string | null }>(
      `select id, description, topic_key from licitaciones.requirement_item
       where organization_id = $1 and tender_id = $2 and requirement_kind = 'anexo' and obligatoriedad = 'obligatorio' and invalidated_at is null;`,
      [organizationId, tenderId],
    );
    return rows.map((r) => ({ id: r.id, text: r.description, topicKey: r.topic_key ?? undefined }));
  }

  async listCompanyDocuments(organizationId: string, _asOfIso: string): Promise<readonly CompanyDocumentRecord[]> {
    const { rows } = await this.db.query<{ id: string; document_type: string; label: string; expires_at: string | null; approval_status: CompanyDocumentRecord["approvalStatus"] }>(
      `select id, document_type, label, expires_at::text as expires_at, approval_status from licitaciones.company_document where organization_id = $1;`,
      [organizationId],
    );
    return rows.map((r) => ({ id: r.id, type: r.document_type, label: r.label, expiresAt: dateColumnToExplicitOffsetIso(r.expires_at), approvalStatus: r.approval_status }));
  }

  async listCompanyCapabilities(organizationId: string): Promise<readonly CompanyCapabilityRecord[]> {
    const { rows } = await this.db.query<{ id: string; name: string; description: string; evidence_doc_id: string | null; approval_status: CompanyCapabilityRecord["approvalStatus"] }>(
      `select id, name, description, evidence_doc_id, approval_status from licitaciones.company_capability where organization_id = $1;`,
      [organizationId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, evidenceDocId: r.evidence_doc_id, approvalStatus: r.approval_status }));
  }

  async listCompanyExperience(organizationId: string): Promise<readonly CompanyExperienceItemRecord[]> {
    const { rows } = await this.db.query<{ id: string; description: string; evidence_doc_id: string; approval_status: CompanyExperienceItemRecord["approvalStatus"] }>(
      `select id, description, evidence_doc_id, approval_status from licitaciones.company_experience where organization_id = $1;`,
      [organizationId],
    );
    return rows.map((r) => ({ id: r.id, description: r.description, evidenceDocId: r.evidence_doc_id, approvalStatus: r.approval_status }));
  }

  async listCompanySigners(organizationId: string): Promise<readonly CompanySignerRecord[]> {
    const { rows } = await this.db.query<{ id: string; name: string; role: string; authorized: boolean }>(
      `select id, name, role, authorized from licitaciones.company_signer where organization_id = $1;`,
      [organizationId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, authorized: r.authorized }));
  }

  async listApprovedRates(organizationId: string, asOfIso: string): Promise<readonly ApprovedRateRecord[]> {
    const { rows } = await this.db.query<{ id: string; concept: string; unit_price: string; approval_status: ApprovedRateRecord["approvalStatus"]; valid_from: string; valid_until: string | null }>(
      `select id, concept, unit_price, approval_status, valid_from::text as valid_from, valid_until::text as valid_until
       from licitaciones.approved_rate
       where organization_id = $1 and approval_status = 'aprobado' and valid_from <= $2::timestamptz and (valid_until is null or valid_until >= $2::timestamptz);`,
      [organizationId, asOfIso],
    );
    return rows.map((r) => ({ id: r.id, concept: r.concept, unitPrice: r.unit_price, currency: "MXN" as const, approvalStatus: r.approval_status, validFrom: dateColumnToExplicitOffsetIso(r.valid_from)!, validUntil: dateColumnToExplicitOffsetIso(r.valid_until) }));
  }

  async saveEconomicGeneration(
    organizationId: string,
    proposalId: string,
    input: {
      actorId: string;
      economicTotals: unknown | null;
      generationReportPatch: unknown;
      correlationId: string | null;
      cartaSection?: { content: string; sources: unknown };
      anexoSection?: { content: string; sources: unknown };
    },
  ): Promise<ProposalRecord> {
    const { rows } = await this.db.query<ProposalRow>(
      `update licitaciones.proposal
       set economic_totals = $1::jsonb,
           generation_report = coalesce(generation_report, '{}'::jsonb) || jsonb_build_object('economic', $2::jsonb),
           correlation_id = $3,
           updated_at = now()
       where organization_id = $4 and id = $5
       returning ${PROPOSAL_COLUMNS};`,
      [input.economicTotals === null ? null : JSON.stringify(input.economicTotals), JSON.stringify(input.generationReportPatch), input.correlationId, organizationId, proposalId],
    );
    const updated = mapProposal(rows[0]!);

    if (input.cartaSection) await this.upsertSection(organizationId, proposalId, "economic:carta", "Carta de proposición económica", input.cartaSection.content, input.actorId);
    if (input.anexoSection) await this.upsertSection(organizationId, proposalId, "economic:anexo", "Anexo económico", input.anexoSection.content, input.actorId);

    return updated;
  }

  private async upsertSection(organizationId: string, proposalId: string, sectionKey: string, label: string, content: string, actorId: string): Promise<void> {
    await this.db.query(
      `insert into licitaciones.proposal_section (organization_id, proposal_id, section_key, label, filename, content, version)
       values ($1, $2, $3, $4, $5, $6, 1)
       on conflict (proposal_id, section_key) do update
         set content = excluded.content, label = excluded.label, version = licitaciones.proposal_section.version + 1, updated_at = now();`,
      [organizationId, proposalId, sectionKey, label, `${sectionKey}.txt`, content],
    );
    await this.recordSectionAuthor(organizationId, proposalId, sectionKey, actorId);
  }

  /**
   * AE-11: registra que `actorId` redactó/editó `sectionKey` -- llamado
   * SIEMPRE desde este adaptador cada vez que se persiste contenido de una
   * sección (nunca depende de que una ruta Hono se acuerde de invocarlo por
   * separado, ver diseño Fase 2 §2.3). `actorId` proviene del `input`
   * construido por la ruta a partir de la sesión autenticada
   * (`c.get("userId")`), nunca del cuerpo del request.
   */
  private async recordSectionAuthor(organizationId: string, proposalId: string, sectionKey: string, actorId: string): Promise<void> {
    await this.db.query(
      `insert into licitaciones.section_author (organization_id, proposal_id, section_key, actor_id)
       values ($1, $2, $3, $4)
       on conflict (proposal_id, section_key, actor_id) do nothing;`,
      [organizationId, proposalId, sectionKey, actorId],
    );
  }

  async loadProposalSectionsAsDocuments(organizationId: string, proposalId: string): Promise<readonly { documentId: string; label: string; filename: string; version: number; content?: string }[]> {
    const { rows } = await this.db.query<{ id: string; label: string; filename: string; version: number; content: string }>(
      `select id, label, filename, version, content from licitaciones.proposal_section where organization_id = $1 and proposal_id = $2 order by section_key asc;`,
      [organizationId, proposalId],
    );
    return rows.map((r) => ({ documentId: r.id, label: r.label, filename: r.filename, version: r.version, content: r.content }));
  }

  async computeCurrentInputsHash(organizationId: string, tenderId: string, proposalId: string): Promise<{ hash: string; raw: unknown }> {
    const tender = await this.findTender(organizationId, tenderId);
    if (!tender) throw new Error(`Tender "${tenderId}" no encontrado para la organización "${organizationId}".`);
    const proposal = await this.db.query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from licitaciones.proposal where organization_id = $1 and id = $2;`, [organizationId, proposalId]);
    const proposalRow = proposal.rows[0];
    if (!proposalRow) throw new Error(`Proposal "${proposalId}" no encontrada para la organización "${organizationId}".`);
    const proposalRecord = mapProposal(proposalRow);

    const usedCompanyDocumentIds = proposalRecord.generationReport?.technical?.usedCompanyDocumentIds ?? [];
    const usedRateConcepts = proposalRecord.generationReport?.economic?.usedRateConcepts ?? [];

    const documents = usedCompanyDocumentIds.length > 0
      ? (
          await this.db.query<{ id: string; expires_at: string | null }>(`select id, expires_at::text as expires_at from licitaciones.company_document where organization_id = $1 and id = any($2::uuid[]);`, [
              organizationId,
              usedCompanyDocumentIds,
            ])
        ).rows
      : [];
    const rates = usedRateConcepts.length > 0
      ? (
          await this.db.query<{ concept: string; unit_price: string }>(`select concept, unit_price from licitaciones.approved_rate where organization_id = $1 and concept = any($2::text[]);`, [
              organizationId,
              usedRateConcepts,
            ])
        ).rows
      : [];

    const raw: ExpedienteInputs = {
      tenderVersionHash: sha256Hex({ updatedAt: tender.updatedAt, submissionDeadline: tender.submissionDeadline }),
      companyProfileHash: sha256Hex("licitaciones:fase1:company-profile-fijo"),
      companyDocuments: usedCompanyDocumentIds.map((id) => {
        const doc = documents.find((d) => d.id === id);
        return { documentId: id, hash: sha256Hex(doc ?? null), vigenteHasta: doc?.expires_at ?? null };
      }),
      rates: usedRateConcepts.map((concept) => {
        const rate = rates.find((r) => r.concept === concept);
        return { concept, hash: sha256Hex(rate ?? null) };
      }),
      templates: [],
    };

    const sealed = sealInputs(raw);
    return { hash: sealed.hash, raw };
  }

  // ---- Fase 2 pieza 3: RequirementMatrix / TechnicalProposalBuilder ----

  async replaceRequirementItems(organizationId: string, tenderId: string, items: readonly RequirementItemRecord[]): Promise<void> {
    await this.db.query(`delete from licitaciones.requirement_item where organization_id = $1 and tender_id = $2;`, [organizationId, tenderId]);
    for (const item of items) {
      await this.db.query(
        `insert into licitaciones.requirement_item
           (id, organization_id, tender_id, document_id, description, requirement_kind, obligatoriedad, topic_key, required_evidence, extracted_by, page, clause, responsible_role, deadline, status, confidence)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15, $16);`,
        [
          item.id,
          organizationId,
          tenderId,
          item.documentId,
          item.text,
          item.requirementKind,
          item.obligatoriedad,
          item.topicKey,
          item.requiredEvidence,
          item.extractedBy,
          item.page,
          item.clause,
          item.responsibleRole,
          item.deadline,
          item.status,
          item.confidence,
        ],
      );
    }
  }

  async listRequirementItems(organizationId: string, tenderId: string): Promise<readonly RequirementItemRecord[]> {
    const { rows } = await this.db.query<{
      id: string;
      document_id: string | null;
      description: string;
      requirement_kind: RequirementItemRecord["requirementKind"];
      obligatoriedad: RequirementItemRecord["obligatoriedad"];
      topic_key: string | null;
      required_evidence: string[];
      extracted_by: RequirementItemRecord["extractedBy"];
      page: number | null;
      clause: string | null;
      responsible_role: string;
      deadline: string | null;
      status: RequirementItemRecord["status"];
      confidence: string | null;
    }>(
      `select id, document_id, description, requirement_kind, obligatoriedad, topic_key, required_evidence, extracted_by, page, clause, responsible_role, deadline::text as deadline, status, confidence::text as confidence
       from licitaciones.requirement_item where organization_id = $1 and tender_id = $2 and invalidated_at is null order by created_at asc;`,
      [organizationId, tenderId],
    );
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      text: r.description,
      requirementKind: r.requirement_kind,
      obligatoriedad: r.obligatoriedad,
      topicKey: r.topic_key,
      requiredEvidence: r.required_evidence,
      extractedBy: r.extracted_by,
      page: r.page,
      clause: r.clause,
      responsibleRole: r.responsible_role,
      deadline: r.deadline,
      status: r.status,
      confidence: r.confidence === null ? null : Number(r.confidence),
    }));
  }

  async listFulfillmentMappings(organizationId: string): Promise<readonly RequirementFulfillmentMappingRecord[]> {
    const { rows } = await this.db.query<{ id: string; topic_key: string; kind: RequirementFulfillmentMappingRecord["kind"]; ref_key: string; statement_template: string }>(
      `select id, topic_key, kind, ref_key, statement_template from licitaciones.requirement_fulfillment_mapping where organization_id = $1;`,
      [organizationId],
    );
    return rows.map((r) => ({ id: r.id, topicKey: r.topic_key, kind: r.kind, refKey: r.ref_key, statementTemplate: r.statement_template }));
  }

  async upsertFulfillmentMapping(
    organizationId: string,
    input: { topicKey: string; kind: RequirementFulfillmentMappingRecord["kind"]; refKey: string; statementTemplate: string },
  ): Promise<RequirementFulfillmentMappingRecord> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into licitaciones.requirement_fulfillment_mapping (organization_id, topic_key, kind, ref_key, statement_template)
       values ($1, $2, $3, $4, $5)
       on conflict (organization_id, topic_key) do update
         set kind = excluded.kind, ref_key = excluded.ref_key, statement_template = excluded.statement_template, updated_at = now()
       returning id;`,
      [organizationId, input.topicKey, input.kind, input.refKey, input.statementTemplate],
    );
    return { id: rows[0]!.id, topicKey: input.topicKey, kind: input.kind, refKey: input.refKey, statementTemplate: input.statementTemplate };
  }

  async saveTechnicalSections(
    organizationId: string,
    proposalId: string,
    input: {
      actorId: string;
      sections: readonly { sectionKey: string; label: string; content: string }[];
      usedCompanyDocumentIds: readonly string[];
      notApplicableRequirements: readonly { requirementId: string; reason: string }[];
    },
  ): Promise<ProposalRecord> {
    const { rows } = await this.db.query<ProposalRow>(
      `update licitaciones.proposal
       set generation_report = coalesce(generation_report, '{}'::jsonb) || jsonb_build_object('technical', $1::jsonb),
           updated_at = now()
       where organization_id = $2 and id = $3
       returning ${PROPOSAL_COLUMNS};`,
      [JSON.stringify({ usedCompanyDocumentIds: input.usedCompanyDocumentIds, notApplicableRequirements: input.notApplicableRequirements }), organizationId, proposalId],
    );
    const updated = mapProposal(rows[0]!);

    for (const section of input.sections) {
      await this.upsertSection(organizationId, proposalId, section.sectionKey, section.label, section.content, input.actorId);
    }

    return updated;
  }

  // ---- Fase 2 pieza 1: máquina de aprobaciones granular (AE-02/AE-11) ----

  async approve(organizationId: string, proposalId: string, input: { scope: ApprovalScope; scopeRef: string; actorId: string; actorRole: LicitacionesRole; inputsHash: HashedInputs }): Promise<Approval> {
    // AE-11: hidrata la máquina pura de dominio con la autoría de sección
    // REALMENTE persistida -- nunca confía en nada que el llamador declare.
    const { rows: authorRows } = await this.db.query<{ section_key: string; actor_id: string }>(
      `select section_key, actor_id from licitaciones.section_author where organization_id = $1 and proposal_id = $2;`,
      [organizationId, proposalId],
    );
    const sectionAuthors = new Map<string, Set<string>>();
    for (const row of authorRows) {
      const scopeRef = `seccion:${row.section_key}`;
      const set = sectionAuthors.get(scopeRef) ?? new Set<string>();
      set.add(row.actor_id);
      sectionAuthors.set(scopeRef, set);
    }

    // Lanza `ApprovalRejectedError` si la regla rechaza (rol no autorizado,
    // AE-02, o autoaprobación AE-11) -- ninguna fila se toca en ese caso.
    new ApprovalWorkflow({ sectionAuthors }).approve({ scope: input.scope, scopeRef: input.scopeRef, actorId: input.actorId, actorRole: input.actorRole, inputsHash: input.inputsHash });

    // La validación pasó: invalida cualquier aprobación previa 'vigente' de
    // EXACTAMENTE el mismo scope/scopeRef antes de insertar la nueva (nunca
    // coexisten dos vigentes del mismo alcance exacto).
    await this.db.query(
      `update licitaciones.approval set status = 'invalidada', invalidated_at = now(), invalidated_reason = 'superseded_by_new_approval'
       where organization_id = $1 and proposal_id = $2 and scope_ref = $3 and status = 'vigente';`,
      [organizationId, proposalId, input.scopeRef],
    );

    const { rows } = await this.db.query<ApprovalRow>(
      `insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${APPROVAL_COLUMNS};`,
      [organizationId, proposalId, input.scope, input.scopeRef, input.actorId, input.actorRole, input.inputsHash.hash],
    );
    return mapApproval(rows[0]!);
  }

  async activeApprovalsCovering(organizationId: string, proposalId: string, scopeRef: string): Promise<readonly Approval[]> {
    const ancestors = scopeRef === "expediente" ? ["expediente"] : ["expediente", scopeRef];
    const { rows } = await this.db.query<ApprovalRow>(
      `select ${APPROVAL_COLUMNS} from licitaciones.approval
       where organization_id = $1 and proposal_id = $2 and status = 'vigente' and scope_ref = any($3::text[]);`,
      [organizationId, proposalId, ancestors],
    );
    return rows.map(mapApproval);
  }

  async recordChange(organizationId: string, proposalId: string, input: { scope: ApprovalScope; scopeRef: string; reason: string }): Promise<ChangeDetected> {
    const covering = await this.activeApprovalsCovering(organizationId, proposalId, input.scopeRef);
    const invalidatedIds = covering.map((a) => a.id);
    if (invalidatedIds.length > 0) {
      await this.db.query(`update licitaciones.approval set status = 'invalidada', invalidated_at = now(), invalidated_reason = $1 where id = any($2::uuid[]);`, [input.reason, invalidatedIds]);
    }
    const { rows } = await this.db.query<{ id: string; detected_at: string }>(
      `insert into licitaciones.approval_change (organization_id, proposal_id, scope, scope_ref, reason, invalidated_approval_ids)
       values ($1, $2, $3, $4, $5, $6::uuid[])
       returning id, detected_at::text as detected_at;`,
      [organizationId, proposalId, input.scope, input.scopeRef, input.reason, invalidatedIds],
    );
    return { id: rows[0]!.id, scope: input.scope, scopeRef: input.scopeRef, reason: input.reason, detectedAt: rows[0]!.detected_at, invalidatedApprovalIds: invalidatedIds };
  }

  async syncExpedienteApprovalWithCurrentHash(organizationId: string, proposalId: string, sealed: HashedInputs, raw: ExpedienteInputs): Promise<ChangeDetected | null> {
    const { hash } = requireValidHashedInputs(sealed, "syncExpedienteApprovalWithCurrentHash(sealed)");
    const latest = await this.latestProposalVersion(organizationId, proposalId);
    if (!latest || latest.hash !== hash) {
      const nextVersion = (latest?.version ?? 0) + 1;
      const inputRecords = buildProposalInputRecords(raw);
      await this.db.query(
        `insert into licitaciones.proposal_version (organization_id, proposal_id, version, hash, inputs)
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict (proposal_id, version) do nothing;`,
        [organizationId, proposalId, nextVersion, hash, JSON.stringify(inputRecords)],
      );
    }

    const [currentExpedienteApproval] = await this.activeApprovalsCovering(organizationId, proposalId, "expediente");
    if (!currentExpedienteApproval || currentExpedienteApproval.inputsHash === hash) return null;

    const changedKeys = latest ? ProposalVersionRegistry.diff(latest.inputs, raw) : [];
    const reason = changedKeys.length > 0 ? `insumo_cambiado:${changedKeys.join(",")}` : `hash_insumos_divergente:aprobado=${currentExpedienteApproval.inputsHash}:actual=${hash}`;

    return this.recordChange(organizationId, proposalId, { scope: "expediente", scopeRef: "expediente", reason });
  }

  async latestProposalVersion(organizationId: string, proposalId: string): Promise<PersistedProposalVersion | null> {
    const { rows } = await this.db.query<{ version: number; hash: string; inputs: ProposalInputRecord[]; created_at: string }>(
      `select version, hash, inputs, created_at::text as created_at from licitaciones.proposal_version
       where organization_id = $1 and proposal_id = $2 order by version desc limit 1;`,
      [organizationId, proposalId],
    );
    const row = rows[0];
    return row ? { version: row.version, hash: row.hash, inputs: row.inputs, createdAt: row.created_at } : null;
  }

  async saveManifest(
    organizationId: string,
    proposalId: string,
    input: { status: "draft" | "ready"; manifest: unknown; checklistSnapshot: unknown; storageRef: string; inputsHash: string; correlationId: string | null; generatedBy: string },
  ): Promise<{ id: string; generatedAt: string }> {
    const { rows } = await this.db.query<{ id: string; generated_at: string }>(
      `insert into licitaciones.package_manifest (organization_id, proposal_id, status, manifest, checklist_snapshot, storage_ref, inputs_hash, correlation_id, generated_by)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
       returning id, generated_at::text as generated_at;`,
      [organizationId, proposalId, input.status, JSON.stringify(input.manifest), JSON.stringify(input.checklistSnapshot), input.storageRef, input.inputsHash, input.correlationId, input.generatedBy],
    );
    return { id: rows[0]!.id, generatedAt: rows[0]!.generated_at };
  }

  async findLatestManifest(organizationId: string, proposalId: string): Promise<PackageManifestRecord | null> {
    const { rows } = await this.db.query<{ id: string; status: "draft" | "ready"; manifest: unknown; checklist_snapshot: unknown; storage_ref: string; inputs_hash: string; generated_at: string }>(
      `select id, status, manifest, checklist_snapshot, storage_ref, inputs_hash, generated_at::text as generated_at
       from licitaciones.package_manifest where organization_id = $1 and proposal_id = $2 order by generated_at desc limit 1;`,
      [organizationId, proposalId],
    );
    const row = rows[0];
    return row
      ? { id: row.id, status: row.status, manifest: row.manifest, checklistSnapshot: row.checklist_snapshot, storageRef: row.storage_ref, inputsHash: row.inputs_hash, generatedAt: row.generated_at }
      : null;
  }

  // Hallazgo de auditoría (severidad CRÍTICA, ver migrations/022_persistent_file_storage.sql):
  // el contenido vive DENTRO de Postgres (`licitaciones.file_blob`, bytea bajo RLS)
  // en vez de filesystem local (`storage.ts`, efímero en una función serverless de
  // Vercel -- cada invocación tiene su propio `/tmp`, así que un ZIP ensamblado en
  // una invocación quedaba irrecuperable en la siguiente). `storageRef` sigue
  // siendo un `text` opaco de cara al resto del repositorio (`package_manifest.storage_ref`/
  // `submission.acknowledgement_storage_ref` no cambian de tipo) -- ahora es el
  // uuid de la fila en `file_blob` en vez de una ruta relativa de disco.
  async writeManifestZip(organizationId: string, proposalId: string, zip: Uint8Array): Promise<string> {
    void proposalId; // conservado en la firma (paridad con la interfaz) -- el blob no lo necesita, ya vive en `package_manifest.proposal_id`.
    const { rows } = await this.db.query<{ id: string }>(
      `insert into licitaciones.file_blob (organization_id, sha256, size_bytes, content)
       values ($1, $2, $3, $4)
       returning id;`,
      [organizationId, sha256Bytes(zip), zip.byteLength, Buffer.from(zip)],
    );
    return rows[0]!.id;
  }

  async readManifestZip(storageRef: string): Promise<Uint8Array> {
    const { rows } = await this.db.query<{ content: Buffer }>(`select content from licitaciones.file_blob where id = $1;`, [storageRef]);
    const row = rows[0];
    if (!row) throw new Error(`Expediente no encontrado en almacenamiento persistente (storageRef=${storageRef}).`);
    return new Uint8Array(row.content);
  }

  // Dedupe por hash de contenido dentro de la misma organización -- mismo criterio
  // que `storage.ts::storeFile` original ("subir el mismo contenido dos veces
  // nunca duplica el archivo"): dos declaraciones de presentación que suban el
  // MISMO acuse (bytes idénticos) reusan la misma fila de `file_blob` en vez de
  // insertar una copia.
  async storeAcknowledgement(organizationId: string, buffer: Uint8Array): Promise<{ storageRef: string; sha256: string }> {
    const sha256 = sha256Bytes(buffer);
    const { rows: existing } = await this.db.query<{ id: string }>(
      `select id from licitaciones.file_blob where organization_id = $1 and sha256 = $2 limit 1;`,
      [organizationId, sha256],
    );
    if (existing[0]) return { storageRef: existing[0].id, sha256 };
    const { rows } = await this.db.query<{ id: string }>(
      `insert into licitaciones.file_blob (organization_id, sha256, size_bytes, content)
       values ($1, $2, $3, $4)
       returning id;`,
      [organizationId, sha256, buffer.byteLength, Buffer.from(buffer)],
    );
    return { storageRef: rows[0]!.id, sha256 };
  }

  async findSubmission(organizationId: string, proposalId: string): Promise<SubmissionRecord | null> {
    const { rows } = await this.db.query<{
      id: string;
      status: "submitted";
      submitted_at: string;
      acknowledgement_storage_ref: string | null;
      acknowledgement_file_hash: string | null;
      notes: string | null;
      created_at: string;
    }>(
      `select id, status, submitted_at::text as submitted_at, acknowledgement_storage_ref, acknowledgement_file_hash, notes, created_at::text as created_at
       from licitaciones.submission where organization_id = $1 and proposal_id = $2 order by created_at desc limit 1;`,
      [organizationId, proposalId],
    );
    const row = rows[0];
    return row
      ? { id: row.id, status: row.status, submittedAt: row.submitted_at, acknowledgementStorageRef: row.acknowledgement_storage_ref, acknowledgementFileHash: row.acknowledgement_file_hash, notes: row.notes, createdAt: row.created_at }
      : null;
  }

  async declareSubmission(
    organizationId: string,
    proposalId: string,
    input: { userId: string; submittedAt: string; acknowledgementStorageRef: string | null; acknowledgementFileHash: string | null; notes: string | null },
  ): Promise<SubmissionRecord> {
    const { rows } = await this.db.query<{ id: string; created_at: string }>(
      `insert into licitaciones.submission (organization_id, proposal_id, submitted_by, submitted_at, acknowledgement_storage_ref, acknowledgement_file_hash, notes)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, created_at::text as created_at;`,
      [organizationId, proposalId, input.userId, input.submittedAt, input.acknowledgementStorageRef, input.acknowledgementFileHash, input.notes],
    );
    return {
      id: rows[0]!.id,
      status: "submitted",
      submittedAt: input.submittedAt,
      acknowledgementStorageRef: input.acknowledgementStorageRef,
      acknowledgementFileHash: input.acknowledgementFileHash,
      notes: input.notes,
      createdAt: rows[0]!.created_at,
    };
  }

  async withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>> {
    const requestHash = hashBody(params.body);

    const claim = await this.db.query<{ id: string }>(
      `insert into licitaciones.idempotency_key (organization_id, scope, key, request_hash, expires_at)
       values ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
       on conflict (organization_id, scope, key) do update
         set request_hash = excluded.request_hash,
             response = null,
             created_at = now(),
             expires_at = excluded.expires_at
         where licitaciones.idempotency_key.expires_at < now()
       returning id;`,
      [params.organizationId, params.scope, params.key, requestHash, String(IDEMPOTENCY_KEY_TTL_DAYS)],
    );

    if (claim.rows.length === 0) {
      const existing = await this.db.query<{ request_hash: string; response: IdempotentResult<T> | null }>(
        `select request_hash, response from licitaciones.idempotency_key where organization_id = $1 and scope = $2 and key = $3;`,
        [params.organizationId, params.scope, params.key],
      );
      const row = existing.rows[0];
      if (!row) {
        // La fila que causó el conflicto se revirtió entre el INSERT y este
        // SELECT: trátese como si nunca hubiera existido, reintenta una vez.
        return this.withIdempotency(params, run);
      }
      if (row.request_hash !== requestHash) throw new IdempotencyConflictError();
      if (row.response == null) {
        throw new Error("La solicitud original con este Idempotency-Key aún no terminó de procesarse.");
      }
      return row.response;
    }

    const result = await run();

    await this.db.query(`update licitaciones.idempotency_key set response = $1 where organization_id = $2 and scope = $3 and key = $4;`, [
      JSON.stringify(result),
      params.organizationId,
      params.scope,
      params.key,
    ]);

    return result;
  }

  // ---------------------------------------------------------------------
  // Fase 6 -- seguimiento post-adjudicación (REQ-051..055).
  // ---------------------------------------------------------------------

  private async requireContractRow(organizationId: string, tenderId: string): Promise<ContractRow> {
    const { rows } = await this.db.query<ContractRow>(`select ${CONTRACT_COLUMNS} from licitaciones.contract where organization_id = $1 and tender_id = $2;`, [organizationId, tenderId]);
    const row = rows[0];
    if (!row) throw new Error(`No existe contrato registrado para la convocatoria "${tenderId}" en la organización "${organizationId}".`);
    return row;
  }

  async createContract(organizationId: string, tenderId: string, actorId: string): Promise<ContractRecord> {
    const existing = await this.db.query<{ id: string }>(`select id from licitaciones.contract where organization_id = $1 and tender_id = $2;`, [organizationId, tenderId]);
    if (existing.rows.length > 0) throw new Error("Ya existe un contrato registrado para esta convocatoria.");

    const { rows } = await this.db.query<ContractRow>(
      `insert into licitaciones.contract (organization_id, tender_id, status, created_by) values ($1, $2, $3, $4) returning ${CONTRACT_COLUMNS};`,
      [organizationId, tenderId, CONTRACT_INITIAL_STATUS, actorId],
    );
    const contract = rows[0]!;
    await this.db.query(
      `insert into licitaciones.contract_status_history (organization_id, contract_id, from_status, to_status, reason, actor_id)
       values ($1, $2, null, $3, $4, $5);`,
      [organizationId, contract.id, CONTRACT_INITIAL_STATUS, "Alta del contrato tras adjudicación.", actorId],
    );
    return mapContract(contract);
  }

  async findContractByTender(organizationId: string, tenderId: string): Promise<ContractRecord | null> {
    const { rows } = await this.db.query<ContractRow>(`select ${CONTRACT_COLUMNS} from licitaciones.contract where organization_id = $1 and tender_id = $2;`, [organizationId, tenderId]);
    const row = rows[0];
    return row ? mapContract(row) : null;
  }

  async updateContractMetadata(organizationId: string, tenderId: string, input: ContractMetadataUpdateInput): Promise<ContractRecord> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    const { rows } = await this.db.query<ContractRow>(
      `update licitaciones.contract set
         end_date = case when $1::boolean then $2::date else end_date end,
         contract_number = case when $3::boolean then $4 else contract_number end,
         has_renewal_option = case when $5::boolean then $6::boolean else has_renewal_option end,
         renewal_option_notes = case when $7::boolean then $8 else renewal_option_notes end,
         updated_at = now()
       where id = $9 and organization_id = $10
       returning ${CONTRACT_COLUMNS};`,
      [
        "endDate" in input,
        input.endDate ?? null,
        "contractNumber" in input,
        input.contractNumber ?? null,
        "hasRenewalOption" in input,
        input.hasRenewalOption ?? null,
        "renewalOptionNotes" in input,
        input.renewalOptionNotes ?? null,
        contract.id,
        organizationId,
      ],
    );
    return mapContract(rows[0]!);
  }

  async transitionContract(organizationId: string, tenderId: string, input: ContractTransitionInput): Promise<ContractRecord> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    const fromStatus = contract.status;
    if (!isContractStatus(input.toStatus)) {
      throw new Error(`Estado de contrato desconocido: "${input.toStatus}".`);
    }
    const toStatus = input.toStatus;
    const check = checkTransition(fromStatus, toStatus);
    if (!check.valid) {
      throw new ContractTransitionRejectedError(fromStatus, toStatus, check.allowedNextStates);
    }

    // Mismo patrón de UPDATE condicionado sobre el estado leído que
    // `upsertTenderManual`/`createGoNoGoDecision` de este archivo -- bajo
    // READ COMMITTED, dos transiciones concurrentes que parten del MISMO
    // `fromStatus` nunca pueden tener éxito ambas.
    const updated = await this.db.query<ContractRow>(
      `update licitaciones.contract set status = $1, updated_at = now() where id = $2 and organization_id = $3 and status = $4 returning ${CONTRACT_COLUMNS};`,
      [toStatus, contract.id, organizationId, fromStatus],
    );
    if (updated.rows.length === 0) {
      const current = await this.db.query<{ status: ContractStatus }>(`select status from licitaciones.contract where id = $1 and organization_id = $2;`, [contract.id, organizationId]);
      const currentStatus = current.rows[0]?.status ?? fromStatus;
      throw new ContractTransitionRejectedError(currentStatus, toStatus, checkTransition(currentStatus, toStatus).allowedNextStates);
    }

    await this.db.query(
      `insert into licitaciones.contract_status_history (organization_id, contract_id, from_status, to_status, reason, actor_id, evidence_ref)
       values ($1, $2, $3, $4, $5, $6, $7);`,
      [organizationId, contract.id, fromStatus, toStatus, input.reason, input.actorId, input.evidenceRef],
    );
    return mapContract(updated.rows[0]!);
  }

  async listContractStatusHistory(organizationId: string, tenderId: string): Promise<readonly ContractStatusHistoryRecord[]> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    const { rows } = await this.db.query<ContractStatusHistoryRow>(
      `select id, contract_id, from_status, to_status, reason, actor_id, evidence_ref, created_at::text as created_at
       from licitaciones.contract_status_history where organization_id = $1 and contract_id = $2 order by created_at asc;`,
      [organizationId, contract.id],
    );
    return rows.map(mapContractStatusHistory);
  }

  async addContractDocument(
    organizationId: string,
    tenderId: string,
    input: AddContractDocumentInput,
  ): Promise<{ document: ContractDocumentRecord; fields: readonly ContractExtractedFieldRecord[] }> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    const { rows } = await this.db.query<ContractDocumentRow>(
      `insert into licitaciones.contract_document (organization_id, contract_id, document_label, page_count, uploaded_by)
       values ($1, $2, $3, $4, $5)
       returning id, contract_id, document_label, page_count, uploaded_by, created_at::text as created_at;`,
      [organizationId, contract.id, input.documentLabel, input.pages.length, input.actorId],
    );
    const document = mapContractDocument(rows[0]!);

    const extracted = extractContractFields(input.pages);
    const fields: ContractExtractedFieldRecord[] = [];
    for (const field of extracted) {
      const inserted = await this.db.query<ContractExtractedFieldRow>(
        `insert into licitaciones.contract_extracted_field
           (organization_id, contract_document_id, field_key, extracted_value, source_page, source_clause, confidence, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'sugerido')
         returning ${CONTRACT_EXTRACTED_FIELD_COLUMNS};`,
        [organizationId, document.id, field.fieldKey, field.value, field.sourcePage, field.sourceClause, field.confidence],
      );
      fields.push(mapContractExtractedField(inserted.rows[0]!));
    }
    return { document, fields };
  }

  async listContractDocuments(organizationId: string, tenderId: string): Promise<readonly ContractDocumentRecord[]> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    const { rows } = await this.db.query<ContractDocumentRow>(
      `select id, contract_id, document_label, page_count, uploaded_by, created_at::text as created_at
       from licitaciones.contract_document where organization_id = $1 and contract_id = $2 order by created_at asc;`,
      [organizationId, contract.id],
    );
    return rows.map(mapContractDocument);
  }

  async listContractExtractedFields(organizationId: string, tenderId: string, documentId: string): Promise<readonly ContractExtractedFieldRecord[]> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    const doc = await this.db.query<{ id: string }>(`select id from licitaciones.contract_document where id = $1 and organization_id = $2 and contract_id = $3;`, [
      documentId,
      organizationId,
      contract.id,
    ]);
    if (doc.rows.length === 0) throw new Error(`Documento de contrato "${documentId}" no encontrado.`);
    const { rows } = await this.db.query<ContractExtractedFieldRow>(
      `select ${CONTRACT_EXTRACTED_FIELD_COLUMNS} from licitaciones.contract_extracted_field where organization_id = $1 and contract_document_id = $2 order by created_at asc;`,
      [organizationId, documentId],
    );
    return rows.map(mapContractExtractedField);
  }

  async confirmContractExtractedField(
    organizationId: string,
    tenderId: string,
    fieldId: string,
    input: ConfirmContractExtractedFieldInput,
  ): Promise<ContractExtractedFieldRecord> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    if (input.action === "correct" && (!input.correctedValue || input.correctedValue.trim().length === 0)) {
      throw new Error('correctedValue es obligatorio y no vacío cuando action="correct".');
    }
    // El campo debe pertenecer a un documento del contrato de ESTE
    // `tenderId`, no solo a la organización (mismo criterio de anidamiento
    // real que el resto de este vertical).
    const existing = await this.db.query<ContractExtractedFieldRow>(
      `select f.id, f.contract_document_id, f.field_key, f.extracted_value, f.source_page, f.source_clause, f.confidence::text as confidence,
              f.status, f.confirmed_value, f.confirmed_by, f.confirmed_at::text as confirmed_at, f.created_at::text as created_at
       from licitaciones.contract_extracted_field f
       join licitaciones.contract_document d on d.id = f.contract_document_id and d.organization_id = f.organization_id
       where f.id = $1 and f.organization_id = $2 and d.contract_id = $3;`,
      [fieldId, organizationId, contract.id],
    );
    if (existing.rows.length === 0) throw new Error(`Campo extraído "${fieldId}" no encontrado para el contrato de la convocatoria "${tenderId}".`);

    const newStatus = input.action === "confirm" ? "confirmado" : "corregido";
    const confirmedValue = input.action === "confirm" ? existing.rows[0]!.extracted_value : input.correctedValue;
    const { rows } = await this.db.query<ContractExtractedFieldRow>(
      `update licitaciones.contract_extracted_field set status = $1, confirmed_value = $2, confirmed_by = $3, confirmed_at = now()
       where id = $4 and organization_id = $5
       returning ${CONTRACT_EXTRACTED_FIELD_COLUMNS};`,
      [newStatus, confirmedValue, input.actorId, fieldId, organizationId],
    );
    return mapContractExtractedField(rows[0]!);
  }

  async createContractInvoice(organizationId: string, tenderId: string, input: CreateContractInvoiceInput): Promise<ContractInvoiceRecord> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    const due = computePaymentDueDate(input.invoiceVerifiedOn);
    const { rows } = await this.db.query<ContractInvoiceRow>(
      `insert into licitaciones.contract_invoice (organization_id, contract_id, concepto, amount, invoice_verified_on, due_date, legal_reference, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${CONTRACT_INVOICE_COLUMNS};`,
      [organizationId, contract.id, input.concepto, input.amount, input.invoiceVerifiedOn, due.dueDate, due.legalReference, input.actorId],
    );
    return mapContractInvoice(rows[0]!);
  }

  async listContractInvoices(organizationId: string, tenderId: string): Promise<readonly ContractInvoiceRecord[]> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    const { rows } = await this.db.query<ContractInvoiceRow>(
      `select ${CONTRACT_INVOICE_COLUMNS} from licitaciones.contract_invoice where organization_id = $1 and contract_id = $2 order by invoice_verified_on asc;`,
      [organizationId, contract.id],
    );
    return rows.map(mapContractInvoice);
  }

  async markContractInvoicePaid(organizationId: string, tenderId: string, invoiceId: string, _actorId: string): Promise<ContractInvoiceRecord> {
    const contract = await this.requireContractRow(organizationId, tenderId);
    const { rows } = await this.db.query<ContractInvoiceRow>(
      `update licitaciones.contract_invoice set paid_at = now() where id = $1 and organization_id = $2 and contract_id = $3 returning ${CONTRACT_INVOICE_COLUMNS};`,
      [invoiceId, organizationId, contract.id],
    );
    if (rows.length === 0) throw new Error(`Factura "${invoiceId}" no encontrada para el contrato de la convocatoria "${tenderId}".`);
    return mapContractInvoice(rows[0]!);
  }

  async receivablesSummary(organizationId: string, tenderId: string): Promise<ReceivablesSummary> {
    const invoices = await this.listContractInvoices(organizationId, tenderId);
    const today = new Date().toISOString().slice(0, 10);
    const totals = summarizeReceivables(
      invoices.map((inv) => ({ amount: inv.amount, dueDate: inv.dueDate, paidAt: inv.paidAt })),
      today,
    );
    return { asOfDate: today, totalPending: totals.totalPending, totalOverdue: totals.totalOverdue, countPending: totals.countPending, countOverdue: totals.countOverdue, invoices };
  }

  async createInconformidadDraft(organizationId: string, tenderId: string, input: CreateInconformidadDraftInput): Promise<InconformidadDraftRecord> {
    const content = buildInconformidadContent({
      falloNotifiedOn: input.falloNotifiedOn,
      bajoTratados: input.bajoTratados,
      hechos: input.hechos,
      agravios: input.agravios,
      pruebas: input.pruebas,
    });
    const versionRes = await this.db.query<{ next_version: number }>(
      `select coalesce(max(version), 0) + 1 as next_version from licitaciones.inconformidad_draft where organization_id = $1 and tender_id = $2;`,
      [organizationId, tenderId],
    );
    const version = versionRes.rows[0]!.next_version;

    const { rows } = await this.db.query<InconformidadDraftRow>(
      `insert into licitaciones.inconformidad_draft
         (organization_id, tender_id, version, status, content_hash, hechos, agravios, pruebas, fundamentos,
          fallo_notified_on, bajo_tratados, business_days, due_date, legal_reference, viability, viability_recommendation, disclaimer, created_by)
       values ($1, $2, $3, 'borrador', $4, $5::text[], $6::text[], $7::text[], $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       returning ${INCONFORMIDAD_DRAFT_COLUMNS};`,
      [
        organizationId,
        tenderId,
        version,
        content.contentHash,
        input.hechos,
        input.agravios,
        input.pruebas,
        JSON.stringify(content.fundamentos),
        input.falloNotifiedOn,
        input.bajoTratados,
        content.plazo.businessDays,
        content.plazo.dueDate,
        content.plazo.legalReference,
        content.viability,
        content.viabilityRecommendation,
        INCONFORMIDAD_DISCLAIMER,
        input.actorId,
      ],
    );
    return mapInconformidadDraft(rows[0]!);
  }

  async listInconformidadDrafts(organizationId: string, tenderId: string): Promise<readonly InconformidadDraftRecord[]> {
    const { rows } = await this.db.query<InconformidadDraftRow>(
      `select ${INCONFORMIDAD_DRAFT_COLUMNS} from licitaciones.inconformidad_draft where organization_id = $1 and tender_id = $2 order by version asc;`,
      [organizationId, tenderId],
    );
    return rows.map(mapInconformidadDraft);
  }

  async markInconformidadReviewed(organizationId: string, tenderId: string, draftId: string, actorId: string): Promise<InconformidadDraftRecord> {
    const existing = await this.db.query<{ status: string }>(`select status from licitaciones.inconformidad_draft where id = $1 and organization_id = $2 and tender_id = $3;`, [
      draftId,
      organizationId,
      tenderId,
    ]);
    if (existing.rows.length === 0) throw new Error(`Borrador de inconformidad "${draftId}" no encontrado.`);
    if (existing.rows[0]!.status === "revisado") throw new Error("Este borrador ya fue marcado como revisado.");

    const { rows } = await this.db.query<InconformidadDraftRow>(
      `update licitaciones.inconformidad_draft set status = 'revisado', reviewed_by = $1, reviewed_at = now()
       where id = $2 and organization_id = $3 returning ${INCONFORMIDAD_DRAFT_COLUMNS};`,
      [actorId, draftId, organizationId],
    );
    return mapInconformidadDraft(rows[0]!);
  }

  async createFalloAutopsy(
    organizationId: string,
    tenderId: string,
    input: CreateFalloAutopsyInput,
  ): Promise<{ autopsy: FalloAutopsyRecord; lessons: readonly CompanyLessonLearnedRecord[] }> {
    const disqualificationReason = normalizeOrNoDisponible(input.disqualificationReason);
    const winnerName = normalizeOrNoDisponible(input.winnerName);

    const { rows } = await this.db.query<FalloAutopsyRow>(
      `insert into licitaciones.fallo_autopsy
         (organization_id, tender_id, own_proposal_status, disqualification_reason, own_score, winner_score, own_price, winner_price, winner_name, criteria_comparison, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       returning ${FALLO_AUTOPSY_COLUMNS};`,
      [
        organizationId,
        tenderId,
        input.ownProposalStatus,
        disqualificationReason,
        input.ownScore,
        input.winnerScore,
        input.ownPrice,
        input.winnerPrice,
        winnerName,
        JSON.stringify(input.criteriaComparison),
        input.actorId,
      ],
    );
    const autopsy = mapFalloAutopsy(rows[0]!);

    const lessons: CompanyLessonLearnedRecord[] = [];
    for (const lessonText of input.lessons) {
      const inserted = await this.db.query<CompanyLessonLearnedRow>(
        `insert into licitaciones.company_lesson_learned (organization_id, fallo_autopsy_id, tender_id, lesson_text)
         values ($1, $2, $3, $4)
         returning id, organization_id, fallo_autopsy_id, tender_id, lesson_text, created_at::text as created_at;`,
        [organizationId, autopsy.id, tenderId, lessonText],
      );
      lessons.push(mapCompanyLessonLearned(inserted.rows[0]!));
    }
    return { autopsy, lessons };
  }

  async listFalloAutopsies(organizationId: string, tenderId: string): Promise<readonly FalloAutopsyRecord[]> {
    const { rows } = await this.db.query<FalloAutopsyRow>(
      `select ${FALLO_AUTOPSY_COLUMNS} from licitaciones.fallo_autopsy where organization_id = $1 and tender_id = $2 order by created_at asc;`,
      [organizationId, tenderId],
    );
    return rows.map(mapFalloAutopsy);
  }

  async listLessonsLearned(organizationId: string): Promise<readonly CompanyLessonLearnedRecord[]> {
    const { rows } = await this.db.query<CompanyLessonLearnedRow>(
      `select id, organization_id, fallo_autopsy_id, tender_id, lesson_text, created_at::text as created_at
       from licitaciones.company_lesson_learned where organization_id = $1 order by created_at desc;`,
      [organizationId],
    );
    return rows.map(mapCompanyLessonLearned);
  }

  async scanRenewalAlerts(organizationId: string, input: ScanRenewalAlertsInput): Promise<ScanRenewalAlertsResult> {
    const thresholds = input.leadDaysThresholds ?? DEFAULT_RENEWAL_LEAD_DAYS;
    const today = input.todayIsoDate ?? new Date().toISOString().slice(0, 10);

    const contractsRes = await this.db.query<{ id: string; tender_id: string; end_date: string }>(
      `select id, tender_id, end_date::text as end_date from licitaciones.contract
       where organization_id = $1 and end_date is not null and status not in ('cerrado', 'rescindido');`,
      [organizationId],
    );
    const candidates: RenewalCandidateContract[] = contractsRes.rows.map((r) => ({ contractId: r.id, tenderId: r.tender_id, endDate: r.end_date }));
    const alertCandidates = computeRenewalAlertCandidates(candidates, today, thresholds);

    const created: RenewalAlertRecord[] = [];
    for (const candidate of alertCandidates) {
      const inserted = await this.db.query<RenewalAlertRow>(
        `insert into licitaciones.renewal_alert (organization_id, contract_id, tender_id, predicted_date, lead_days, confidence)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (organization_id, contract_id, lead_days) do nothing
         returning ${RENEWAL_ALERT_COLUMNS};`,
        [organizationId, candidate.contractId, candidate.tenderId, candidate.predictedDate, candidate.leadDays, candidate.confidence],
      );
      if (inserted.rows.length > 0) created.push(mapRenewalAlert(inserted.rows[0]!));
    }

    return { evaluatedContracts: candidates.length, alertsCreated: created.length, alerts: created };
  }

  // Hallazgo de auditoría (severidad ALTA, "flujos de sistema bloqueados en
  // escritura", ver migración 025) -- exclusiva del barrido de sistema
  // (`apps/worker/src/jobs/licitaciones/alert-notifications.ts`). MISMA lógica
  // exacta que `scanRenewalAlerts` de arriba (mismo `computeRenewalAlertCandidates`
  // puro, nunca duplicado) -- solo cambian las 2 funciones SQL que hacen el I/O,
  // por funciones `security definer` de solo-sistema en vez de acceso directo a
  // `licitaciones.contract`/`renewal_alert` (bloqueado bajo sesión de sistema, sin
  // escape hatch). `scanRenewalAlerts` sigue siendo el camino correcto para el
  // staff autenticado real (`POST .../renewals/scan`) -- sin cambio.
  async systemScanRenewalAlerts(organizationId: string, input: ScanRenewalAlertsInput): Promise<ScanRenewalAlertsResult> {
    const thresholds = input.leadDaysThresholds ?? DEFAULT_RENEWAL_LEAD_DAYS;
    const today = input.todayIsoDate ?? new Date().toISOString().slice(0, 10);

    const contractsRes = await this.db.query<{ out_contract_id: string; out_tender_id: string; out_end_date: string }>(
      `select * from licitaciones.system_list_renewal_candidate_contracts($1);`,
      [organizationId],
    );
    const candidates: RenewalCandidateContract[] = contractsRes.rows.map((r) => ({ contractId: r.out_contract_id, tenderId: r.out_tender_id, endDate: r.out_end_date }));
    const alertCandidates = computeRenewalAlertCandidates(candidates, today, thresholds);

    const created: RenewalAlertRecord[] = [];
    for (const candidate of alertCandidates) {
      const inserted = await this.db.query<{
        out_id: string;
        out_organization_id: string;
        out_contract_id: string;
        out_tender_id: string;
        out_predicted_date: string;
        out_lead_days: number;
        out_confidence: string;
        out_status: "pendiente" | "reconocida";
        out_acknowledged_at: string | null;
        out_acknowledged_by: string | null;
        out_created_at: string;
      }>(`select * from licitaciones.system_record_renewal_alert($1, $2, $3, $4, $5, $6);`, [
        organizationId,
        candidate.contractId,
        candidate.tenderId,
        candidate.predictedDate,
        candidate.leadDays,
        candidate.confidence,
      ]);
      const row = inserted.rows[0];
      if (row) {
        created.push({
          id: row.out_id,
          organizationId: row.out_organization_id,
          contractId: row.out_contract_id,
          tenderId: row.out_tender_id,
          predictedDate: row.out_predicted_date,
          leadDays: row.out_lead_days,
          confidence: Number(row.out_confidence),
          status: row.out_status,
          acknowledgedAt: row.out_acknowledged_at,
          acknowledgedBy: row.out_acknowledged_by,
          createdAt: row.out_created_at,
        });
      }
    }

    return { evaluatedContracts: candidates.length, alertsCreated: created.length, alerts: created };
  }

  async listRenewalAlerts(organizationId: string): Promise<readonly RenewalAlertRecord[]> {
    const { rows } = await this.db.query<RenewalAlertRow>(
      `select ${RENEWAL_ALERT_COLUMNS} from licitaciones.renewal_alert where organization_id = $1 order by created_at desc;`,
      [organizationId],
    );
    return rows.map(mapRenewalAlert);
  }

  async acknowledgeRenewalAlert(organizationId: string, alertId: string, actorId: string): Promise<RenewalAlertRecord> {
    const { rows } = await this.db.query<RenewalAlertRow>(
      `update licitaciones.renewal_alert set status = 'reconocida', acknowledged_at = now(), acknowledged_by = $1
       where id = $2 and organization_id = $3
       returning ${RENEWAL_ALERT_COLUMNS};`,
      [actorId, alertId, organizationId],
    );
    if (rows.length === 0) throw new Error(`Alerta de renovación "${alertId}" no encontrada.`);
    return mapRenewalAlert(rows[0]!);
  }

  // ==========================================================================
  // Fase 10 -- despacho proactivo real (correo) de deadline reminders/renewal
  // alerts/facturas vencidas (ver migrations/018_alert_notifications.sql).
  // ==========================================================================

  async listOrganizationNotificationRecipients(organizationId: string): Promise<readonly OrganizationNotificationRecipient[]> {
    const { rows } = await this.db.query<{ email: string; full_name: string }>(`select email, full_name from licitaciones.organization_notification_recipients($1);`, [organizationId]);
    return rows.map((r) => ({ email: r.email, fullName: r.full_name }));
  }

  // Hallazgo de auditoría (severidad ALTA, "flujos de sistema bloqueados en
  // escritura", ver migración 025): exclusiva del barrido de sistema
  // (`apps/worker/src/jobs/licitaciones/alert-notifications.ts`, sin caller de
  // staff autenticado, verificado con `grep -rn`) -- mismo SELECT exacto que
  // antes, ahora dentro de `licitaciones.system_list_overdue_contract_invoices`
  // (`security definer`, guard de solo-sistema) en vez de directo contra la
  // tabla (bloqueado por `can_access_org` bajo sesión de sistema, sin escape
  // hatch). Sin cambio de contrato TypeScript -- mismo método, misma firma.
  async listOverdueContractInvoices(organizationId: string, todayIsoDate?: string): Promise<readonly OverdueContractInvoiceAlert[]> {
    const today = todayIsoDate ?? new Date().toISOString().slice(0, 10);
    const { rows } = await this.db.query<{ out_id: string; out_contract_id: string; out_tender_id: string; out_concepto: string; out_amount: string; out_due_date: string; out_days_overdue: number }>(
      `select * from licitaciones.system_list_overdue_contract_invoices($1, $2::date);`,
      [organizationId, today],
    );
    return rows.map((r) => ({
      organizationId,
      invoiceId: r.out_id,
      contractId: r.out_contract_id,
      tenderId: r.out_tender_id,
      concepto: r.out_concepto,
      amount: r.out_amount,
      dueDate: r.out_due_date,
      daysOverdue: r.out_days_overdue,
    }));
  }

  async enqueueMessagingOutbox(organizationId: string, channel: "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    await this.db.query(`select licitaciones.enqueue_messaging_outbox($1, $2, $3, $4, $5::jsonb);`, [organizationId, channel, eventType, dedupeKey, JSON.stringify(payload)]);
  }

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const { rows } = await this.db.query<{ id: string; organization_id: string; attempts: number; payload: Record<string, unknown> }>(`select id, organization_id, attempts, payload from licitaciones.claim_email_outbox_batch($1);`, [limit]);
    return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, attempts: r.attempts, payload: r.payload ?? {} }));
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    await this.db.query(`select licitaciones.complete_email_outbox_job($1, $2, $3);`, [id, status, error]);
  }

  // Aislamiento del best-effort de correo (ver el comentario de cabecera de
  // `runWithRowSavepoint` en `repository.ts` para el diseño completo) -- mismo
  // `runWithSavepointFallback` que `PostgresHotelesRepository`/
  // `PostgresRestaurantesRepository`/`PostgresDespachosRepository`, con
  // `isRecoverable` fijo en `true` y un `fallback` que simplemente relanza el
  // mismo error DESPUÉS de que `ROLLBACK TO SAVEPOINT` ya dejó la transacción
  // utilizable para el `commit;` real que sigue.
  async runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw err;
      },
    });
  }
}
