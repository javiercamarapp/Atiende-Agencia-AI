// InMemoryLicitacionesRepository — implementación real (no un mock) de
// `LicitacionesRepository`, para tests determinísticos (mismo rol que
// InMemoryHotelesRepository/InMemoryRestaurantesRepository). Los bytes del
// ZIP del expediente SÍ se escriben a disco real (bajo un directorio temporal
// por defecto) — igual que el origen, que nunca modeló el ZIP como un blob de
// base de datos (ver storage.ts).
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdempotencyConflictError } from "./errors.ts";
import type { GoNoGoDecisionCreateInput, IdempotencyParams, IdempotentResult, LicitacionesRepository, MatchingProfileUpsertInput, TenderUpsertInput, TenderUpsertResult } from "./repository.ts";
import { readPackageZip, storeFile, writePackageZip } from "./storage.ts";
import { requireValidHashedInputs, sealInputs } from "./sealed-inputs.ts";
import type { ExpedienteInputs, HashedInputs } from "./sealed-inputs.ts";
import { sha256Hex } from "./types.ts";
import { ApprovalWorkflow } from "./approval-workflow.ts";
import type { Approval, ApprovalScope, ChangeDetected } from "./approval-workflow.ts";
import { ProposalVersionRegistry, buildProposalInputRecords } from "./proposal-version-registry.ts";
import type { PersistedProposalVersion } from "./proposal-version-registry.ts";
import type { LicitacionesRole } from "./roles.ts";
import type { RequirementFulfillmentMappingRecord, RequirementItemRecord } from "./repository.ts";
import { buildGoNoGoDecision } from "./go-no-go.ts";
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
  // ---- Fase 3: matching/scoring y go/no-go ----
  private readonly tenderByExternalKey = new Map<string, string>(); // `${orgId}:manual:${externalId}` -> tenderId (mismo alcance que tender_org_source_external_idx)
  private readonly tenderAuditLog = new Map<string, { action: string; actorId: string; createdAt: string }[]>(); // tenderId -> entradas (historial)
  private readonly matchingProfiles = new Map<string, MatchingProfileRecord>(); // orgId -> perfil (singleton)
  private readonly goNoGoDecisions = new Map<string, GoNoGoDecisionRecord[]>(); // tenderId -> decisiones (historial, más reciente al final)

  constructor(options: { storageDir?: string } = {}) {
    this.storageDir = options.storageDir ?? mkdtempSync(join(tmpdir(), "licitaciones-test-"));
  }

  // ---- seeding (equivalente a INSERT manual contra las migraciones SQL) ----

  seedTender(tender: TenderRecord): void {
    this.tenders.set(tender.id, tender);
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
      this.recordTenderAudit(existing.id, "tender.manual_upsert.updated", input.actorId);
      return { tender: updated, created: false, submissionDeadlineChanged: previousDeadline !== input.submissionDeadline };
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
    this.recordTenderAudit(created.id, "tender.manual_upsert.created", input.actorId);
    return { tender: created, created: true, submissionDeadlineChanged: false };
  }

  private recordTenderAudit(tenderId: string, action: string, actorId: string): void {
    const list = this.tenderAuditLog.get(tenderId) ?? [];
    list.push({ action, actorId, createdAt: new Date().toISOString() });
    this.tenderAuditLog.set(tenderId, list);
  }

  /** Solo pruebas/inspección -- no forma parte de `LicitacionesRepository` (ningún endpoint de Fase 3 la expone, ver diseño §6/§9). */
  listTenderAuditLogForTests(tenderId: string): readonly { action: string; actorId: string; createdAt: string }[] {
    return this.tenderAuditLog.get(tenderId) ?? [];
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
      // Fase 1 §3.3: sin `company_profiles` portado, hash trivial fijo (no
      // inventa datos: simplemente no distingue perfiles de empresa entre sí
      // todavía — limitación conocida y documentada, no un dato fabricado).
      companyProfileHash: sha256Hex("licitaciones:fase1:company-profile-fijo"),
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

  async approve(organizationId: string, proposalId: string, input: { scope: ApprovalScope; scopeRef: string; actorId: string; actorRole: LicitacionesRole; inputsHash: HashedInputs }): Promise<Approval> {
    this.assertProposalOwnership(organizationId, proposalId);
    const sectionAuthors = this.sectionAuthors.get(proposalId) ?? new Map<string, Set<string>>();

    // Lanza `ApprovalRejectedError` si la regla rechaza -- ninguna fila se toca en ese caso.
    new ApprovalWorkflow({ sectionAuthors }).approve({ scope: input.scope, scopeRef: input.scopeRef, actorId: input.actorId, actorRole: input.actorRole, inputsHash: input.inputsHash });

    const nowIso = new Date().toISOString();
    const existing = this.approvals.get(proposalId) ?? [];
    // Invalida cualquier aprobación previa 'vigente' de EXACTAMENTE el mismo
    // scope/scopeRef (nunca coexisten dos vigentes del mismo alcance exacto).
    const invalidated = existing.map((a) =>
      a.status === "vigente" && a.scopeRef === input.scopeRef ? { ...a, status: "invalidada" as const, invalidatedAt: nowIso, invalidatedReason: "superseded_by_new_approval" } : a,
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
        return existing.response as IdempotentResult<T>;
      }
      this.idempotency.set(key, { requestHash, response: null });
      const result = await run();
      this.idempotency.set(key, { requestHash, response: result });
      return result;
    });
  }

  private assertProposalOwnership(organizationId: string, proposalId: string): ProposalRecord {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.organizationId !== organizationId) {
      throw new Error(`Proposal "${proposalId}" no encontrada para la organización "${organizationId}".`);
    }
    return proposal;
  }
}
