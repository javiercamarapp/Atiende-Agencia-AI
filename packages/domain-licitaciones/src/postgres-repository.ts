// PostgresLicitacionesRepository — adaptador de producción de
// `LicitacionesRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que consume
// `core-auth/src/middleware.ts`). Ejecuta las queries reales contra el
// esquema `licitaciones` de migrations/001-003 (RLS real vía
// `licitaciones.can_access_org`/`can_write_org`/`can_decide_org`).
import { createHash } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { IdempotencyConflictError } from "./errors.ts";
import type { GoNoGoDecisionCreateInput, IdempotencyParams, IdempotentResult, LicitacionesRepository, MatchingProfileUpsertInput, RecordTenderVersionResult, TenderChangeNotificationRecord, TenderUpsertInput, TenderUpsertResult } from "./repository.ts";
import { readPackageZip, storeFile, writePackageZip } from "./storage.ts";
import { requireValidHashedInputs, sealInputs } from "./sealed-inputs.ts";
import type { ExpedienteInputs, HashedInputs } from "./sealed-inputs.ts";
import { sha256Hex } from "./types.ts";
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
  TenderStatus,
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

export class PostgresLicitacionesRepository implements LicitacionesRepository {
  constructor(
    private readonly db: TenantDbSession,
    private readonly storageDir: string,
  ) {}

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
    const { rows } = await this.db.query<{ id: string; created_at: string }>(
      `insert into licitaciones.source_run (organization_id, source, state, started_at, finished_at, http_status, response_hash, message, coverage_expected, coverage_obtained, correlation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, created_at::text as created_at;`,
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
    return { ...input, id: rows[0]!.id, organizationId, createdAt: rows[0]!.created_at };
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
    return rows.map((r) => ({ id: r.id, concept: r.concept, unitPrice: r.unit_price, currency: "MXN" as const, approvalStatus: r.approval_status, validFrom: r.valid_from, validUntil: r.valid_until }));
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
