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
import type { IdempotencyParams, IdempotentResult, LicitacionesRepository } from "./repository.ts";
import { readPackageZip, storeFile, writePackageZip } from "./storage.ts";
import { sealInputs } from "./sealed-inputs.ts";
import type { ExpedienteInputs } from "./sealed-inputs.ts";
import { sha256Hex } from "./types.ts";
import type {
  ApprovedRateRecord,
  CompanyDocumentRecord,
  ComplianceItemRecord,
  ExpedienteApprovalRecord,
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
  private readonly proposalSections = new Map<string, Map<string, StoredProposalSection>>(); // proposalId -> sectionKey -> section
  private readonly expedienteApprovals = new Map<string, ExpedienteApprovalRecord[]>(); // proposalId -> approvals (historial)
  private readonly packageManifests = new Map<string, PackageManifestRecord[]>(); // proposalId -> manifests (historial)
  private readonly submissions = new Map<string, SubmissionRecord[]>(); // proposalId -> submissions (historial)
  private readonly idempotency = new Map<string, StoredIdempotencyRow>();
  private readonly mutex = new KeyedMutex();

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

    if (input.cartaSection) this.upsertSection(proposalId, "economic:carta", "Carta de proposición económica", input.cartaSection.content);
    if (input.anexoSection) this.upsertSection(proposalId, "economic:anexo", "Anexo económico", input.anexoSection.content);

    return updated;
  }

  private upsertSection(proposalId: string, sectionKey: string, label: string, content: string): void {
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

  async findCurrentExpedienteApproval(organizationId: string, proposalId: string): Promise<ExpedienteApprovalRecord | null> {
    this.assertProposalOwnership(organizationId, proposalId);
    const list = this.expedienteApprovals.get(proposalId) ?? [];
    return list.find((a) => a.status === "vigente") ?? null;
  }

  async approveExpediente(organizationId: string, proposalId: string, approverId: string, approverRole: string, inputsHash: string): Promise<ExpedienteApprovalRecord> {
    this.assertProposalOwnership(organizationId, proposalId);
    const nowIso = new Date().toISOString();
    const existing = this.expedienteApprovals.get(proposalId) ?? [];
    const invalidated = existing.map((a) =>
      a.status === "vigente" ? { ...a, status: "invalidada" as const, invalidatedAt: nowIso, invalidatedReason: "superseded_by_new_approval" } : a,
    );
    const created: ExpedienteApprovalRecord = {
      id: randomUUID(),
      organizationId,
      proposalId,
      scope: "expediente",
      status: "vigente",
      approverId,
      approverRole,
      inputsHash,
      decidedAt: nowIso,
    };
    this.expedienteApprovals.set(proposalId, [...invalidated, created]);
    return created;
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
