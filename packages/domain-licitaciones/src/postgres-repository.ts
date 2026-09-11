// PostgresLicitacionesRepository — adaptador de producción de
// `LicitacionesRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que consume
// `core-auth/src/middleware.ts`). Ejecuta las queries reales contra el
// esquema `licitaciones` de migrations/001-003 (RLS real vía
// `licitaciones.can_access_org`/`can_write_org`/`can_decide_org`).
import { createHash } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
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

// Ventana de protección contra reintento de un Idempotency-Key — mismo
// criterio que domain-hoteles/domain-restaurantes.
const IDEMPOTENCY_KEY_TTL_DAYS = 7;

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

interface TenderRow {
  id: string;
  organization_id: string;
  title: string;
  submission_deadline: string | null;
  updated_at: string;
}

function mapTender(row: TenderRow): TenderRecord {
  return { id: row.id, organizationId: row.organization_id, title: row.title, submissionDeadline: row.submission_deadline, updatedAt: row.updated_at };
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

export class PostgresLicitacionesRepository implements LicitacionesRepository {
  constructor(
    private readonly db: TenantDbSession,
    private readonly storageDir: string,
  ) {}

  async findTender(organizationId: string, tenderId: string): Promise<TenderRecord | null> {
    const { rows } = await this.db.query<TenderRow>(
      `select id, organization_id, title, submission_deadline::text as submission_deadline, updated_at::text as updated_at
       from licitaciones.tender where id = $1 and organization_id = $2;`,
      [tenderId, organizationId],
    );
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
    return rows.map((r) => ({ id: r.id, type: r.document_type, label: r.label, expiresAt: r.expires_at, approvalStatus: r.approval_status }));
  }

  async listApprovedRates(organizationId: string, asOfIso: string): Promise<readonly ApprovedRateRecord[]> {
    const { rows } = await this.db.query<{ id: string; concept: string; unit_price: string; approval_status: ApprovedRateRecord["approvalStatus"]; valid_from: string; valid_until: string | null }>(
      `select id, concept, unit_price, approval_status, valid_from::text as valid_from, valid_until::text as valid_until
       from licitaciones.approved_rate
       where organization_id = $1 and approval_status = 'aprobado' and valid_from <= $2::timestamptz and (valid_until is null or valid_until >= $2::timestamptz);`,
      [organizationId, asOfIso],
    );
    return rows.map((r) => ({ id: r.id, concept: r.concept, unitPrice: r.unit_price, currency: "MXN" as const, approvalStatus: r.approval_status, validFrom: r.valid_from, validUntil: r.valid_until }));
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

    if (input.cartaSection) await this.upsertSection(organizationId, proposalId, "economic:carta", "Carta de proposición económica", input.cartaSection.content);
    if (input.anexoSection) await this.upsertSection(organizationId, proposalId, "economic:anexo", "Anexo económico", input.anexoSection.content);

    return updated;
  }

  private async upsertSection(organizationId: string, proposalId: string, sectionKey: string, label: string, content: string): Promise<void> {
    await this.db.query(
      `insert into licitaciones.proposal_section (organization_id, proposal_id, section_key, label, filename, content, version)
       values ($1, $2, $3, $4, $5, $6, 1)
       on conflict (proposal_id, section_key) do update
         set content = excluded.content, label = excluded.label, version = licitaciones.proposal_section.version + 1, updated_at = now();`,
      [organizationId, proposalId, sectionKey, label, `${sectionKey}.txt`, content],
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

  async findCurrentExpedienteApproval(organizationId: string, proposalId: string): Promise<ExpedienteApprovalRecord | null> {
    const { rows } = await this.db.query<{
      id: string;
      organization_id: string;
      proposal_id: string;
      status: "vigente" | "invalidada";
      approver_id: string;
      approver_role: string;
      inputs_hash: string;
      decided_at: string;
    }>(
      `select id, organization_id, proposal_id, status, approver_id, approver_role, inputs_hash, decided_at::text as decided_at
       from licitaciones.expediente_approval where organization_id = $1 and proposal_id = $2 and status = 'vigente' limit 1;`,
      [organizationId, proposalId],
    );
    const row = rows[0];
    return row
      ? { id: row.id, organizationId: row.organization_id, proposalId: row.proposal_id, scope: "expediente", status: row.status, approverId: row.approver_id, approverRole: row.approver_role, inputsHash: row.inputs_hash, decidedAt: row.decided_at }
      : null;
  }

  async approveExpediente(organizationId: string, proposalId: string, approverId: string, approverRole: string, inputsHash: string): Promise<ExpedienteApprovalRecord> {
    await this.db.query(
      `update licitaciones.expediente_approval
       set status = 'invalidada', invalidated_at = now(), invalidated_reason = 'superseded_by_new_approval'
       where organization_id = $1 and proposal_id = $2 and status = 'vigente';`,
      [organizationId, proposalId],
    );
    const { rows } = await this.db.query<{ id: string; decided_at: string }>(
      `insert into licitaciones.expediente_approval (organization_id, proposal_id, approver_id, approver_role, inputs_hash)
       values ($1, $2, $3, $4, $5)
       returning id, decided_at::text as decided_at;`,
      [organizationId, proposalId, approverId, approverRole, inputsHash],
    );
    return {
      id: rows[0]!.id,
      organizationId,
      proposalId,
      scope: "expediente",
      status: "vigente",
      approverId,
      approverRole,
      inputsHash,
      decidedAt: rows[0]!.decided_at,
    };
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
}
