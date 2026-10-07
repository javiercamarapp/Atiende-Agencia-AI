// InMemoryLicitacionesRepository — implementación real (no un mock) de
// `LicitacionesRepository`, para tests determinísticos (mismo rol que
// InMemoryHotelesRepository/InMemoryRestaurantesRepository). Los bytes del
// ZIP del expediente SÍ se escriben a disco real (bajo un directorio temporal
// por defecto) — igual que el origen, que nunca modeló el ZIP como un blob de
// base de datos (ver storage.ts).
import { AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT } from "./audit-trail.ts";
import type { AuditTrailEntry, AuditTrailFilters, AuditTrailInput, AuditTrailPage } from "./audit-trail.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { InMemoryCompanyProfileStore } from "./company-profile-memory.ts";
import type { CompanyLocationRecord, CompanyProductServiceRecord, CompanyRestrictionRecord, CompanyStakeholderRecord, ProvenanceEntity } from "./company-profile.ts";
import { CompanyDataDuplicateKeyError, CompanyDataNotFoundError, CompanyProfileNotAvailableError, ContractTransitionRejectedError, ExpedienteStageNotAvailableError, IdempotencyConflictError, TenderResolutionRejectedError } from "./errors.ts";
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
  CompanyLocationCreateInput,
  CompanyLocationUpdateInput,
  CompanyProductServiceCreateInput,
  CompanyProductServiceUpdateInput,
  CompanyProfileCollectionKind,
  CompanyProfileUpsertInput,
  CompanyRestrictionCreateInput,
  CompanyRestrictionUpdateInput,
  CompanyStakeholderCreateInput,
  CompanyStakeholderUpdateInput,
  CompanyItemKind,
  CompanyItemDecision,
  CompanyItemDecisionInput,
  CompanyItemDecisionOutcome,
  GoNoGoDecisionCreateInput,
  IdempotencyParams,
  IdempotentResult,
  LicitacionesRepository,
  LicitacionesTenantConfigPatch,
  LicitacionesTenantConfigRecord,
  MatchingProfileUpsertInput,
  TenderAuditLogPage,
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
import { classifyInvoiceStatus, summarizeReceivables } from "./contract-billing.ts";
import { buildInconformidadContentByRegime, computePaymentDueDateByRegime } from "./regimen-legal.ts";
import { mensajeRecordatorioPlazo, officialOnlyCalendar } from "./dias-inhabiles.ts";
import { INCONFORMIDAD_DISCLAIMER } from "./inconformidad.ts";
import { normalizeOrNoDisponible } from "./fallo-autopsy.ts";
import { computeRenewalAlertCandidates, DEFAULT_RENEWAL_LEAD_DAYS } from "./renewal-radar.ts";
import type { RenewalCandidateContract } from "./renewal-radar.ts";
import { readPackageZip, storeFile, writePackageZip } from "./storage.ts";
import { requireValidHashedInputs, sealInputs } from "./sealed-inputs.ts";
import type { ExpedienteInputs, HashedInputs } from "./sealed-inputs.ts";
import { isoNow, sha256Hex } from "./types.ts";
import { computeCompanyProfileHash } from "./company-profile-hash.ts";
import { ApprovalWorkflow } from "./approval-workflow.ts";
import type { Approval, ApprovalScope, ChangeDetected, ExpedienteApprovalStage } from "./approval-workflow.ts";
import { ProposalVersionRegistry, buildProposalInputRecords } from "./proposal-version-registry.ts";
import type { PersistedProposalVersion } from "./proposal-version-registry.ts";
import { WRITE_ROLES } from "./roles.ts";
import type { LicitacionesRole } from "./roles.ts";
import type {
  RecordTenderVersionResult,
  RequirementFulfillmentMappingRecord,
  RequirementItemRecord,
  TenderChangeNotificationRecord,
  TenderSourceIngestResult,
  TenderDeadlineReminderRecord,
  ScanDeadlineRemindersInput,
  ScanDeadlineRemindersResult,
} from "./repository.ts";
import type { TenderSourceIngestCandidate } from "./connectors/types.ts";
import { buildGoNoGoDecision } from "./go-no-go.ts";
import { TenderVersionRegistry, computeTenderSnapshotHash, toRequirementSnapshot } from "./tender-version-registry.ts";
import type { PersistedTenderVersion, TenderVersionSnapshot } from "./tender-version-registry.ts";
import { LICITACIONES_CONNECTOR_REGISTRY } from "./connector-registry.ts";
import type { SourceConnectorId } from "./connector-registry.ts";
import { evaluateSourceFreshness } from "./source-run.ts";
import type { SourceFreshnessRecord, SourceRunInput, SourceRunRecord } from "./source-run.ts";
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
} from "./types.ts";

/** Serializa operaciones por clave — equivalente en memoria de un row lock de Postgres (mismo patrón que domain-hoteles). */
class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.chains.set(
      key,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

interface StoredIdempotencyRow {
  requestHash: string;
  response: IdempotentResult<unknown> | null;
}

interface StoredProposalSection {
  documentId: string;
  sectionKey: string;
  label: string;
  filename: string;
  version: number;
  content: string;
}

type CompanyItemStatus = "aprobado" | "pendiente_aprobacion" | "rechazado";
type CompanyDecidable = { id: string; approvalStatus: CompanyItemStatus; proposedBy?: string | null; approvedBy?: string | null; approvedAt?: string | null };

export class InMemoryLicitacionesRepository implements LicitacionesRepository {
  private readonly storageDir: string;
  private readonly tenders = new Map<string, TenderRecord>();
  private readonly proposals = new Map<string, ProposalRecord>();
  private readonly proposalByTenderKey = new Map<string, string>(); // `${orgId}:${tenderId}` -> proposalId
  private readonly complianceItems = new Map<string, ComplianceItemRecord[]>(); // proposalId -> items
  private readonly requiredAnnexes = new Map<string, RequiredAnnexItem[]>(); // `${orgId}:${tenderId}` -> annexes
  private readonly companyDocuments = new Map<string, CompanyDocumentRecord[]>(); // orgId -> docs
  private readonly approvedRates = new Map<string, ApprovedRateRecord[]>(); // orgId -> rates
  private readonly companyCapabilities = new Map<string, CompanyCapabilityRecord[]>(); // orgId -> capacidades
  private readonly companyExperience = new Map<string, CompanyExperienceItemRecord[]>(); // orgId -> experiencia
  private readonly companySigners = new Map<string, CompanySignerRecord[]>(); // orgId -> firmantes
  private readonly proposalSections = new Map<string, Map<string, StoredProposalSection>>(); // proposalId -> sectionKey -> section
  private expedienteStageMode: "doble" | "legacy" = "doble";
  private readonly approvals = new Map<string, Approval[]>(); // proposalId -> approvals (historial, todos los scopes)
  private readonly sectionAuthors = new Map<string, Map<string, Set<string>>>(); // proposalId -> scopeRef("seccion:<key>") -> actorIds (AE-11)
  private readonly approvalChanges = new Map<string, ChangeDetected[]>(); // proposalId -> cambios detectados (historial)
  private readonly proposalVersions = new Map<string, PersistedProposalVersion[]>(); // proposalId -> versiones (historial, ordenado)
  private readonly requirementItems = new Map<string, RequirementItemRecord[]>(); // `${orgId}:${tenderId}` -> items (reemplazo completo en cada extracción)
  private readonly fulfillmentMappings = new Map<string, Map<string, RequirementFulfillmentMappingRecord>>(); // orgId -> topicKey -> mapping
  private readonly packageManifests = new Map<string, PackageManifestRecord[]>(); // proposalId -> manifests (historial)
  private readonly submissions = new Map<string, SubmissionRecord[]>(); // proposalId -> submissions (historial)
  private readonly idempotency = new Map<string, StoredIdempotencyRow>();
  private readonly mutex = new KeyedMutex();
  // FASE 3 (producto) — zona horaria por negocio: `licitaciones.tenant_config`
  // (migración 027). Ausente en el mapa = misma fila inexistente que
  // `findTenantConfig` ve contra Postgres real (`timezone: null`).
  private readonly tenantConfigs = new Map<string, string | null>(); // orgId -> timezone
  // ---- Fase 3: matching/scoring y go/no-go ----
  private readonly tenderByExternalKey = new Map<string, string>(); // `${orgId}:manual:${externalId}` -> tenderId (mismo alcance que tender_org_source_external_idx)
  // f2-orden-total-bitacoras -- `id`/`organizationId`/`createdAtMs`/`seq` agregados
  // para soportar `listTenderAuditLogPage` (orden total, ver migrations/
  // 026_tender_audit_log_orden_total_lectura_paginada.sql) sin romper
  // `listTenderAuditLogForTests` (más abajo), que ya existía.
  private readonly tenderAuditLog = new Map<string, { id: string; organizationId: string; action: string; actorId: string; createdAt: string; createdAtMs: number; seq: number }[]>(); // tenderId -> entradas (historial)
  private tenderAuditLogSeq = 0;
  private readonly matchingProfiles = new Map<string, MatchingProfileRecord>(); // orgId -> perfil (singleton)
  private readonly goNoGoDecisions = new Map<string, GoNoGoDecisionRecord[]>(); // tenderId -> decisiones (historial, más reciente al final)
  // ---- Fase 16: resolución won/lost ----
  private readonly tenderResolutions = new Map<string, TenderResolutionRecord[]>(); // tenderId -> resoluciones (historial, más antigua primero)
  // ---- Fase 5 pieza 2: historial de versiones de convocatoria ----
  private readonly tenderVersionRegistries = new Map<string, TenderVersionRegistry>(); // `${orgId}:${tenderId}` -> registro (historial completo)
  private readonly tenderChangeNotifications = new Map<string, TenderChangeNotificationRecord[]>(); // orgId -> notificaciones (historial, más reciente al final)
  // ---- Fase 5 pieza 1: andamiaje de ingesta ----
  private readonly sourceRuns = new Map<string, SourceRunRecord[]>(); // orgId -> corridas (historial, más reciente al final)
  // ---- Fase 6: seguimiento post-adjudicación (REQ-051..055) ----
  private readonly contracts = new Map<string, ContractRecord>(); // tenderId -> contrato (a lo más uno por tender)
  private readonly contractStatusHistory = new Map<string, ContractStatusHistoryRecord[]>(); // contractId -> historial (más antigua primero)
  private readonly contractDocuments = new Map<string, ContractDocumentRecord[]>(); // contractId -> documentos
  private readonly contractExtractedFields = new Map<string, ContractExtractedFieldRecord[]>(); // contractDocumentId -> campos
  private readonly contractInvoices = new Map<string, ContractInvoiceRecord[]>(); // contractId -> facturas
  private readonly inconformidadDrafts = new Map<string, InconformidadDraftRecord[]>(); // `${orgId}:${tenderId}` -> versiones (historial completo)
  private readonly falloAutopsies = new Map<string, FalloAutopsyRecord[]>(); // `${orgId}:${tenderId}` -> autopsias (historial)
  private readonly lessonsLearned = new Map<string, CompanyLessonLearnedRecord[]>(); // orgId -> lecciones (historial, más reciente al final)
  private readonly renewalAlerts = new Map<string, RenewalAlertRecord[]>(); // orgId -> alertas (historial, más reciente al final)
  // ---- Fase 8: ingesta automática real + recordatorios de plazo ----
  private readonly tenderBySourceExternalKey = new Map<string, string>(); // `${orgId}:${source}:${externalId}` -> tenderId (fuentes AUTOMATIZADAS -- "manual" sigue usando tenderByExternalKey arriba)
  private readonly deadlineReminders = new Map<string, TenderDeadlineReminderRecord>(); // reminderId -> recordatorio
  private readonly deadlineReminderDedupeKeys = new Set<string>(); // `${tenderId}:${fecha calendario del vencimiento}` -- ya se emitió un recordatorio para ese (tender, día)

  // ---- Fase 7 pieza 1: organización/property (panel web) ----
  private readonly organizations = new Map<string, { id: string; name: string; slug: string; isActive: boolean }>();
  private readonly organizationIdBySlug = new Map<string, string>();
  private readonly licitacionesProperties = new Map<string, { propertyId: string; organizationId: string; name: string }>(); // propertyId -> registro

  // ---- Fase 10: despacho proactivo real (correo) de alertas ----
  private readonly notificationRecipients = new Map<string, OrganizationNotificationRecipient[]>(); // orgId -> staff owner/admin (ver seedNotificationRecipient)
  private readonly messagingOutbox = new Map<string, { id: string; organizationId: string; channel: string; eventType: string; dedupeKey: string; payload: Record<string, unknown>; status: "pending" | "processing" | "sent" | "failed" | "dead"; attempts: number; lastError: string | null; createdAt: string }>(); // jobId -> job
  private readonly messagingOutboxDedupe = new Map<string, string>(); // `${orgId}:${channel}:${dedupeKey}` -> jobId

  constructor(options: { storageDir?: string } = {}) {
    this.storageDir = options.storageDir ?? mkdtempSync(join(tmpdir(), "licitaciones-test-"));
  }

  // ---- seeding (equivalente a INSERT manual contra las migraciones SQL) ----

  seedTender(tender: TenderRecord): void {
    this.tenders.set(tender.id, tender);
  }

  /** Mismo rol que `InMemoryCitasRepository.seedOrganization`. */
  seedOrganization(org: { id: string; slug: string; name: string; isActive?: boolean }): void {
    this.organizations.set(org.id, { id: org.id, name: org.name, slug: org.slug, isActive: org.isActive ?? true });
    this.organizationIdBySlug.set(org.slug, org.id);
  }

  /** Mismo rol que `InMemoryCitasRepository.seedCitasProperty` — property singleton
   * por organización (§2.1), pero el mapa acepta 2+ por si un test futuro lo necesita. */
  seedLicitacionesProperty(property: { id: string; organizationId: string; name: string }): void {
    this.licitacionesProperties.set(property.id, { propertyId: property.id, organizationId: property.organizationId, name: property.name });
  }

  /** Fase 10 -- equivalente en memoria de `licitaciones.organization_notification_recipients`
   * (staff `owner`/`admin` real vía `core.membership`/`core.staff_user` en Postgres): este
   * repositorio en memoria no modela `core.*` (vive en `@atiende/db`, un paquete distinto,
   * ver `apps/api/tests/licitaciones-fixtures.ts`), así que las pruebas siembran aquí
   * directamente a quién debe llegarle el correo -- sin sembrar nada, la organización
   * simplemente no tiene destinatarios (mismo comportamiento honesto que una organización
   * real sin ningún staff `owner`/`admin` todavía). */
  seedNotificationRecipient(organizationId: string, recipient: OrganizationNotificationRecipient): void {
    const list = this.notificationRecipients.get(organizationId) ?? [];
    this.notificationRecipients.set(organizationId, [...list, recipient]);
  }

  /** Solo para pruebas -- inspecciona el outbox completo (mismo rol que
   * `InMemoryCitasRepository.getOutbox()`). */
  getMessagingOutbox(): readonly { id: string; organizationId: string; channel: string; eventType: string; dedupeKey: string; payload: Record<string, unknown>; status: string; attempts: number; lastError: string | null }[] {
    return [...this.messagingOutbox.values()];
  }

  seedRequiredAnnexes(organizationId: string, tenderId: string, annexes: readonly RequiredAnnexItem[]): void {
    this.requiredAnnexes.set(`${organizationId}:${tenderId}`, [...annexes]);
  }

  seedCompanyDocuments(organizationId: string, documents: readonly CompanyDocumentRecord[]): void {
    this.companyDocuments.set(organizationId, [...documents]);
  }

  seedApprovedRates(organizationId: string, rates: readonly ApprovedRateRecord[]): void {
    this.approvedRates.set(organizationId, [...rates]);
  }

  seedCompanyCapabilities(organizationId: string, capabilities: readonly CompanyCapabilityRecord[]): void {
    this.companyCapabilities.set(organizationId, [...capabilities]);
  }

  seedCompanyExperience(organizationId: string, experience: readonly CompanyExperienceItemRecord[]): void {
    this.companyExperience.set(organizationId, [...experience]);
  }

  seedCompanySigners(organizationId: string, signers: readonly CompanySignerRecord[]): void {
    this.companySigners.set(organizationId, [...signers]);
  }

  /** Inserta/actualiza una sección de propuesta (equivalente a `proposal_sections`) — usada por el flujo económico y directamente por pruebas del Flujo 3 (secciones "técnicas" no generadas en Fase 1). */
  seedProposalSection(proposalId: string, section: StoredProposalSection): void {
    const map = this.proposalSections.get(proposalId) ?? new Map<string, StoredProposalSection>();
    map.set(section.sectionKey, section);
    this.proposalSections.set(proposalId, map);
  }

  // ---- Fase 7 pieza 1: organización/property (panel web) ----

  async findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null> {
    const id = this.organizationIdBySlug.get(slug);
    if (!id) return null;
    return this.organizations.get(id) ?? null;
  }

  async listPropertiesForOrganization(organizationId: string): Promise<readonly { propertyId: string; name: string }[]> {
    return [...this.licitacionesProperties.values()]
      .filter((p) => p.organizationId === organizationId)
      .map((p) => ({ propertyId: p.propertyId, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- FASE 3 (producto) — zona horaria por negocio ----

  async findTenantConfig(organizationId: string): Promise<LicitacionesTenantConfigRecord> {
    return { organizationId, timezone: this.tenantConfigs.get(organizationId) ?? null };
  }

  async upsertTenantConfig(organizationId: string, patch: LicitacionesTenantConfigPatch): Promise<LicitacionesTenantConfigRecord> {
    const current = this.tenantConfigs.get(organizationId) ?? null;
    const timezone = "timezone" in patch ? (patch.timezone ?? null) : current;
    this.tenantConfigs.set(organizationId, timezone);
    return { organizationId, timezone };
  }

  /** Único punto que llaman `createApprovedRate`/`createContractInvoice`/
   * `listContractInvoices`/`markContractInvoicePaid`/`receivablesSummary`/
   * `scanRenewalAlerts`/`systemScanRenewalAlerts`/`listOverdueContractInvoices`
   * de abajo para resolver "hoy" — mismo nombre/rol exacto que
   * `PostgresLicitacionesRepository.resolveOrganizationTimezoneForToday`
   * (nunca duplica el cálculo, ver ese método para el porqué de
   * `resolverZonaHorariaNegocio`). El repositorio en memoria nunca tiene un
   * "esquema a medio migrar" que fallback-ear -- siempre lee `tenantConfigs`
   * directo. */
  private todayForOrg(organizationId: string): string {
    return hoyFechaNegocio(resolverZonaHorariaNegocio(this.tenantConfigs.get(organizationId) ?? null));
  }

  // ---- Convocatoria / expediente (transversal) ----

  async findTender(organizationId: string, tenderId: string): Promise<TenderRecord | null> {
    const tender = this.tenders.get(tenderId);
    if (!tender || tender.organizationId !== organizationId) return null;
    return tender;
  }

  async getOrCreateProposal(organizationId: string, tenderId: string, userId: string, title: string): Promise<ProposalRecord> {
    const key = `${organizationId}:${tenderId}`;
    const existingId = this.proposalByTenderKey.get(key);
    if (existingId) {
      const existing = this.proposals.get(existingId);
      if (existing) return existing;
    }
    const record: ProposalRecord = {
      id: randomUUID(),
      organizationId,
      tenderId,
      title,
      ivaRate: 0.16,
      economicTotals: null,
      generationReport: null,
      correlationId: null,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(record.id, record);
    this.proposalByTenderKey.set(key, record.id);
    return record;
  }

  async findProposal(organizationId: string, tenderId: string): Promise<ProposalRecord | null> {
    const proposalId = this.proposalByTenderKey.get(`${organizationId}:${tenderId}`);
    if (!proposalId) return null;
    const proposal = this.proposals.get(proposalId);
    return proposal && proposal.organizationId === organizationId ? proposal : null;
  }

  // ---- Fase 3 pieza 1: alta manual de convocatoria (§6) ----

  async listTenders(organizationId: string): Promise<readonly TenderRecord[]> {
    return [...this.tenders.values()].filter((t) => t.organizationId === organizationId);
  }

  async listTendersPage(organizationId: string, opts: { readonly limit: number; readonly offset: number }): Promise<TenderPage> {
    const filtered = [...this.tenders.values()]
      .filter((t) => t.organizationId === organizationId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const items = filtered.slice(opts.offset, opts.offset + opts.limit);
    const nextOffset = opts.offset + items.length < filtered.length ? opts.offset + items.length : null;
    return { items, total: filtered.length, nextOffset };
  }

  async upsertTenderManual(organizationId: string, input: TenderUpsertInput): Promise<TenderUpsertResult> {
    const externalKey = input.externalId !== null ? `${organizationId}:manual:${input.externalId}` : null;
    const existingTenderId = externalKey ? this.tenderByExternalKey.get(externalKey) : undefined;
    const existing = existingTenderId ? this.tenders.get(existingTenderId) : undefined;

    const nowIso = new Date().toISOString();
    if (existing) {
      const previousDeadline = existing.submissionDeadline;
      const updated: TenderRecord = {
        ...existing,
        title: input.title,
        submissionDeadline: input.submissionDeadline,
        contractingBody: input.contractingBody,
        cpvCodes: [...input.cpvCodes],
        budgetAmount: input.budgetAmount,
        currency: input.currency,
        state: input.state,
        procedureTypeRaw: input.procedureTypeRaw,
        updatedAt: nowIso,
      };
      this.tenders.set(existing.id, updated);
      this.recordTenderAudit(organizationId, existing.id, "tender.manual_upsert.updated", input.actorId);
      // Fase 5 pieza 1 (REQ-147): cada alta/actualización manual ES una
      // "corrida de ingesta" del único conector real hoy -- se registra tal
      // cual, con la MISMA forma que usaría un conector automatizado futuro.
      await this.recordManualSourceRun(organizationId, false);
      // Fase 5 pieza 2: versiona la convocatoria y cascada de invalidación en
      // la MISMA operación -- generaliza el disparador anterior (solo
      // `submissionDeadline`) a CUALQUIER campo de bases que haya cambiado
      // (REQ-151/155, ver tender-version-registry.ts).
      const versionResult = await this.recordTenderVersion(organizationId, existing.id, input.actorId);
      return {
        tender: updated,
        created: false,
        submissionDeadlineChanged: previousDeadline !== input.submissionDeadline,
        versionCambiada: versionResult.created && versionResult.version.version > 1 ? versionResult.version.version : null,
      };
    }

    const created: TenderRecord = {
      id: randomUUID(),
      organizationId,
      title: input.title,
      submissionDeadline: input.submissionDeadline,
      updatedAt: nowIso,
      source: "manual",
      externalId: input.externalId,
      contractingBody: input.contractingBody,
      cpvCodes: [...input.cpvCodes],
      budgetAmount: input.budgetAmount,
      currency: input.currency,
      state: input.state,
      procedureTypeRaw: input.procedureTypeRaw,
      status: "discovered",
    };
    this.tenders.set(created.id, created);
    if (externalKey) this.tenderByExternalKey.set(externalKey, created.id);
    this.recordTenderAudit(organizationId, created.id, "tender.manual_upsert.created", input.actorId);
    await this.recordManualSourceRun(organizationId, true);
    await this.recordTenderVersion(organizationId, created.id, input.actorId);
    return { tender: created, created: true, submissionDeadlineChanged: false };
  }

  private recordTenderAudit(organizationId: string, tenderId: string, action: string, actorId: string): void {
    const list = this.tenderAuditLog.get(tenderId) ?? [];
    this.tenderAuditLogSeq += 1;
    const createdAtMs = Date.now();
    list.push({ id: randomUUID(), organizationId, action, actorId, createdAt: new Date(createdAtMs).toISOString(), createdAtMs, seq: this.tenderAuditLogSeq });
    this.tenderAuditLog.set(tenderId, list);
  }

  /** Fase 5 pieza 1 (REQ-147): registra la corrida del conector "manual" -- cada alta/actualización manual de una convocatoria es, por diseño de esta fase, su propia corrida (ver comentario de cabecera en `connector-registry.ts` sobre por qué "manual" no agrupa varias filas todavía). */
  private async recordManualSourceRun(organizationId: string, created: boolean): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.recordSourceRun(organizationId, {
      source: "manual",
      state: "ok",
      startedAt: nowIso,
      finishedAt: nowIso,
      evidence: { message: created ? "Alta manual de convocatoria." : "Actualización manual de convocatoria.", coverage: { expected: 1, obtained: 1 } },
      correlationId: null,
    });
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

    const key = `${organizationId}:${tenderId}`;
    const registry = this.tenderVersionRegistries.get(key) ?? new TenderVersionRegistry();
    this.tenderVersionRegistries.set(key, registry);

    const previousLatest = registry.latest();
    // REQ-152/154: el snapshot es idéntico al de la última versión registrada -> no crea versión/cascada/notificación nueva (reingesta idempotente).
    if (previousLatest && computeTenderSnapshotHash(snapshot) === previousLatest.hash) {
      return { version: previousLatest, created: false, cascadedChanges: [], notification: null };
    }

    const version = registry.createVersion(snapshot);
    const cascadedChanges: ChangeDetected[] = [];
    const proposal = await this.findProposal(organizationId, tenderId);

    if (previousLatest && proposal && version.diff.hasChanges) {
      if (version.diff.changedFieldNames.length > 0) {
        cascadedChanges.push(
          await this.recordChange(organizationId, proposal.id, {
            scope: "expediente",
            scopeRef: "expediente",
            reason: `tender_version_changed:v${version.version}:${version.diff.changedFieldNames.join(",")}`,
          }),
        );
      }
      // Ver postgres-repository.ts::recordTenderVersion para por qué el
      // scopeRef necesita el prefijo "technical:" (mismo que persiste
      // `technicalProposal.ts::saveTechnicalSections`).
      for (const sectionKey of version.diff.affectedSectionKeys) {
        cascadedChanges.push(
          await this.recordChange(organizationId, proposal.id, {
            scope: "seccion",
            scopeRef: `seccion:technical:${sectionKey}`,
            reason: `tender_version_changed:v${version.version}:requisitos_de_seccion:${sectionKey}`,
          }),
        );
      }
    }

    const notification: TenderChangeNotificationRecord = {
      id: randomUUID(),
      organizationId,
      tenderId,
      tenderVersion: version.version,
      reason: previousLatest ? `convocatoria_actualizada:v${version.version}` : "convocatoria_nueva",
      changedFieldNames: version.diff.changedFieldNames,
      affectedSectionKeys: version.diff.affectedSectionKeys,
      notifiedRoles: WRITE_ROLES,
      createdAt: version.createdAt,
      acknowledgedAt: null,
      acknowledgedBy: null,
    };
    const notifications = this.tenderChangeNotifications.get(organizationId) ?? [];
    notifications.push(notification);
    this.tenderChangeNotifications.set(organizationId, notifications);

    // Trazabilidad de quién disparó la corrida que produjo esta versión (alta manual o re-extracción de requisitos) -- reutiliza `tender_audit_log`, ya existente (Fase 3 §6), en vez de inventar un mecanismo nuevo.
    this.recordTenderAudit(organizationId, tenderId, "tender.version_recorded", actorId);
    const persisted: PersistedTenderVersion = { version: version.version, hash: version.hash, snapshot: version.snapshot, diff: version.diff, createdAt: version.createdAt };
    return { version: persisted, created: true, cascadedChanges, notification };
  }

  async listTenderVersions(organizationId: string, tenderId: string): Promise<readonly PersistedTenderVersion[]> {
    const registry = this.tenderVersionRegistries.get(`${organizationId}:${tenderId}`);
    if (!registry) return [];
    return registry.all().map((v) => ({ version: v.version, hash: v.hash, snapshot: v.snapshot, diff: v.diff, createdAt: v.createdAt }));
  }

  async latestTenderVersion(organizationId: string, tenderId: string): Promise<PersistedTenderVersion | null> {
    const registry = this.tenderVersionRegistries.get(`${organizationId}:${tenderId}`);
    const latest = registry?.latest();
    return latest ? { version: latest.version, hash: latest.hash, snapshot: latest.snapshot, diff: latest.diff, createdAt: latest.createdAt } : null;
  }

  async listTenderChangeNotifications(organizationId: string, tenderId?: string): Promise<readonly TenderChangeNotificationRecord[]> {
    const all = this.tenderChangeNotifications.get(organizationId) ?? [];
    const filtered = tenderId ? all.filter((n) => n.tenderId === tenderId) : all;
    return [...filtered].reverse();
  }

  async acknowledgeTenderChangeNotification(organizationId: string, notificationId: string, actorId: string): Promise<TenderChangeNotificationRecord> {
    const all = this.tenderChangeNotifications.get(organizationId) ?? [];
    const index = all.findIndex((n) => n.id === notificationId);
    if (index === -1) throw new Error(`Notificación "${notificationId}" no encontrada para la organización "${organizationId}".`);
    const updated: TenderChangeNotificationRecord = { ...all[index]!, acknowledgedAt: new Date().toISOString(), acknowledgedBy: actorId };
    all[index] = updated;
    this.tenderChangeNotifications.set(organizationId, all);
    return updated;
  }

  // ---- Fase 5 pieza 1: andamiaje de ingesta sobre fixtures/carga manual (REQ-004/005/146..150) ----

  async recordSourceRun(organizationId: string, input: SourceRunInput): Promise<SourceRunRecord> {
    const record: SourceRunRecord = { ...input, id: randomUUID(), organizationId, createdAt: new Date().toISOString() };
    const list = this.sourceRuns.get(organizationId) ?? [];
    list.push(record);
    this.sourceRuns.set(organizationId, list);
    return record;
  }

  async listSourceRuns(organizationId: string, filter?: { source?: SourceConnectorId; limit?: number }): Promise<readonly SourceRunRecord[]> {
    const all = this.sourceRuns.get(organizationId) ?? [];
    const filtered = filter?.source ? all.filter((r) => r.source === filter.source) : all;
    const ordered = [...filtered].reverse();
    return filter?.limit ? ordered.slice(0, filter.limit) : ordered;
  }

  async sourceFreshness(organizationId: string): Promise<readonly SourceFreshnessRecord[]> {
    const all = this.sourceRuns.get(organizationId) ?? [];
    const now = new Date();
    return LICITACIONES_CONNECTOR_REGISTRY.all().map((descriptor) => {
      const runsOfSource = all.filter((r) => r.source === descriptor.id);
      const lastRun = runsOfSource[runsOfSource.length - 1] ?? null;
      const lastSuccess = [...runsOfSource].reverse().find((r) => r.state === "ok") ?? null;
      return evaluateSourceFreshness(descriptor.id, lastSuccess, lastRun, now);
    });
  }

  /** Solo pruebas/inspección -- no forma parte de `LicitacionesRepository` (ningún endpoint de Fase 3 la expone, ver diseño §6/§9). */
  // ---- L-P3-17: bitacora de escrituras (misma semantica que `licitaciones.audit_trail`) ----
  /** Solo para pruebas del doble: `false` simula la base sin la migracion 038. */
  auditTrailAvailable = true;
  private readonly auditTrail: (AuditTrailEntry & { organizationId: string })[] = [];
  private auditTrailSeq = 0;

  async appendAuditoria(organizationId: string, entry: AuditTrailInput): Promise<boolean> {
    if (!this.auditTrailAvailable) return false;
    this.auditTrailSeq += 1;
    this.auditTrail.push({
      organizationId,
      id: randomUUID(),
      seq: String(this.auditTrailSeq),
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      before: entry.before ?? null,
      after: entry.after ?? null,
      actorId: entry.actorId,
      correlationId: entry.correlationId,
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  async findTenderCorrelationId(organizationId: string, tenderId: string): Promise<string | null> {
    if (!this.auditTrailAvailable) return null;
    return this.auditTrail.find((r) => r.organizationId === organizationId && r.entity === "convocatoria" && r.entityId === tenderId && r.correlationId !== null)?.correlationId ?? null;
  }

  async listAuditoria(organizationId: string, filters: AuditTrailFilters, opts: { readonly limit?: number; readonly cursor?: string | null; readonly orden?: "asc" | "desc" } = {}): Promise<AuditTrailPage> {
    if (!this.auditTrailAvailable) return { items: [], nextCursor: null, available: false };
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? AUDIT_DEFAULT_LIMIT), 1), AUDIT_MAX_LIMIT);
    const asc = opts.orden === "asc";
    const cursor = opts.cursor && /^\d{1,18}$/u.test(opts.cursor) ? Number(opts.cursor) : null;
    const origenes = filters.tenderId
      ? this.auditTrail.filter((r) => r.organizationId === organizationId && r.entity === "convocatoria" && r.entityId === filters.tenderId && r.correlationId !== null).map((r) => r.correlationId as string)
      : [];
    let rows = this.auditTrail.filter(
      (r) =>
        r.organizationId === organizationId &&
        (!filters.entity || r.entity === filters.entity) &&
        (!filters.entityId || r.entityId === filters.entityId) &&
        (!filters.actorId || r.actorId === filters.actorId) &&
        (!filters.correlationId || r.correlationId === filters.correlationId) &&
        (!filters.tenderId || r.entityId === filters.tenderId || (origenes.length > 0 && r.correlationId !== null && origenes.includes(r.correlationId))) &&
        (!filters.desde || r.createdAt >= new Date(filters.desde).toISOString()) &&
        (!filters.hasta || r.createdAt <= new Date(filters.hasta).toISOString()) &&
        (cursor === null || (asc ? Number(r.seq) > cursor : Number(r.seq) < cursor)),
    );
    rows = rows.sort((a, b) => (asc ? Number(a.seq) - Number(b.seq) : Number(b.seq) - Number(a.seq)));
    const page = rows.slice(0, limit).map(({ organizationId: _o, ...rest }) => rest);
    return { items: page, nextCursor: rows.length > limit ? (page[page.length - 1]?.seq ?? null) : null, available: true };
  }

  listTenderAuditLogForTests(tenderId: string): readonly { action: string; actorId: string; createdAt: string }[] {
    return this.tenderAuditLog.get(tenderId) ?? [];
  }

  async listTenderAuditLogPage(organizationId: string, tenderId: string, opts: { readonly limit: number; readonly offset: number }): Promise<TenderAuditLogPage> {
    const { limit, offset } = opts;
    // f2-orden-total-bitacoras -- desempate por `seq` cuando `createdAtMs` empata
    // (ver el comentario de `tenderAuditLog` arriba) -- MISMO orden que
    // `PostgresLicitacionesRepository.listTenderAuditLogPage` (`order by
    // created_at desc, seq desc`).
    const filtrados = (this.tenderAuditLog.get(tenderId) ?? [])
      .filter((r) => r.organizationId === organizationId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.seq - a.seq);
    const total = filtrados.length;
    const pagina = filtrados
      .slice(offset, offset + limit)
      .map(({ organizationId: _organizationId, createdAtMs: _createdAtMs, seq: _seq, ...row }) => ({ ...row, tenderId }));
    return { items: pagina, total, nextOffset: offset + pagina.length < total ? offset + pagina.length : null };
  }

  // ---- Fase 8: ingesta automática real (compras_mx_historico) + recordatorios de plazo ----

  async ingestTendersFromSource(organizationId: string, source: SourceConnectorId, records: readonly TenderSourceIngestCandidate[]): Promise<TenderSourceIngestResult> {
    if (source === "manual") {
      throw new Error('ingestTendersFromSource: "source" no puede ser "manual" -- ese camino de escritura es upsertTenderManual(), nunca este.');
    }
    let created = 0;
    let updated = 0;
    const tenders: TenderRecord[] = [];
    const createdIds: string[] = [];
    const nowIso = new Date().toISOString();

    for (const rec of records) {
      const key = `${organizationId}:${source}:${rec.externalId}`;
      const existingId = this.tenderBySourceExternalKey.get(key);
      const existing = existingId ? this.tenders.get(existingId) : undefined;

      if (existing) {
        const updatedTender: TenderRecord = {
          ...existing,
          title: rec.title,
          submissionDeadline: rec.submissionDeadline,
          contractingBody: rec.contractingBody,
          cpvCodes: [...rec.cpvCodes],
          budgetAmount: rec.budgetAmount,
          currency: rec.currency,
          state: rec.state,
          procedureTypeRaw: rec.procedureTypeRaw,
          updatedAt: nowIso,
        };
        this.tenders.set(existing.id, updatedTender);
        tenders.push(updatedTender);
        updated += 1;
        continue;
      }

      const createdTender: TenderRecord = {
        id: randomUUID(),
        organizationId,
        title: rec.title,
        submissionDeadline: rec.submissionDeadline,
        updatedAt: nowIso,
        source,
        externalId: rec.externalId,
        contractingBody: rec.contractingBody,
        cpvCodes: [...rec.cpvCodes],
        budgetAmount: rec.budgetAmount,
        currency: rec.currency,
        state: rec.state,
        procedureTypeRaw: rec.procedureTypeRaw,
        status: "discovered",
      };
      this.tenders.set(createdTender.id, createdTender);
      this.tenderBySourceExternalKey.set(key, createdTender.id);
      tenders.push(createdTender);
      createdIds.push(createdTender.id);
      created += 1;
    }

    return { created, updated, tenders, createdIds };
  }

  async listActiveOrganizations(): Promise<readonly { id: string }[]> {
    return [...this.organizations.values()].filter((o) => o.isActive).map((o) => ({ id: o.id }));
  }

  private static readonly DEADLINE_REMINDER_EXCLUDED_STATUSES = new Set(["cancelled", "lost", "won", "submitted"]);

  async scanUpcomingDeadlineReminders(organizationId: string, input: ScanDeadlineRemindersInput = {}): Promise<ScanDeadlineRemindersResult> {
    const windowDays = input.windowDays ?? 3;
    const now = input.nowIso ? new Date(input.nowIso) : new Date();
    const windowEndMs = now.getTime() + windowDays * 24 * 60 * 60 * 1000;

    const candidates = [...this.tenders.values()].filter((t) => {
      if (t.organizationId !== organizationId) return false;
      if (!t.submissionDeadline) return false;
      const deadlineMs = new Date(t.submissionDeadline).getTime();
      if (Number.isNaN(deadlineMs)) return false;
      if (deadlineMs <= now.getTime() || deadlineMs > windowEndMs) return false;
      const status = t.status ?? "discovered";
      return !InMemoryLicitacionesRepository.DEADLINE_REMINDER_EXCLUDED_STATUSES.has(status);
    });

    let created = 0;
    const createdReminders: TenderDeadlineReminderRecord[] = [];
    for (const tender of candidates) {
      const deadlineDateOnly = tender.submissionDeadline!.slice(0, 10);
      const dedupeKey = `${tender.id}:${deadlineDateOnly}`;
      if (this.deadlineReminderDedupeKeys.has(dedupeKey)) continue;
      this.deadlineReminderDedupeKeys.add(dedupeKey);

      const daysRemaining = Math.ceil((new Date(tender.submissionDeadline!).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      const record: TenderDeadlineReminderRecord = {
        id: randomUUID(),
        organizationId,
        tenderId: tender.id,
        submissionDeadline: tender.submissionDeadline!,
        daysRemaining,
        message: mensajeRecordatorioPlazo(tender.title, tender.submissionDeadline!, now.toISOString(), officialOnlyCalendar()),
        createdAt: new Date().toISOString(),
        acknowledgedAt: null,
        acknowledgedBy: null,
      };
      this.deadlineReminders.set(record.id, record);
      createdReminders.push(record);
      created += 1;
    }

    return { scanned: candidates.length, created, reminders: createdReminders };
  }

  async listTenderDeadlineReminders(organizationId: string, tenderId?: string): Promise<readonly TenderDeadlineReminderRecord[]> {
    return [...this.deadlineReminders.values()]
      .filter((r) => r.organizationId === organizationId && (tenderId === undefined || r.tenderId === tenderId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async acknowledgeTenderDeadlineReminder(organizationId: string, reminderId: string, actorId: string): Promise<TenderDeadlineReminderRecord> {
    const existing = this.deadlineReminders.get(reminderId);
    if (!existing || existing.organizationId !== organizationId) throw new Error(`Recordatorio de vencimiento "${reminderId}" no encontrado para la organización "${organizationId}".`);
    const updated: TenderDeadlineReminderRecord = { ...existing, acknowledgedAt: new Date().toISOString(), acknowledgedBy: actorId };
    this.deadlineReminders.set(reminderId, updated);
    return updated;
  }

  // ---- Fase 3 pieza 2: perfil de matching de la organización (§5) ----

  async findMatchingProfile(organizationId: string): Promise<MatchingProfileRecord | null> {
    return this.matchingProfiles.get(organizationId) ?? null;
  }

  async upsertMatchingProfile(organizationId: string, input: MatchingProfileUpsertInput): Promise<MatchingProfileRecord> {
    const record: MatchingProfileRecord = {
      organizationId,
      keywords: [...input.keywords],
      excludedKeywords: [...input.excludedKeywords],
      classifierCodes: [...input.classifierCodes],
      entities: [...input.entities],
      states: [...input.states],
      budgetMin: input.budgetMin,
      budgetMax: input.budgetMax,
      updatedBy: input.actorId,
      updatedAt: new Date().toISOString(),
    };
    this.matchingProfiles.set(organizationId, record);
    return record;
  }

  // ---- Fase 3 pieza 3: decisiones go/no-go (§7) ----

  async createGoNoGoDecision(organizationId: string, tenderId: string, input: GoNoGoDecisionCreateInput): Promise<GoNoGoDecisionRecord> {
    const tender = this.tenders.get(tenderId);
    if (!tender || tender.organizationId !== organizationId) {
      throw new Error(`Tender "${tenderId}" no encontrado para la organización "${organizationId}".`);
    }
    // Lanza `GoNoGoRejectedError` si el rol o los motivos no pasan la regla
    // -- ninguna fila se toca en ese caso (mismo criterio que
    // `ApprovalWorkflow.approve()`).
    const validated = buildGoNoGoDecision({
      decision: input.decision,
      reasons: input.reasons,
      actorId: input.actorId,
      actorRole: input.actorRole,
      matchScore: input.matchScore,
      matchEligibilityStatus: input.matchEligibilityStatus,
      matchInputsHash: input.matchInputsHash,
    });

    const record: GoNoGoDecisionRecord = {
      id: randomUUID(),
      organizationId,
      tenderId,
      decision: validated.decision,
      reasons: validated.reasons,
      matchScore: validated.matchScore,
      matchEligibilityStatus: validated.matchEligibilityStatus,
      matchInputsHash: validated.matchInputsHash,
      decidedBy: validated.decidedBy,
      decidedAt: validated.decidedAt,
    };
    const list = this.goNoGoDecisions.get(tenderId) ?? [];
    this.goNoGoDecisions.set(tenderId, [...list, record]);

    // §7: un go/no_go es el único camino que saca una convocatoria de
    // discovered/in_review -- se escribe en la MISMA operación.
    this.tenders.set(tenderId, { ...tender, status: validated.decision, updatedAt: validated.decidedAt });

    return record;
  }

  async listGoNoGoDecisions(organizationId: string, tenderId: string): Promise<readonly GoNoGoDecisionRecord[]> {
    const tender = this.tenders.get(tenderId);
    if (!tender || tender.organizationId !== organizationId) return [];
    // `decidedAt` viene de `new Date().toISOString()` (resolución de
    // milisegundo) -- dos decisiones capturadas en sucesión rápida (normal en
    // pruebas, y no imposible en producción) pueden empatar exactamente. Se
    // invierte el arreglo ANTES de ordenar para que, en un empate, el
    // desempate sea el orden de inserción real (más reciente primero) en vez
    // de depender de qué tan estable resulte comparar strings iguales --
    // `Array.prototype.sort` es estable, así que invertir primero es
    // suficiente y determinista.
    return [...(this.goNoGoDecisions.get(tenderId) ?? [])].reverse().sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  }

  // ---- Fase 16: resolución won/lost (ver tender-resolution.ts) ----

  async resolveTender(organizationId: string, tenderId: string, input: TenderResolutionCreateInput): Promise<TenderRecord> {
    const tender = this.tenders.get(tenderId);
    if (!tender || tender.organizationId !== organizationId) {
      throw new Error(`Tender "${tenderId}" no encontrado para la organización "${organizationId}".`);
    }
    const fromStatus = tender.status ?? "discovered";
    const check = checkTenderResolution(fromStatus);
    if (!check.valid) throw new TenderResolutionRejectedError(fromStatus, input.resolution, check.allowedFromStatuses);

    const resolvedAt = isoNow();
    const record: TenderResolutionRecord = {
      id: randomUUID(),
      organizationId,
      tenderId,
      resolution: input.resolution,
      fromStatus,
      reason: input.reason,
      resolvedBy: input.actorId,
      resolvedAt,
    };
    const list = this.tenderResolutions.get(tenderId) ?? [];
    this.tenderResolutions.set(tenderId, [...list, record]);

    const updated: TenderRecord = { ...tender, status: input.resolution, updatedAt: resolvedAt };
    this.tenders.set(tenderId, updated);
    return updated;
  }

  async listTenderResolutions(organizationId: string, tenderId: string): Promise<readonly TenderResolutionRecord[]> {
    const tender = this.tenders.get(tenderId);
    if (!tender || tender.organizationId !== organizationId) return [];
    return this.tenderResolutions.get(tenderId) ?? [];
  }

  // ---- Flujo 1: checklist de integridad ----

  async listComplianceItems(organizationId: string, proposalId: string): Promise<readonly ComplianceItemRecord[]> {
    this.assertProposalOwnership(organizationId, proposalId);
    return this.complianceItems.get(proposalId) ?? [];
  }

  async replaceComplianceItems(organizationId: string, _tenderId: string, proposalId: string, items: readonly ComplianceItemRecord[]): Promise<void> {
    this.assertProposalOwnership(organizationId, proposalId);
    this.complianceItems.set(proposalId, [...items]);
  }

  async listRequiredAnnexes(organizationId: string, tenderId: string): Promise<readonly RequiredAnnexItem[]> {
    return this.requiredAnnexes.get(`${organizationId}:${tenderId}`) ?? [];
  }

  async listCompanyDocuments(organizationId: string, _asOfIso: string): Promise<readonly CompanyDocumentRecord[]> {
    return this.companyDocuments.get(organizationId) ?? [];
  }

  async listCompanyCapabilities(organizationId: string): Promise<readonly CompanyCapabilityRecord[]> {
    return this.companyCapabilities.get(organizationId) ?? [];
  }

  async listCompanyExperience(organizationId: string): Promise<readonly CompanyExperienceItemRecord[]> {
    return this.companyExperience.get(organizationId) ?? [];
  }

  async listCompanySigners(organizationId: string): Promise<readonly CompanySignerRecord[]> {
    return this.companySigners.get(organizationId) ?? [];
  }

  // ---- Fase 16: escritura de "datos de empresa" (ver repository.ts para el
  // porqué -- sin esto, toda propuesta que dependiera de un dato ausente
  // quedaba PENDIENTE para siempre, sin ningún camino real para capturarlo). ----

  /**
   * Regla DB-03 (paridad con el trigger de la migración 036): si el patch cambia algún DATO, el registro vuelve a
   * 'pendiente_aprobacion', se limpian `approvedBy`/`approvedAt` y `proposedBy` pasa a quien editó.
   */
  private editCompanyRecord<T extends { approvalStatus: CompanyItemStatus; proposedBy?: string | null; approvedBy?: string | null; approvedAt?: string | null }>(
    existing: T,
    input: { readonly actorId?: string },
  ): T {
    const { actorId, ...patch } = input as { actorId?: string } & Record<string, unknown>;
    const changed = Object.entries(patch).some(([key, value]) => value !== undefined && (existing as Record<string, unknown>)[key] !== value);
    const merged = { ...existing } as T;
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    if (!changed) return merged;
    return { ...merged, approvalStatus: "pendiente_aprobacion", approvedBy: null, approvedAt: null, proposedBy: actorId ?? existing.proposedBy ?? null };
  }

  private newCompanyAuthorship(actorId: string | undefined): { proposedBy: string | null; approvedBy: null; approvedAt: null } {
    return { proposedBy: actorId ?? null, approvedBy: null, approvedAt: null };
  }

  /** Perfil completo (migración 040) y procedencia por campo: doble en memoria. Se expone para que las pruebas simulen fallos de procedencia y datos sembrados por SQL. */
  readonly companyProfile = new InMemoryCompanyProfileStore();

  /** REQ-142: registra la procedencia de un dato de las tablas anteriores. Primero comprueba que se PUEDE escribir (si falla, el alta/edición no ocurre: equivale al rollback de Postgres). */
  private noteProvenance(organizationId: string, entity: ProvenanceEntity, entityId: string, input: { readonly actorId?: string }, keys: readonly string[]): void {
    this.companyProfile.recordProvenance(organizationId, entity, entityId, keys.filter((k) => (input as Record<string, unknown>)[k] !== undefined), input.actorId);
  }

  /** Bitácora de decisiones (paridad con `licitaciones.company_data_audit`); solo para pruebas. */
  readonly companyDataAudit: { organizationId: string; kind: CompanyItemKind; itemId: string; decision: CompanyItemDecision; actorId: string; createdAt: string }[] = [];

  async createCompanyDocument(organizationId: string, input: CompanyDocumentCreateInput): Promise<CompanyDocumentRecord> {
    this.companyProfile.assertProvenanceWritable();
    const record: CompanyDocumentRecord = { id: randomUUID(), type: input.type, label: input.label, expiresAt: input.expiresAt, approvalStatus: "pendiente_aprobacion", ...this.newCompanyAuthorship(input.actorId) };
    const list = this.companyDocuments.get(organizationId) ?? [];
    this.companyDocuments.set(organizationId, [...list, record]);
    this.noteProvenance(organizationId, "document", record.id, input, ["type", "label", "expiresAt"]);
    return record;
  }

  async updateCompanyDocument(organizationId: string, documentId: string, input: CompanyDocumentUpdateInput): Promise<CompanyDocumentRecord> {
    this.companyProfile.assertProvenanceWritable();
    const list = this.companyDocuments.get(organizationId) ?? [];
    const index = list.findIndex((d) => d.id === documentId);
    if (index === -1) throw new CompanyDataNotFoundError("Documento de empresa", documentId);
    const updated = this.editCompanyRecord(list[index]!, input);
    const next = [...list];
    next[index] = updated;
    this.companyDocuments.set(organizationId, next);
    this.noteProvenance(organizationId, "document", documentId, input, ["label", "expiresAt"]);
    return updated;
  }

  async createApprovedRate(organizationId: string, input: ApprovedRateCreateInput): Promise<ApprovedRateRecord> {
    this.companyProfile.assertProvenanceWritable();
    const list = this.approvedRates.get(organizationId) ?? [];
    if (list.some((r) => r.concept === input.concept)) throw new CompanyDataDuplicateKeyError("tarifa aprobada", input.concept);
    const record: ApprovedRateRecord = {
      id: randomUUID(),
      concept: input.concept,
      unitPrice: input.unitPrice,
      currency: "MXN",
      approvalStatus: "pendiente_aprobacion",
      ...this.newCompanyAuthorship(input.actorId),
      // Paridad con `PostgresLicitacionesRepository.createApprovedRate` (ver su
      // comentario de cabecera): el default de `validFrom` es el día de NEGOCIO
      // de ESTA organización (`this.todayForOrg`, que resuelve `resolverZonaHorariaNegocio`
      // sobre `licitaciones.tenant_config.timezone` -- FASE 3, ver ese método),
      // nunca `isoNow()` (día UTC crudo del proceso) ni el default de plataforma
      // hardcodeado. El contrato de `ApprovedRateRecord.validFrom` exige ISO con
      // offset horario EXPLÍCITO (`assertExplicitOffset`, types.ts) --
      // `todayForOrg` sola devuelve "YYYY-MM-DD" pelón, que NO lo trae; se le
      // agrega "T00:00:00Z" para que el default en memoria tenga la MISMA forma
      // que `dateColumnToExplicitOffsetIso` produce sobre la respuesta real de
      // Postgres (postgres-repository.ts), y así no viole
      // `CompanyDataService.resolveApprovedRate::assertExplicitOffset` en
      // `POST .../proposal/economic/generate` (bloqueante de revisión detectado
      // el 20-sep: antes de este fix, el valor persistía como "YYYY-MM-DD" y
      // `assertExplicitOffset` lanzaba en cuanto se resolvía la tarifa).
      validFrom: input.validFrom ?? `${this.todayForOrg(organizationId)}T00:00:00Z`,
      validUntil: input.validUntil ?? null,
    };
    this.approvedRates.set(organizationId, [...list, record]);
    this.noteProvenance(organizationId, "rate", record.id, input, ["concept", "unitPrice", "validFrom", "validUntil"]);
    return record;
  }

  async updateApprovedRate(organizationId: string, rateId: string, input: ApprovedRateUpdateInput): Promise<ApprovedRateRecord> {
    this.companyProfile.assertProvenanceWritable();
    const list = this.approvedRates.get(organizationId) ?? [];
    const index = list.findIndex((r) => r.id === rateId);
    if (index === -1) throw new CompanyDataNotFoundError("Tarifa aprobada", rateId);
    const updated = this.editCompanyRecord(list[index]!, input);
    const next = [...list];
    next[index] = updated;
    this.approvedRates.set(organizationId, next);
    this.noteProvenance(organizationId, "rate", rateId, input, ["unitPrice", "validFrom", "validUntil"]);
    return updated;
  }

  async listAllApprovedRates(organizationId: string): Promise<readonly ApprovedRateRecord[]> {
    return this.approvedRates.get(organizationId) ?? [];
  }

  async createCompanyCapability(organizationId: string, input: CompanyCapabilityCreateInput): Promise<CompanyCapabilityRecord> {
    this.companyProfile.assertProvenanceWritable();
    const list = this.companyCapabilities.get(organizationId) ?? [];
    if (list.some((c) => c.name === input.name)) throw new CompanyDataDuplicateKeyError("capacidad", input.name);
    const record: CompanyCapabilityRecord = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      evidenceDocId: input.evidenceDocId ?? null,
      approvalStatus: "pendiente_aprobacion",
      ...this.newCompanyAuthorship(input.actorId),
    };
    this.companyCapabilities.set(organizationId, [...list, record]);
    this.noteProvenance(organizationId, "capability", record.id, input, ["name", "description", "evidenceDocId"]);
    return record;
  }

  async updateCompanyCapability(organizationId: string, capabilityId: string, input: CompanyCapabilityUpdateInput): Promise<CompanyCapabilityRecord> {
    this.companyProfile.assertProvenanceWritable();
    const list = this.companyCapabilities.get(organizationId) ?? [];
    const index = list.findIndex((c) => c.id === capabilityId);
    if (index === -1) throw new CompanyDataNotFoundError("Capacidad", capabilityId);
    const updated = this.editCompanyRecord(list[index]!, input);
    const next = [...list];
    next[index] = updated;
    this.companyCapabilities.set(organizationId, next);
    this.noteProvenance(organizationId, "capability", capabilityId, input, ["description", "evidenceDocId"]);
    return updated;
  }

  async createCompanyExperience(organizationId: string, input: CompanyExperienceCreateInput): Promise<CompanyExperienceItemRecord> {
    this.companyProfile.assertProvenanceWritable();
    const record: CompanyExperienceItemRecord = { id: randomUUID(), description: input.description, evidenceDocId: input.evidenceDocId, approvalStatus: "pendiente_aprobacion", ...this.newCompanyAuthorship(input.actorId) };
    const list = this.companyExperience.get(organizationId) ?? [];
    this.companyExperience.set(organizationId, [...list, record]);
    this.noteProvenance(organizationId, "experience", record.id, input, ["description", "evidenceDocId"]);
    return record;
  }

  async updateCompanyExperience(organizationId: string, experienceId: string, input: CompanyExperienceUpdateInput): Promise<CompanyExperienceItemRecord> {
    this.companyProfile.assertProvenanceWritable();
    const list = this.companyExperience.get(organizationId) ?? [];
    const index = list.findIndex((e) => e.id === experienceId);
    if (index === -1) throw new CompanyDataNotFoundError("Experiencia", experienceId);
    const updated = this.editCompanyRecord(list[index]!, input);
    const next = [...list];
    next[index] = updated;
    this.companyExperience.set(organizationId, next);
    this.noteProvenance(organizationId, "experience", experienceId, input, ["description", "evidenceDocId"]);
    return updated;
  }

  async createCompanySigner(organizationId: string, input: CompanySignerCreateInput): Promise<CompanySignerRecord> {
    // Base sin la 040 (simulada): no hay donde guardar la vigencia del poder; pedirla no se descarta en silencio.
    if (!this.companyProfileAvailable && (input.validFrom != null || input.validUntil != null || input.identityDocId != null || input.actionLimits != null)) throw new CompanyProfileNotAvailableError();
    this.companyProfile.assertProvenanceWritable();
    const list = this.companySigners.get(organizationId) ?? [];
    // Varios firmantes por cargo (migración 040); solo se rechaza repetir el mismo nombre en el mismo cargo (doble envío).
    if (list.some((s) => s.role === input.role && s.name.trim().toLowerCase() === input.name.trim().toLowerCase())) throw new CompanyDataDuplicateKeyError("firmante", `${input.role} / ${input.name}`);
    const record: CompanySignerRecord = {
      id: randomUUID(),
      name: input.name,
      role: input.role,
      authorized: input.authorized ?? false,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      identityDocId: input.identityDocId ?? null,
      actionLimits: input.actionLimits ?? null,
      approvalStatus: "pendiente_aprobacion",
      ...this.newCompanyAuthorship(input.actorId),
    };
    this.companySigners.set(organizationId, [...list, record]);
    this.noteProvenance(organizationId, "signer", record.id, input, ["name", "role", "authorized", "validFrom", "validUntil", "identityDocId", "actionLimits"]);
    return record;
  }

  async updateCompanySigner(organizationId: string, signerId: string, input: CompanySignerUpdateInput): Promise<CompanySignerRecord> {
    if (!this.companyProfileAvailable && (["validFrom", "validUntil", "identityDocId", "actionLimits"] as const).some((k) => input[k] !== undefined)) throw new CompanyProfileNotAvailableError();
    this.companyProfile.assertProvenanceWritable();
    const list = this.companySigners.get(organizationId) ?? [];
    const index = list.findIndex((s) => s.id === signerId);
    if (index === -1) throw new CompanyDataNotFoundError("Firmante", signerId);
    const updated = this.editCompanyRecord(list[index]!, input);
    const next = [...list];
    next[index] = updated;
    this.companySigners.set(organizationId, next);
    this.noteProvenance(organizationId, "signer", signerId, input, ["name", "authorized", "validFrom", "validUntil", "identityDocId", "actionLimits"]);
    return updated;
  }

  // ---- Perfil de empresa completo (migración 040): delegado a `InMemoryCompanyProfileStore` ----

  /** Solo pruebas: `false` simula la base sin migrar (la API responde \"no disponible aun\"). */
  companyProfileAvailable = true;
  async isCompanyProfileAvailable() { return this.companyProfileAvailable; }
  private requireProfileTables(): void {
    if (!this.companyProfileAvailable) throw new CompanyProfileNotAvailableError();
  }

  async getCompanyProfile(organizationId: string) { return this.companyProfileAvailable ? this.companyProfile.getProfile(organizationId) : null; }
  async upsertCompanyProfile(organizationId: string, input: CompanyProfileUpsertInput) { this.requireProfileTables(); return this.companyProfile.upsertProfile(organizationId, input); }
  async listCompanyProductsServices(organizationId: string) { return this.companyProfileAvailable ? this.companyProfile.list<CompanyProductServiceRecord>("product", organizationId) : []; }
  async createCompanyProductService(organizationId: string, input: CompanyProductServiceCreateInput) { this.requireProfileTables(); return this.companyProfile.createProduct(organizationId, input); }
  async updateCompanyProductService(organizationId: string, id: string, input: CompanyProductServiceUpdateInput) { this.requireProfileTables(); return this.companyProfile.updateProduct(organizationId, id, input); }
  async listCompanyLocations(organizationId: string) { return this.companyProfileAvailable ? this.companyProfile.list<CompanyLocationRecord>("location", organizationId) : []; }
  async createCompanyLocation(organizationId: string, input: CompanyLocationCreateInput) { this.requireProfileTables(); return this.companyProfile.createLocation(organizationId, input); }
  async updateCompanyLocation(organizationId: string, id: string, input: CompanyLocationUpdateInput) { this.requireProfileTables(); return this.companyProfile.updateLocation(organizationId, id, input); }
  async listCompanyRestrictions(organizationId: string) { return this.companyProfileAvailable ? this.companyProfile.list<CompanyRestrictionRecord>("restriction", organizationId) : []; }
  async createCompanyRestriction(organizationId: string, input: CompanyRestrictionCreateInput) { this.requireProfileTables(); return this.companyProfile.createRestriction(organizationId, input); }
  async updateCompanyRestriction(organizationId: string, id: string, input: CompanyRestrictionUpdateInput) { this.requireProfileTables(); return this.companyProfile.updateRestriction(organizationId, id, input); }
  async listCompanyStakeholders(organizationId: string) { return this.companyProfileAvailable ? this.companyProfile.list<CompanyStakeholderRecord>("stakeholder", organizationId) : []; }
  async createCompanyStakeholder(organizationId: string, input: CompanyStakeholderCreateInput) { this.requireProfileTables(); return this.companyProfile.createStakeholder(organizationId, input); }
  async updateCompanyStakeholder(organizationId: string, id: string, input: CompanyStakeholderUpdateInput) { this.requireProfileTables(); return this.companyProfile.updateStakeholder(organizationId, id, input); }
  async deleteCompanyProfileItem(organizationId: string, kind: CompanyProfileCollectionKind, id: string) { this.requireProfileTables(); return this.companyProfile.remove(kind, organizationId, id); }
  async listFieldProvenance(organizationId: string) { return this.companyProfileAvailable ? this.companyProfile.listFieldProvenance(organizationId) : []; }

  async decideCompanyItem(organizationId: string, input: CompanyItemDecisionInput): Promise<CompanyItemDecisionOutcome> {
    const legacy: Partial<Record<CompanyItemKind, Map<string, CompanyDecidable[]>>> = {
      rate: this.approvedRates as Map<string, CompanyDecidable[]>,
      document: this.companyDocuments as Map<string, CompanyDecidable[]>,
      capability: this.companyCapabilities as Map<string, CompanyDecidable[]>,
      experience: this.companyExperience as Map<string, CompanyDecidable[]>,
      signer: this.companySigners as Map<string, CompanyDecidable[]>,
    };
    const legacyStore = legacy[input.kind];
    const profileStore = legacyStore ? null : this.companyProfile.decidable(input.kind as "profile" | CompanyProfileCollectionKind, organizationId);
    const store = {
      get: () => (legacyStore ? legacyStore.get(organizationId) ?? [] : profileStore!.list) as readonly CompanyDecidable[],
      set: (next: CompanyDecidable[]) => (legacyStore ? legacyStore.set(organizationId, next) : profileStore!.set(next)),
    };
    const decisionRoles = input.kind === "rate" ? ["owner", "admin"] : ["owner", "admin", "analyst"];
    if (!decisionRoles.includes(input.actorRole)) return "rol";
    const list = store.get();
    const index = list.findIndex((r) => r.id === input.itemId);
    if (index === -1) return "not_found";
    const current = list[index]!;
    if (current.approvalStatus !== "pendiente_aprobacion") return "conflict";
    if (current.proposedBy === input.actorId) return "autor";
    const now = isoNow();
    const next = [...list];
    next[index] = { ...current, approvalStatus: input.decision, approvedBy: input.actorId, approvedAt: now };
    store.set(next);
    this.companyDataAudit.push({ organizationId, kind: input.kind, itemId: input.itemId, decision: input.decision, actorId: input.actorId, createdAt: now });
    return "ok";
  }

  // ---- Flujo 2: propuesta económica ----

  /** REQ-LIC-005: pre-filtra server-side a tarifas aprobadas y vigentes a `asOfIso` — el mismo criterio que aplicaría la migración Postgres real. */
  async listApprovedRates(organizationId: string, asOfIso: string): Promise<readonly ApprovedRateRecord[]> {
    const asOfMs = new Date(asOfIso).getTime();
    return (this.approvedRates.get(organizationId) ?? []).filter((r) => {
      if (r.approvalStatus !== "aprobado") return false;
      if (new Date(r.validFrom).getTime() > asOfMs) return false;
      if (r.validUntil !== null && new Date(r.validUntil).getTime() < asOfMs) return false;
      return true;
    });
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
    const proposal = this.assertProposalOwnership(organizationId, proposalId);
    const updated: ProposalRecord = {
      ...proposal,
      economicTotals: input.economicTotals,
      generationReport: {
        ...(proposal.generationReport ?? {}),
        economic: input.generationReportPatch as NonNullable<ProposalRecord["generationReport"]>["economic"],
      },
      correlationId: input.correlationId,
    };
    this.proposals.set(proposalId, updated);

    if (input.cartaSection) this.upsertSection(proposalId, "economic:carta", "Carta de proposición económica", input.cartaSection.content, input.actorId);
    if (input.anexoSection) this.upsertSection(proposalId, "economic:anexo", "Anexo económico", input.anexoSection.content, input.actorId);

    return updated;
  }

  private upsertSection(proposalId: string, sectionKey: string, label: string, content: string, actorId: string): void {
    const map = this.proposalSections.get(proposalId) ?? new Map<string, StoredProposalSection>();
    const existing = map.get(sectionKey);
    map.set(sectionKey, {
      documentId: existing?.documentId ?? randomUUID(),
      sectionKey,
      label,
      filename: `${sectionKey}.txt`,
      version: (existing?.version ?? 0) + 1,
      content,
    });
    this.proposalSections.set(proposalId, map);
    this.recordSectionAuthor(proposalId, sectionKey, actorId);
  }

  /** AE-11 (ver diseño Fase 2 §2.3): SIEMPRE se llama desde el propio repositorio al persistir contenido de una sección, nunca depende de que una ruta se acuerde de invocarlo aparte. */
  private recordSectionAuthor(proposalId: string, sectionKey: string, actorId: string): void {
    const scopeRef = `seccion:${sectionKey}`;
    const perProposal = this.sectionAuthors.get(proposalId) ?? new Map<string, Set<string>>();
    const authors = perProposal.get(scopeRef) ?? new Set<string>();
    authors.add(actorId);
    perProposal.set(scopeRef, authors);
    this.sectionAuthors.set(proposalId, perProposal);
  }

  // ---- Flujo 3: ensamblado / descarga / declaración ----

  async loadProposalSectionsAsDocuments(organizationId: string, proposalId: string): Promise<readonly { documentId: string; label: string; filename: string; version: number; content?: string }[]> {
    this.assertProposalOwnership(organizationId, proposalId);
    const map = this.proposalSections.get(proposalId);
    if (!map) return [];
    return [...map.values()]
      .sort((a, b) => a.sectionKey.localeCompare(b.sectionKey))
      .map((s) => ({ documentId: s.documentId, label: s.label, filename: s.filename, version: s.version, content: s.content }));
  }

  async computeCurrentInputsHash(organizationId: string, tenderId: string, proposalId: string): Promise<{ hash: string; raw: unknown }> {
    const tender = await this.findTender(organizationId, tenderId);
    if (!tender) throw new Error(`Tender "${tenderId}" no encontrado para la organización "${organizationId}".`);
    const proposal = this.assertProposalOwnership(organizationId, proposalId);

    const usedCompanyDocumentIds = proposal.generationReport?.technical?.usedCompanyDocumentIds ?? [];
    const usedRateConcepts = proposal.generationReport?.economic?.usedRateConcepts ?? [];
    const documents = this.companyDocuments.get(organizationId) ?? [];
    const rates = this.approvedRates.get(organizationId) ?? [];

    const raw: ExpedienteInputs = {
      tenderVersionHash: sha256Hex({ updatedAt: tender.updatedAt, submissionDeadline: tender.submissionDeadline }),
      // AE-08 / REQ-162: hash REAL de todo el perfil (documentos, capacidades, experiencia, firmantes y su estado de
      // aprobación). Cambiar cualquiera de ellos invalida la aprobación del expediente.
      companyProfileHash: computeCompanyProfileHash({
        documents,
        capabilities: this.companyCapabilities.get(organizationId) ?? [],
        experience: this.companyExperience.get(organizationId) ?? [],
        signers: this.companySigners.get(organizationId) ?? [],
        profile: this.companyProfile.getProfile(organizationId),
        productsServices: this.companyProfile.list<CompanyProductServiceRecord>("product", organizationId),
        locations: this.companyProfile.list<CompanyLocationRecord>("location", organizationId),
        restrictions: this.companyProfile.list<CompanyRestrictionRecord>("restriction", organizationId),
        stakeholders: this.companyProfile.list<CompanyStakeholderRecord>("stakeholder", organizationId),
      }),
      companyDocuments: usedCompanyDocumentIds.map((id) => {
        const doc = documents.find((d) => d.id === id);
        return { documentId: id, hash: sha256Hex(doc ?? null), vigenteHasta: doc?.expiresAt ?? null };
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
    this.requirementItems.set(`${organizationId}:${tenderId}`, [...items]);
  }

  async listRequirementItems(organizationId: string, tenderId: string): Promise<readonly RequirementItemRecord[]> {
    return this.requirementItems.get(`${organizationId}:${tenderId}`) ?? [];
  }

  async listFulfillmentMappings(organizationId: string): Promise<readonly RequirementFulfillmentMappingRecord[]> {
    return [...(this.fulfillmentMappings.get(organizationId) ?? new Map()).values()];
  }

  async upsertFulfillmentMapping(
    organizationId: string,
    input: { topicKey: string; kind: RequirementFulfillmentMappingRecord["kind"]; refKey: string; statementTemplate: string },
  ): Promise<RequirementFulfillmentMappingRecord> {
    const perOrg = this.fulfillmentMappings.get(organizationId) ?? new Map<string, RequirementFulfillmentMappingRecord>();
    const existing = perOrg.get(input.topicKey);
    const record: RequirementFulfillmentMappingRecord = { id: existing?.id ?? randomUUID(), topicKey: input.topicKey, kind: input.kind, refKey: input.refKey, statementTemplate: input.statementTemplate };
    perOrg.set(input.topicKey, record);
    this.fulfillmentMappings.set(organizationId, perOrg);
    return record;
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
    const proposal = this.assertProposalOwnership(organizationId, proposalId);
    const updated: ProposalRecord = {
      ...proposal,
      generationReport: {
        ...(proposal.generationReport ?? {}),
        technical: { usedCompanyDocumentIds: [...input.usedCompanyDocumentIds], notApplicableRequirements: [...input.notApplicableRequirements] },
      },
    };
    this.proposals.set(proposalId, updated);

    for (const section of input.sections) {
      this.upsertSection(proposalId, section.sectionKey, section.label, section.content, input.actorId);
    }

    return updated;
  }

  // ---- Fase 2 pieza 1: máquina de aprobaciones granular (AE-02/AE-11) ----

  /** Solo pruebas: simula una base SIN la migracion 033 ("legacy": aprobacion unica, sin etapas). Por defecto "doble". */
  setExpedienteStageMode(mode: "doble" | "legacy"): void {
    this.expedienteStageMode = mode;
  }

  async listExpedienteStageApprovals(organizationId: string, proposalId: string): Promise<{ mode: "doble" | "legacy"; approvals: readonly Approval[] }> {
    this.assertProposalOwnership(organizationId, proposalId);
    const vigentes = (this.approvals.get(proposalId) ?? []).filter((a) => a.status === "vigente" && a.scope === "expediente" && a.scopeRef === "expediente");
    // En modo "legacy" la base ni siquiera conoce la columna `stage`: las filas llegan sin ella.
    const approvals = this.expedienteStageMode === "legacy" ? vigentes.map(({ stage: _stage, ...rest }) => rest) : vigentes;
    return { mode: this.expedienteStageMode, approvals };
  }

  async approve(organizationId: string, proposalId: string, input: { scope: ApprovalScope; scopeRef: string; actorId: string; actorRole: LicitacionesRole; inputsHash: HashedInputs; stage?: ExpedienteApprovalStage }): Promise<Approval> {
    this.assertProposalOwnership(organizationId, proposalId);
    const sectionAuthors = this.sectionAuthors.get(proposalId) ?? new Map<string, Set<string>>();
    if (input.stage !== undefined && this.expedienteStageMode === "legacy") throw new ExpedienteStageNotAvailableError();
    const stageSnapshot = input.stage !== undefined ? (this.approvals.get(proposalId) ?? []).filter((a) => a.status === "vigente") : [];

    // Lanza `ApprovalRejectedError` si la regla rechaza -- ninguna fila se toca en ese caso.
    new ApprovalWorkflow({ sectionAuthors, approvals: stageSnapshot }).approve({ scope: input.scope, scopeRef: input.scopeRef, actorId: input.actorId, actorRole: input.actorRole, inputsHash: input.inputsHash, stage: input.stage });

    const nowIso = new Date().toISOString();
    const existing = this.approvals.get(proposalId) ?? [];
    // Invalida cualquier aprobación previa 'vigente' de EXACTAMENTE el mismo
    // scope/scopeRef (nunca coexisten dos vigentes del mismo alcance exacto).
    const invalidated = existing.map((a) =>
      a.status === "vigente" && a.scopeRef === input.scopeRef && a.stage === input.stage ? { ...a, status: "invalidada" as const, invalidatedAt: nowIso, invalidatedReason: "superseded_by_new_approval" } : a,
    );
    const created: Approval = {
      id: randomUUID(),
      scope: input.scope,
      scopeRef: input.scopeRef,
      approvedBy: input.actorId,
      approvedByRole: input.actorRole,
      approvedAt: nowIso,
      inputsHash: input.inputsHash.hash,
      status: "vigente",
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
    };
    this.approvals.set(proposalId, [...invalidated, created]);
    return created;
  }

  async activeApprovalsCovering(organizationId: string, proposalId: string, scopeRef: string): Promise<readonly Approval[]> {
    this.assertProposalOwnership(organizationId, proposalId);
    const ancestors = scopeRef === "expediente" ? ["expediente"] : ["expediente", scopeRef];
    return (this.approvals.get(proposalId) ?? []).filter((a) => a.status === "vigente" && ancestors.includes(a.scopeRef));
  }

  async recordChange(organizationId: string, proposalId: string, input: { scope: ApprovalScope; scopeRef: string; reason: string }): Promise<ChangeDetected> {
    this.assertProposalOwnership(organizationId, proposalId);
    const covering = await this.activeApprovalsCovering(organizationId, proposalId, input.scopeRef);
    const invalidatedIds = new Set(covering.map((a) => a.id));
    const nowIso = new Date().toISOString();
    const existing = this.approvals.get(proposalId) ?? [];
    this.approvals.set(
      proposalId,
      existing.map((a) => (invalidatedIds.has(a.id) ? { ...a, status: "invalidada" as const, invalidatedAt: nowIso, invalidatedReason: input.reason } : a)),
    );
    const change: ChangeDetected = {
      id: randomUUID(),
      scope: input.scope,
      scopeRef: input.scopeRef,
      reason: input.reason,
      detectedAt: nowIso,
      invalidatedApprovalIds: [...invalidatedIds],
    };
    const changes = this.approvalChanges.get(proposalId) ?? [];
    this.approvalChanges.set(proposalId, [...changes, change]);
    return change;
  }

  async syncExpedienteApprovalWithCurrentHash(organizationId: string, proposalId: string, sealed: HashedInputs, raw: ExpedienteInputs): Promise<ChangeDetected | null> {
    this.assertProposalOwnership(organizationId, proposalId);
    const { hash } = requireValidHashedInputs(sealed, "syncExpedienteApprovalWithCurrentHash(sealed)");

    const latest = await this.latestProposalVersion(organizationId, proposalId);
    if (!latest || latest.hash !== hash) {
      const inputRecords = buildProposalInputRecords(raw);
      const versions = this.proposalVersions.get(proposalId) ?? [];
      const nextVersion = (latest?.version ?? 0) + 1;
      this.proposalVersions.set(proposalId, [...versions, { version: nextVersion, hash, inputs: inputRecords, createdAt: new Date().toISOString() }]);
    }

    const [currentExpedienteApproval] = await this.activeApprovalsCovering(organizationId, proposalId, "expediente");
    if (!currentExpedienteApproval || currentExpedienteApproval.inputsHash === hash) return null;

    const changedKeys = latest ? ProposalVersionRegistry.diff(latest.inputs, raw) : [];
    const reason = changedKeys.length > 0 ? `insumo_cambiado:${changedKeys.join(",")}` : `hash_insumos_divergente:aprobado=${currentExpedienteApproval.inputsHash}:actual=${hash}`;

    return this.recordChange(organizationId, proposalId, { scope: "expediente", scopeRef: "expediente", reason });
  }

  async latestProposalVersion(organizationId: string, proposalId: string): Promise<PersistedProposalVersion | null> {
    this.assertProposalOwnership(organizationId, proposalId);
    const versions = this.proposalVersions.get(proposalId) ?? [];
    if (versions.length === 0) return null;
    return [...versions].sort((a, b) => b.version - a.version)[0]!;
  }

  async saveManifest(
    organizationId: string,
    proposalId: string,
    input: { status: "draft" | "ready"; manifest: unknown; checklistSnapshot: unknown; storageRef: string; inputsHash: string; correlationId: string | null; generatedBy: string },
  ): Promise<{ id: string; generatedAt: string }> {
    this.assertProposalOwnership(organizationId, proposalId);
    const record: PackageManifestRecord = {
      id: randomUUID(),
      status: input.status,
      manifest: input.manifest,
      checklistSnapshot: input.checklistSnapshot,
      storageRef: input.storageRef,
      inputsHash: input.inputsHash,
      generatedAt: new Date().toISOString(),
    };
    const list = this.packageManifests.get(proposalId) ?? [];
    this.packageManifests.set(proposalId, [...list, record]);
    return { id: record.id, generatedAt: record.generatedAt };
  }

  async findLatestManifest(organizationId: string, proposalId: string): Promise<PackageManifestRecord | null> {
    this.assertProposalOwnership(organizationId, proposalId);
    const list = this.packageManifests.get(proposalId) ?? [];
    if (list.length === 0) return null;
    return [...list].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0]!;
  }

  /** Escribe el ZIP del expediente a disco real bajo el `storageDir` de este repositorio — ver storage.ts. */
  async writeManifestZip(organizationId: string, proposalId: string, zip: Uint8Array): Promise<string> {
    return writePackageZip(this.storageDir, organizationId, proposalId, zip);
  }

  async readManifestZip(storageRef: string): Promise<Uint8Array> {
    return readPackageZip(this.storageDir, storageRef);
  }

  async storeAcknowledgement(organizationId: string, buffer: Uint8Array): Promise<{ storageRef: string; sha256: string }> {
    const stored = await storeFile(this.storageDir, organizationId, Buffer.from(buffer));
    return { storageRef: stored.relativePath, sha256: stored.sha256 };
  }

  async findSubmission(organizationId: string, proposalId: string): Promise<SubmissionRecord | null> {
    this.assertProposalOwnership(organizationId, proposalId);
    const list = this.submissions.get(proposalId) ?? [];
    if (list.length === 0) return null;
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
  }

  async declareSubmission(
    organizationId: string,
    proposalId: string,
    input: { userId: string; submittedAt: string; acknowledgementStorageRef: string | null; acknowledgementFileHash: string | null; notes: string | null },
  ): Promise<SubmissionRecord> {
    this.assertProposalOwnership(organizationId, proposalId);
    const record: SubmissionRecord = {
      id: randomUUID(),
      status: "submitted",
      submittedAt: input.submittedAt,
      acknowledgementStorageRef: input.acknowledgementStorageRef,
      acknowledgementFileHash: input.acknowledgementFileHash,
      notes: input.notes,
      createdAt: new Date().toISOString(),
    };
    const list = this.submissions.get(proposalId) ?? [];
    this.submissions.set(proposalId, [...list, record]);
    return record;
  }

  // ---- Idempotencia ----

  async withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>> {
    return this.mutex.run(`${params.organizationId}:${params.scope}:${params.key}`, async () => {
      const requestHash = hashBody(params.body);
      const key = `${params.organizationId}:${params.scope}:${params.key}`;
      const existing = this.idempotency.get(key);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();
        // Fix hallazgo auditoría — antes devolvía `existing.response` sin
        // comprobar `== null`: si una llamada anterior con la MISMA key quedó a
        // medias (ver catch de abajo, caso ya cerrado hoy porque el catch limpia
        // la reclamación, pero deja esta rama honesta ante cualquier estado futuro
        // que la deje en null), esto habría devuelto `null` como si fuera una
        // respuesta completa válida en vez de señalar el conflicto real.
        if (existing.response == null) {
          throw new Error("La solicitud original con este Idempotency-Key aún no terminó de procesarse.");
        }
        return existing.response as IdempotentResult<T>;
      }
      this.idempotency.set(key, { requestHash, response: null });
      try {
        const result = await run();
        this.idempotency.set(key, { requestHash, response: result });
        return result;
      } catch (err) {
        // Fix hallazgo auditoría (rubro 2, "Idempotency-Key queda envenenada ante
        // error no-Postgres") — mismo fix que domain-hoteles/src/in-memory-repository.ts:
        // un error de `run()` nunca debe dejar la key envenenada para siempre; se
        // retira la reclamación para que un reintento legítimo proceda (mismo
        // efecto que el ROLLBACK real de PostgresLicitacionesRepository.withIdempotency).
        this.idempotency.delete(key);
        throw err;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Fase 6 -- seguimiento post-adjudicación (REQ-051..055).
  // ---------------------------------------------------------------------

  private requireTenderRecord(organizationId: string, tenderId: string): void {
    const tender = this.tenders.get(tenderId);
    if (!tender || tender.organizationId !== organizationId) {
      throw new Error(`Tender "${tenderId}" no encontrado para la organización "${organizationId}".`);
    }
  }

  private requireContract(organizationId: string, tenderId: string): ContractRecord {
    const contract = this.contracts.get(tenderId);
    if (!contract || contract.organizationId !== organizationId) {
      throw new Error(`No existe contrato registrado para la convocatoria "${tenderId}" en la organización "${organizationId}".`);
    }
    return contract;
  }

  // Bug real (revisión r6, corrección de PR #171, no-bloqueante #7 -- paridad de
  // repositorios): estos defaults usaban el día UTC del proceso
  // (`new Date().toISOString().slice(0, 10)`), mientras `PostgresLicitacionesRepository`
  // (el que corre en producción) ya usa `hoyFechaNegocio()` -- la suite en memoria dejó
  // de ejercer lo que corre en producción. `contract-billing.ts::classifyInvoiceStatus`/
  // `summarizeReceivables` ya no aceptan un default oculto (ver su comentario) -- este
  // repositorio exige `todayIsoDate` explícito (nunca un default silencioso aquí --
  // a diferencia de la versión anterior, "hoy" depende de la organización dueña del
  // contrato, FASE 3, y este método no la conoce sin `contractId` -> `organizationId`).
  private invoicesWithStatus(contractId: string, todayIsoDate: string): ContractInvoiceRecord[] {
    return (this.contractInvoices.get(contractId) ?? [])
      .map((inv) => ({ ...inv, status: classifyInvoiceStatus(inv, todayIsoDate) }))
      .sort((a, b) => a.invoiceVerifiedOn.localeCompare(b.invoiceVerifiedOn));
  }

  async createContract(organizationId: string, tenderId: string, actorId: string): Promise<ContractRecord> {
    this.requireTenderRecord(organizationId, tenderId);
    const existing = this.contracts.get(tenderId);
    if (existing && existing.organizationId === organizationId) {
      throw new Error("Ya existe un contrato registrado para esta convocatoria.");
    }
    const now = new Date().toISOString();
    const record: ContractRecord = {
      id: randomUUID(),
      organizationId,
      tenderId,
      status: CONTRACT_INITIAL_STATUS,
      endDate: null,
      contractNumber: null,
      hasRenewalOption: false,
      renewalOptionNotes: null,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(tenderId, record);
    const historyEntry: ContractStatusHistoryRecord = {
      id: randomUUID(),
      contractId: record.id,
      fromStatus: null,
      toStatus: CONTRACT_INITIAL_STATUS,
      reason: "Alta del contrato tras adjudicación.",
      actorId,
      evidenceRef: null,
      createdAt: now,
    };
    this.contractStatusHistory.set(record.id, [historyEntry]);
    return record;
  }

  async findContractByTender(organizationId: string, tenderId: string): Promise<ContractRecord | null> {
    const contract = this.contracts.get(tenderId);
    return contract && contract.organizationId === organizationId ? contract : null;
  }

  async updateContractMetadata(organizationId: string, tenderId: string, input: ContractMetadataUpdateInput): Promise<ContractRecord> {
    const contract = this.requireContract(organizationId, tenderId);
    const updated: ContractRecord = {
      ...contract,
      endDate: "endDate" in input ? (input.endDate ?? null) : contract.endDate,
      contractNumber: "contractNumber" in input ? (input.contractNumber ?? null) : contract.contractNumber,
      hasRenewalOption: "hasRenewalOption" in input ? Boolean(input.hasRenewalOption) : contract.hasRenewalOption,
      renewalOptionNotes: "renewalOptionNotes" in input ? (input.renewalOptionNotes ?? null) : contract.renewalOptionNotes,
      updatedAt: new Date().toISOString(),
    };
    this.contracts.set(tenderId, updated);
    return updated;
  }

  async transitionContract(organizationId: string, tenderId: string, input: ContractTransitionInput): Promise<ContractRecord> {
    const contract = this.requireContract(organizationId, tenderId);
    const fromStatus = contract.status;
    if (!isContractStatus(input.toStatus)) {
      throw new Error(`Estado de contrato desconocido: "${input.toStatus}".`);
    }
    const toStatus = input.toStatus as ContractStatus;
    const check = checkTransition(fromStatus, toStatus);
    if (!check.valid) {
      throw new ContractTransitionRejectedError(fromStatus, toStatus, check.allowedNextStates);
    }
    const now = new Date().toISOString();
    const updated: ContractRecord = { ...contract, status: toStatus, updatedAt: now };
    this.contracts.set(tenderId, updated);
    const historyEntry: ContractStatusHistoryRecord = {
      id: randomUUID(),
      contractId: contract.id,
      fromStatus,
      toStatus,
      reason: input.reason,
      actorId: input.actorId,
      evidenceRef: input.evidenceRef,
      createdAt: now,
    };
    const list = this.contractStatusHistory.get(contract.id) ?? [];
    this.contractStatusHistory.set(contract.id, [...list, historyEntry]);
    return updated;
  }

  async listContractStatusHistory(organizationId: string, tenderId: string): Promise<readonly ContractStatusHistoryRecord[]> {
    const contract = this.requireContract(organizationId, tenderId);
    return this.contractStatusHistory.get(contract.id) ?? [];
  }

  async addContractDocument(
    organizationId: string,
    tenderId: string,
    input: AddContractDocumentInput,
  ): Promise<{ document: ContractDocumentRecord; fields: readonly ContractExtractedFieldRecord[] }> {
    const contract = this.requireContract(organizationId, tenderId);
    const documentId = randomUUID();
    const document: ContractDocumentRecord = {
      id: documentId,
      contractId: contract.id,
      documentLabel: input.documentLabel,
      pageCount: input.pages.length,
      uploadedBy: input.actorId,
      createdAt: new Date().toISOString(),
    };
    const docs = this.contractDocuments.get(contract.id) ?? [];
    this.contractDocuments.set(contract.id, [...docs, document]);

    const extracted = extractContractFields(input.pages);
    const now = new Date().toISOString();
    const fields: ContractExtractedFieldRecord[] = extracted.map((f) => ({
      id: randomUUID(),
      contractDocumentId: documentId,
      fieldKey: f.fieldKey,
      extractedValue: f.value,
      sourcePage: f.sourcePage,
      sourceClause: f.sourceClause,
      confidence: f.confidence,
      status: "sugerido",
      confirmedValue: null,
      confirmedBy: null,
      confirmedAt: null,
      createdAt: now,
    }));
    this.contractExtractedFields.set(documentId, fields);
    return { document, fields };
  }

  async listContractDocuments(organizationId: string, tenderId: string): Promise<readonly ContractDocumentRecord[]> {
    const contract = this.requireContract(organizationId, tenderId);
    return this.contractDocuments.get(contract.id) ?? [];
  }

  async listContractExtractedFields(organizationId: string, tenderId: string, documentId: string): Promise<readonly ContractExtractedFieldRecord[]> {
    const contract = this.requireContract(organizationId, tenderId);
    const docs = this.contractDocuments.get(contract.id) ?? [];
    if (!docs.some((d) => d.id === documentId)) {
      throw new Error(`Documento de contrato "${documentId}" no encontrado.`);
    }
    return this.contractExtractedFields.get(documentId) ?? [];
  }

  async confirmContractExtractedField(
    organizationId: string,
    tenderId: string,
    fieldId: string,
    input: ConfirmContractExtractedFieldInput,
  ): Promise<ContractExtractedFieldRecord> {
    const contract = this.requireContract(organizationId, tenderId);
    const docs = this.contractDocuments.get(contract.id) ?? [];
    const docIds = new Set(docs.map((d) => d.id));
    if (input.action === "correct" && (!input.correctedValue || input.correctedValue.trim().length === 0)) {
      throw new Error('correctedValue es obligatorio y no vacío cuando action="correct".');
    }
    for (const [documentId, fields] of this.contractExtractedFields) {
      if (!docIds.has(documentId)) continue;
      const idx = fields.findIndex((f) => f.id === fieldId);
      if (idx === -1) continue;
      const existing = fields[idx]!;
      const updated: ContractExtractedFieldRecord = {
        ...existing,
        status: input.action === "confirm" ? "confirmado" : "corregido",
        confirmedValue: input.action === "confirm" ? existing.extractedValue : input.correctedValue,
        confirmedBy: input.actorId,
        confirmedAt: new Date().toISOString(),
      };
      const newFields = [...fields];
      newFields[idx] = updated;
      this.contractExtractedFields.set(documentId, newFields);
      return updated;
    }
    throw new Error(`Campo extraído "${fieldId}" no encontrado para el contrato de la convocatoria "${tenderId}".`);
  }

  async createContractInvoice(organizationId: string, tenderId: string, input: CreateContractInvoiceInput): Promise<ContractInvoiceRecord> {
    const contract = this.requireContract(organizationId, tenderId);
    const due = computePaymentDueDateByRegime(input.invoiceVerifiedOn, input.convocatoriaPublicadaEn, input.calendario ?? officialOnlyCalendar());
    const record: ContractInvoiceRecord = {
      id: randomUUID(),
      contractId: contract.id,
      concepto: input.concepto,
      amount: input.amount,
      invoiceVerifiedOn: input.invoiceVerifiedOn,
      dueDate: due.dueDate,
      legalReference: due.legalReference,
      paidAt: null,
      status: "pendiente",
      createdBy: input.actorId,
      createdAt: new Date().toISOString(),
    };
    const list = this.contractInvoices.get(contract.id) ?? [];
    this.contractInvoices.set(contract.id, [...list, record]);
    return { ...record, status: classifyInvoiceStatus(record, this.todayForOrg(organizationId)) };
  }

  async listContractInvoices(organizationId: string, tenderId: string): Promise<readonly ContractInvoiceRecord[]> {
    const contract = this.requireContract(organizationId, tenderId);
    return this.invoicesWithStatus(contract.id, this.todayForOrg(organizationId));
  }

  async markContractInvoicePaid(organizationId: string, tenderId: string, invoiceId: string, _actorId: string): Promise<ContractInvoiceRecord> {
    const contract = this.requireContract(organizationId, tenderId);
    const list = this.contractInvoices.get(contract.id) ?? [];
    const idx = list.findIndex((i) => i.id === invoiceId);
    if (idx === -1) throw new Error(`Factura "${invoiceId}" no encontrada para el contrato de la convocatoria "${tenderId}".`);
    const updated: ContractInvoiceRecord = { ...list[idx]!, paidAt: new Date().toISOString(), status: "pagada" };
    const newList = [...list];
    newList[idx] = updated;
    this.contractInvoices.set(contract.id, newList);
    return updated;
  }

  async receivablesSummary(organizationId: string, tenderId: string): Promise<ReceivablesSummary> {
    const contract = this.requireContract(organizationId, tenderId);
    const today = this.todayForOrg(organizationId);
    const invoices = this.invoicesWithStatus(contract.id, today);
    const totals = summarizeReceivables(
      invoices.map((inv) => ({ amount: inv.amount, dueDate: inv.dueDate, paidAt: inv.paidAt })),
      today,
    );
    return { asOfDate: today, totalPending: totals.totalPending, totalOverdue: totals.totalOverdue, countPending: totals.countPending, countOverdue: totals.countOverdue, invoices };
  }

  async createInconformidadDraft(organizationId: string, tenderId: string, input: CreateInconformidadDraftInput): Promise<InconformidadDraftRecord> {
    this.requireTenderRecord(organizationId, tenderId);
    const key = `${organizationId}:${tenderId}`;
    const existingVersions = this.inconformidadDrafts.get(key) ?? [];
    const version = existingVersions.length + 1;
    const content = buildInconformidadContentByRegime({
      falloNotifiedOn: input.falloNotifiedOn,
      bajoTratados: input.bajoTratados,
      hechos: input.hechos,
      agravios: input.agravios,
      pruebas: input.pruebas,
      holidays: input.calendario ?? officialOnlyCalendar(),
      convocatoriaPublicadaEn: input.convocatoriaPublicadaEn,
    });
    const record: InconformidadDraftRecord = {
      id: randomUUID(),
      organizationId,
      tenderId,
      version,
      status: "borrador",
      contentHash: content.contentHash,
      hechos: input.hechos,
      agravios: input.agravios,
      pruebas: input.pruebas,
      fundamentos: content.fundamentos,
      falloNotifiedOn: input.falloNotifiedOn,
      bajoTratados: input.bajoTratados,
      businessDays: content.plazo.businessDays,
      dueDate: content.plazo.dueDate,
      legalReference: content.plazo.legalReference,
      viability: content.viability,
      viabilityRecommendation: content.viabilityRecommendation,
      disclaimer: INCONFORMIDAD_DISCLAIMER,
      reviewedBy: null,
      reviewedAt: null,
      createdBy: input.actorId,
      createdAt: new Date().toISOString(),
    };
    this.inconformidadDrafts.set(key, [...existingVersions, record]);
    return record;
  }

  async listInconformidadDrafts(organizationId: string, tenderId: string): Promise<readonly InconformidadDraftRecord[]> {
    return this.inconformidadDrafts.get(`${organizationId}:${tenderId}`) ?? [];
  }

  async markInconformidadReviewed(organizationId: string, tenderId: string, draftId: string, actorId: string): Promise<InconformidadDraftRecord> {
    const key = `${organizationId}:${tenderId}`;
    const list = this.inconformidadDrafts.get(key) ?? [];
    const idx = list.findIndex((d) => d.id === draftId);
    if (idx === -1) throw new Error(`Borrador de inconformidad "${draftId}" no encontrado.`);
    if (list[idx]!.status === "revisado") {
      throw new Error("Este borrador ya fue marcado como revisado.");
    }
    const updated: InconformidadDraftRecord = { ...list[idx]!, status: "revisado", reviewedBy: actorId, reviewedAt: new Date().toISOString() };
    const newList = [...list];
    newList[idx] = updated;
    this.inconformidadDrafts.set(key, newList);
    return updated;
  }

  async createFalloAutopsy(
    organizationId: string,
    tenderId: string,
    input: CreateFalloAutopsyInput,
  ): Promise<{ autopsy: FalloAutopsyRecord; lessons: readonly CompanyLessonLearnedRecord[] }> {
    this.requireTenderRecord(organizationId, tenderId);
    const key = `${organizationId}:${tenderId}`;
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: FalloAutopsyRecord = {
      id,
      organizationId,
      tenderId,
      ownProposalStatus: input.ownProposalStatus,
      disqualificationReason: normalizeOrNoDisponible(input.disqualificationReason),
      ownScore: input.ownScore,
      winnerScore: input.winnerScore,
      ownPrice: input.ownPrice,
      winnerPrice: input.winnerPrice,
      winnerName: normalizeOrNoDisponible(input.winnerName),
      criteriaComparison: input.criteriaComparison,
      createdBy: input.actorId,
      createdAt: now,
    };
    const list = this.falloAutopsies.get(key) ?? [];
    this.falloAutopsies.set(key, [...list, record]);

    const lessons: CompanyLessonLearnedRecord[] = input.lessons.map((lessonText) => ({
      id: randomUUID(),
      organizationId,
      falloAutopsyId: id,
      tenderId,
      lessonText,
      createdAt: now,
    }));
    const orgLessons = this.lessonsLearned.get(organizationId) ?? [];
    this.lessonsLearned.set(organizationId, [...orgLessons, ...lessons]);

    return { autopsy: record, lessons };
  }

  async listFalloAutopsies(organizationId: string, tenderId: string): Promise<readonly FalloAutopsyRecord[]> {
    return this.falloAutopsies.get(`${organizationId}:${tenderId}`) ?? [];
  }

  async listLessonsLearned(organizationId: string): Promise<readonly CompanyLessonLearnedRecord[]> {
    return [...(this.lessonsLearned.get(organizationId) ?? [])].reverse();
  }

  async scanRenewalAlerts(organizationId: string, input: ScanRenewalAlertsInput): Promise<ScanRenewalAlertsResult> {
    const thresholds = input.leadDaysThresholds ?? DEFAULT_RENEWAL_LEAD_DAYS;
    // Mismo fix de paridad que `invoicesWithStatus` de arriba -- `PostgresLicitacionesRepository`
    // (producción) ya resuelve la zona horaria REAL de la organización aquí (FASE 3,
    // ver `resolveOrganizationTimezoneForToday`), nunca el default de plataforma solo.
    const today = input.todayIsoDate ?? this.todayForOrg(organizationId);
    const candidates: RenewalCandidateContract[] = [...this.contracts.values()]
      .filter((c) => c.organizationId === organizationId && c.endDate !== null && c.status !== "cerrado" && c.status !== "rescindido")
      .map((c) => ({ contractId: c.id, tenderId: c.tenderId, endDate: c.endDate! }));

    const alertCandidates = computeRenewalAlertCandidates(candidates, today, thresholds);
    const existing = this.renewalAlerts.get(organizationId) ?? [];
    const existingKeySet = new Set(existing.map((a) => `${a.contractId}:${a.leadDays}`));

    const created: RenewalAlertRecord[] = [];
    for (const candidate of alertCandidates) {
      const dedupeKey = `${candidate.contractId}:${candidate.leadDays}`;
      if (existingKeySet.has(dedupeKey)) continue;
      const record: RenewalAlertRecord = {
        id: randomUUID(),
        organizationId,
        contractId: candidate.contractId,
        tenderId: candidate.tenderId,
        predictedDate: candidate.predictedDate,
        leadDays: candidate.leadDays,
        confidence: candidate.confidence,
        status: "pendiente",
        acknowledgedAt: null,
        acknowledgedBy: null,
        createdAt: new Date().toISOString(),
      };
      created.push(record);
      existingKeySet.add(dedupeKey);
    }
    this.renewalAlerts.set(organizationId, [...existing, ...created]);

    return { evaluatedContracts: candidates.length, alertsCreated: created.length, alerts: created };
  }

  /** El repositorio en memoria no modela RLS/sesión de sistema -- misma lógica
   * exacta que `scanRenewalAlerts` (ver `PostgresLicitacionesRepository.
   * systemScanRenewalAlerts` para el porqué de este método aparte contra
   * Postgres real). */
  async systemScanRenewalAlerts(organizationId: string, input: ScanRenewalAlertsInput): Promise<ScanRenewalAlertsResult> {
    return this.scanRenewalAlerts(organizationId, input);
  }

  async listRenewalAlerts(organizationId: string): Promise<readonly RenewalAlertRecord[]> {
    return [...(this.renewalAlerts.get(organizationId) ?? [])].reverse();
  }

  async acknowledgeRenewalAlert(organizationId: string, alertId: string, actorId: string): Promise<RenewalAlertRecord> {
    const list = this.renewalAlerts.get(organizationId) ?? [];
    const idx = list.findIndex((a) => a.id === alertId);
    if (idx === -1) throw new Error(`Alerta de renovación "${alertId}" no encontrada.`);
    const updated: RenewalAlertRecord = { ...list[idx]!, status: "reconocida", acknowledgedAt: new Date().toISOString(), acknowledgedBy: actorId };
    const newList = [...list];
    newList[idx] = updated;
    this.renewalAlerts.set(organizationId, newList);
    return updated;
  }

  // ==========================================================================
  // Fase 10 -- despacho proactivo real (correo) de deadline reminders/renewal
  // alerts/facturas vencidas.
  // ==========================================================================

  async listOrganizationNotificationRecipients(organizationId: string): Promise<readonly OrganizationNotificationRecipient[]> {
    return [...(this.notificationRecipients.get(organizationId) ?? [])];
  }

  async listOverdueContractInvoices(organizationId: string, todayIsoDate?: string): Promise<readonly OverdueContractInvoiceAlert[]> {
    // Mismo fix de paridad que `invoicesWithStatus`/`scanRenewalAlerts` de arriba.
    const today = todayIsoDate ?? this.todayForOrg(organizationId);
    const [todayY, todayM, todayD] = today.split("-").map(Number) as [number, number, number];
    const todayMs = Date.UTC(todayY, todayM - 1, todayD);
    const result: OverdueContractInvoiceAlert[] = [];
    for (const contract of this.contracts.values()) {
      if (contract.organizationId !== organizationId) continue;
      for (const invoice of this.invoicesWithStatus(contract.id, today)) {
        if (invoice.status !== "vencida") continue;
        const [y, m, d] = invoice.dueDate.split("-").map(Number) as [number, number, number];
        const dueMs = Date.UTC(y, m - 1, d);
        const daysOverdue = Math.round((todayMs - dueMs) / (24 * 60 * 60 * 1000));
        result.push({
          organizationId,
          invoiceId: invoice.id,
          contractId: contract.id,
          tenderId: contract.tenderId,
          concepto: invoice.concepto,
          amount: invoice.amount,
          dueDate: invoice.dueDate,
          daysOverdue,
        });
      }
    }
    return result.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  async enqueueMessagingOutbox(organizationId: string, channel: "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    if (channel !== "email") throw new Error("invalid outbox channel");
    const dedupeMapKey = `${organizationId}:${channel}:${dedupeKey}`;
    const existingId = this.messagingOutboxDedupe.get(dedupeMapKey);
    if (existingId) {
      const existing = this.messagingOutbox.get(existingId)!;
      // Mismo criterio que `enqueue_messaging_outbox` real (migración 018): un job ya
      // 'sent'/'processing'/'dead' NUNCA se pisa -- solo 'pending'/'failed' se actualizan.
      if (existing.status === "pending" || existing.status === "failed") {
        this.messagingOutbox.set(existingId, { ...existing, payload: payload as Record<string, unknown>, eventType });
      }
      return;
    }
    const id = randomUUID();
    this.messagingOutbox.set(id, {
      id,
      organizationId,
      channel,
      eventType,
      dedupeKey,
      payload: payload as Record<string, unknown>,
      status: "pending",
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
    });
    this.messagingOutboxDedupe.set(dedupeMapKey, id);
  }

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const claimable = [...this.messagingOutbox.values()]
      .filter((j) => j.channel === "email" && (j.status === "pending" || j.status === "failed") && j.attempts < 5)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(limit, 0));
    const claimed: EmailOutboxJobRow[] = [];
    for (const job of claimable) {
      const updated = { ...job, status: "processing" as const, attempts: job.attempts + 1 };
      this.messagingOutbox.set(job.id, updated);
      claimed.push({ id: updated.id, organizationId: updated.organizationId, attempts: updated.attempts, payload: updated.payload });
    }
    return claimed;
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    if (!["sent", "failed", "dead"].includes(status)) throw new Error(`invalid email outbox completion status: ${status}`);
    const job = this.messagingOutbox.get(id);
    if (!job || job.channel !== "email") return;
    this.messagingOutbox.set(id, { ...job, status, lastError: error ? error.slice(0, 500) : null });
  }

  // Ver el comentario de cabecera de `runWithRowSavepoint` en `repository.ts`. `fn`
  // corre directo y su error (si lo hay) se repropaga tal cual -- mismo
  // comportamiento observable que tendría un SAVEPOINT+ROLLBACK TO SAVEPOINT real
  // desde el punto de vista del caller, sin transacción real que aislar en memoria.
  async runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  private assertProposalOwnership(organizationId: string, proposalId: string): ProposalRecord {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.organizationId !== organizationId) {
      throw new Error(`Proposal "${proposalId}" no encontrada para la organización "${organizationId}".`);
    }
    return proposal;
  }
}
