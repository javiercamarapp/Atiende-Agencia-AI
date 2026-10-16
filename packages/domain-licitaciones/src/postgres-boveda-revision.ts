// paridad3 (L-P3-05/06/07): implementacion Postgres de la boveda de documentos, la matriz estable, los conflictos
// persistidos y los comentarios de revision (migracion 037). Funciones sueltas sobre la sesion del request para no
// inflar `postgres-repository.ts`; `PostgresLicitacionesRepository` delega aqui.
//
// Compatibilidad con la base SIN la 037: la sesion del request es UNA transaccion, asi que todo camino que pueda tocar
// una columna/tabla nueva corre dentro de `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT). Las lecturas
// caen a un vacio honesto con `disponible: false`; las escrituras que no pueden fingirse lanzan
// `BovedaRevisionNoDisponibleError` (la ruta lo traduce a 503), nunca un 500.
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { BovedaRevisionNoDisponibleError, RequirementAssigneeNotFoundError } from "./errors.ts";
import { conflictStableKey, requirementStableKey, sha256OfBytes } from "./document-vault.ts";
import type { DocumentExtractionStatus, TenderDocumentRecord, TenderDocumentType, TenderDocumentWithPages } from "./document-vault.ts";
import type {
  DetectedRequirementConflict,
  ProposalCommentKind,
  ProposalCommentRecord,
  ProposalCommentScope,
  RequirementConflictRecord,
  RequirementItemDetail,
  RequirementItemPatch,
  RequirementItemRecord,
  RequirementUpsertItem,
  RequirementUpsertResult,
  TenderAuditAction,
  TenderDocumentUploadInput,
} from "./repository.ts";

function isCheckViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "23514");
}

// ---------------------------------------------------------------------------------------------------------------
// Bitacora
// ---------------------------------------------------------------------------------------------------------------
export async function recordTenderAuditEvent(db: TenantDbSession, organizationId: string, tenderId: string, action: TenderAuditAction, actorId: string): Promise<void> {
  await runWithSavepointFallback<void>({
    session: db,
    primary: async () => {
      await db.query(`insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id) values ($1, $2, $3, $4);`, [organizationId, tenderId, action, actorId]);
    },
    // Base sin la 037: el CHECK de acciones (010) rechaza la accion nueva con 23514; la bitacora es de mejor esfuerzo.
    isRecoverable: (err) => isCheckViolation(err) || isMigrationPendingError(err),
    fallback: async () => undefined,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Boveda de documentos
// ---------------------------------------------------------------------------------------------------------------
const DOC_COLUMNS = `id, tender_id, document_type, title, filename, mime_type, sha256, size_bytes, page_count, extraction_status, extraction_detail, lineage_id, version,
  (version = max(version) over (partition by lineage_id)) as latest, uploaded_by, created_at::text as created_at`;

interface DocRow {
  id: string;
  tender_id: string;
  document_type: string;
  title: string | null;
  filename: string | null;
  mime_type: string | null;
  sha256: string | null;
  size_bytes: number | null;
  page_count: number | null;
  extraction_status: DocumentExtractionStatus | null;
  extraction_detail: string | null;
  lineage_id: string;
  version: number;
  latest: boolean;
  uploaded_by: string | null;
  created_at: string;
}

function mapDoc(r: DocRow): TenderDocumentRecord {
  return {
    id: r.id,
    tenderId: r.tender_id,
    documentType: (r.document_type as TenderDocumentType) ?? "other",
    title: r.title,
    filename: r.filename,
    mimeType: r.mime_type,
    sha256: r.sha256,
    sizeBytes: r.size_bytes,
    pageCount: r.page_count,
    extractionStatus: r.extraction_status,
    extractionDetail: r.extraction_detail,
    lineageId: r.lineage_id,
    version: r.version,
    latest: r.latest,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
  };
}

export async function createTenderDocument(db: TenantDbSession, organizationId: string, tenderId: string, input: TenderDocumentUploadInput): Promise<TenderDocumentRecord> {
  return runWithSavepointFallback<TenderDocumentRecord>({
    session: db,
    primary: async () => {
      let lineageId: string = randomUUID();
      let version = 1;
      if (input.replacesDocumentId) {
        const { rows } = await db.query<{ lineage_id: string; max_version: number }>(
          `select d.lineage_id, (select max(x.version) from licitaciones.tender_document x where x.lineage_id = d.lineage_id) as max_version
           from licitaciones.tender_document d where d.id = $1 and d.organization_id = $2 and d.tender_id = $3;`,
          [input.replacesDocumentId, organizationId, tenderId],
        );
        if (!rows[0]) throw new Error("El documento que se reemplaza no existe en esta convocatoria.");
        lineageId = rows[0].lineage_id;
        version = rows[0].max_version + 1;
      }
      const sha = sha256OfBytes(input.buffer);
      const { rows: blob } = await db.query<{ id: string }>(
        `insert into licitaciones.file_blob (organization_id, sha256, size_bytes, content) values ($1, $2, $3, $4) returning id;`,
        [organizationId, sha, input.buffer.byteLength, Buffer.from(input.buffer)],
      );
      const blobId = blob[0]!.id;
      const { rows } = await db.query<DocRow>(
        `insert into licitaciones.tender_document
           (organization_id, tender_id, document_type, storage_ref, title, filename, mime_type, file_blob_id, sha256, size_bytes, page_count,
            extraction_status, extraction_detail, extracted_pages, lineage_id, version, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17)
         returning ${DOC_COLUMNS};`,
        [
          organizationId,
          tenderId,
          input.documentType,
          blobId,
          input.title,
          input.filename,
          input.mimeType,
          blobId,
          sha,
          input.buffer.byteLength,
          input.pageCount,
          input.extractionStatus,
          input.extractionDetail,
          input.pages ? JSON.stringify(input.pages) : null,
          lineageId,
          version,
          input.actorId,
        ],
      );
      return mapDoc(rows[0]!);
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => {
      throw new BovedaRevisionNoDisponibleError("documentos");
    },
  });
}

export async function listTenderDocuments(db: TenantDbSession, organizationId: string, tenderId: string): Promise<{ disponible: boolean; documents: readonly TenderDocumentRecord[] }> {
  return runWithSavepointFallback<{ disponible: boolean; documents: readonly TenderDocumentRecord[] }>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<DocRow>(`select ${DOC_COLUMNS} from licitaciones.tender_document where organization_id = $1 and tender_id = $2 order by created_at desc, version desc;`, [organizationId, tenderId]);
      return { disponible: true, documents: rows.map(mapDoc) };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, documents: [] }),
  });
}

export async function getTenderDocument(db: TenantDbSession, organizationId: string, tenderId: string, documentId: string): Promise<TenderDocumentWithPages | null> {
  return runWithSavepointFallback<TenderDocumentWithPages | null>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<DocRow & { extracted_pages: { page: number; text: string }[] | null }>(
        `select ${DOC_COLUMNS}, extracted_pages from licitaciones.tender_document where organization_id = $1 and tender_id = $2 and id = $3;`,
        [organizationId, tenderId, documentId],
      );
      const r = rows[0];
      return r ? { ...mapDoc(r), pages: r.extracted_pages } : null;
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => null,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Matriz estable
// ---------------------------------------------------------------------------------------------------------------
interface MatrixRow {
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
  stable_key: string | null;
  assigned_to: string | null;
  disqualifying: boolean;
  manually_edited_at: string | null;
  retired_at: string | null;
  retired_in_version: number | null;
  lineage_id: string | null;
}

const MATRIX_SELECT = `r.id, r.document_id, r.description, r.requirement_kind, r.obligatoriedad, r.topic_key, r.required_evidence, r.extracted_by, r.page, r.clause,
  r.responsible_role, r.deadline::text as deadline, r.status, r.confidence::text as confidence, r.stable_key, r.assigned_to, r.disqualifying,
  r.manually_edited_at::text as manually_edited_at, r.invalidated_at::text as retired_at, r.retired_in_version, d.lineage_id`;

function mapMatrix(r: MatrixRow): RequirementItemDetail {
  return {
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
    stableKey: r.stable_key,
    assignedTo: r.assigned_to,
    disqualifying: r.disqualifying,
    manuallyEditedAt: r.manually_edited_at,
    retiredAt: r.retired_at,
    retiredInVersion: r.retired_in_version,
  };
}

function neutral(i: RequirementItemRecord): RequirementItemDetail {
  return { ...i, stableKey: null, assignedTo: null, disqualifying: false, manuallyEditedAt: null, retiredAt: null, retiredInVersion: null };
}

async function selectMatrix(db: TenantDbSession, organizationId: string, tenderId: string, includeRetired: boolean): Promise<RequirementItemDetail[]> {
  const { rows } = await db.query<MatrixRow>(
    `select ${MATRIX_SELECT}
     from licitaciones.requirement_item r left join licitaciones.tender_document d on d.id = r.document_id
     where r.organization_id = $1 and r.tender_id = $2 ${includeRetired ? "" : "and r.invalidated_at is null"}
     order by r.created_at asc, r.id asc;`,
    [organizationId, tenderId],
  );
  return rows.map(mapMatrix);
}

export async function listRequirementMatrix(
  db: TenantDbSession,
  organizationId: string,
  tenderId: string,
  includeRetired: boolean,
  legacyList: () => Promise<readonly RequirementItemRecord[]>,
): Promise<{ migrated: boolean; items: readonly RequirementItemDetail[] }> {
  return runWithSavepointFallback<{ migrated: boolean; items: readonly RequirementItemDetail[] }>({
    session: db,
    primary: async () => ({ migrated: true, items: await selectMatrix(db, organizationId, tenderId, includeRetired) }),
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ migrated: false, items: (await legacyList()).map(neutral) }),
  });
}

export async function upsertRequirementItems(
  db: TenantDbSession,
  organizationId: string,
  tenderId: string,
  items: readonly RequirementUpsertItem[],
  opts: { actorId: string; scope: { lineageIds: readonly string[]; includeUnlinked: boolean }; retiredInVersion: number | null },
  legacyReplace: (records: readonly RequirementItemRecord[]) => Promise<void>,
  legacyList: () => Promise<readonly RequirementItemRecord[]>,
): Promise<RequirementUpsertResult> {
  return runWithSavepointFallback<RequirementUpsertResult>({
    session: db,
    primary: async () => {
      const active = await selectMatrix(db, organizationId, tenderId, false);
      const lineageByItem = new Map<string, string | null>();
      {
        const { rows } = await db.query<{ id: string; lineage_id: string | null }>(
          `select r.id, d.lineage_id from licitaciones.requirement_item r left join licitaciones.tender_document d on d.id = r.document_id where r.organization_id = $1 and r.tender_id = $2 and r.invalidated_at is null;`,
          [organizationId, tenderId],
        );
        for (const r of rows) lineageByItem.set(r.id, r.lineage_id);
      }
      const byKey = new Map<string, RequirementItemDetail>();
      for (const row of active) {
        const k = row.stableKey ?? requirementStableKey({ documentRef: lineageByItem.get(row.id) ?? "sin-documento", topicKey: row.topicKey, page: row.page, clause: row.clause, text: row.text });
        if (!byKey.has(k)) byKey.set(k, row);
      }
      const seen = new Set<string>();
      const occurrences = new Map<string, number>();
      const idByInputId: Record<string, string> = {};
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      for (const item of items) {
        const base = requirementStableKey({ documentRef: item.documentRef, topicKey: item.topicKey, page: item.page, clause: item.clause, text: item.text });
        const n = (occurrences.get(base) ?? 0) + 1;
        occurrences.set(base, n);
        const key = n === 1 ? base : `${base}#${n}`;
        const existing = byKey.get(key);
        if (existing) {
          seen.add(existing.id);
          idByInputId[item.id] = existing.id;
          const manual = existing.manuallyEditedAt !== null;
          const sameSemantic =
            existing.stableKey === key &&
            existing.documentId === (item.documentId ?? existing.documentId) &&
            existing.text === item.text &&
            existing.obligatoriedad === item.obligatoriedad &&
            existing.requirementKind === item.requirementKind &&
            existing.topicKey === item.topicKey &&
            JSON.stringify(existing.requiredEvidence) === JSON.stringify(item.requiredEvidence) &&
            existing.extractedBy === item.extractedBy &&
            existing.page === item.page &&
            existing.clause === item.clause &&
            existing.confidence === item.confidence &&
            (manual || (existing.responsibleRole === item.responsibleRole && existing.status === item.status));
          if (sameSemantic) {
            unchanged += 1;
            continue;
          }
          updated += 1;
          await db.query(
            `update licitaciones.requirement_item
             set stable_key = $3, document_id = coalesce($4, document_id), description = $5, requirement_kind = $6, obligatoriedad = $7, topic_key = $8,
                 required_evidence = $9::text[], extracted_by = $10, page = $11, clause = $12, deadline = $13, confidence = $14,
                 responsible_role = case when manually_edited_at is null then $15 else responsible_role end,
                 status = case when manually_edited_at is null then $16 else status end
             where organization_id = $1 and id = $2;`,
            [organizationId, existing.id, key, item.documentId, item.text, item.requirementKind, item.obligatoriedad, item.topicKey, item.requiredEvidence, item.extractedBy, item.page, item.clause, item.deadline, item.confidence, item.responsibleRole, item.status],
          );
        } else {
          const id = randomUUID();
          idByInputId[item.id] = id;
          seen.add(id);
          created += 1;
          await db.query(
            `insert into licitaciones.requirement_item
               (id, organization_id, tender_id, document_id, description, requirement_kind, obligatoriedad, topic_key, required_evidence, extracted_by, page, clause, responsible_role, deadline, status, confidence, stable_key)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15, $16, $17);`,
            [id, organizationId, tenderId, item.documentId, item.text, item.requirementKind, item.obligatoriedad, item.topicKey, item.requiredEvidence, item.extractedBy, item.page, item.clause, item.responsibleRole, item.deadline, item.status, item.confidence, key],
          );
        }
      }
      let retired = 0;
      const toRetire: string[] = [];
      for (const row of active) {
        if (seen.has(row.id)) continue;
        const lineage = lineageByItem.get(row.id) ?? null;
        const inScope = lineage === null ? opts.scope.includeUnlinked : opts.scope.lineageIds.includes(lineage);
        if (inScope) toRetire.push(row.id);
      }
      if (toRetire.length > 0) {
        retired = toRetire.length;
        await db.query(`update licitaciones.requirement_item set invalidated_at = now(), retired_in_version = $3 where organization_id = $1 and id = any($2::uuid[]);`, [organizationId, toRetire, opts.retiredInVersion]);
      }
      return { mode: "estable", items: await selectMatrix(db, organizationId, tenderId, false), idByInputId, created, updated, unchanged, retired };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => {
      // Base sin la 037: camino anterior (reemplazo completo), con ids uuid reales (el id "req-N" del extractor no es un uuid).
      const idByInputId: Record<string, string> = {};
      const records: RequirementItemRecord[] = items.map((i) => {
        const id = randomUUID();
        idByInputId[i.id] = id;
        const { documentRef: _ref, ...rest } = i;
        return { ...rest, id };
      });
      await legacyReplace(records);
      return { mode: "reemplazo", items: (await legacyList()).map(neutral), idByInputId, created: records.length, updated: 0, unchanged: 0, retired: 0 };
    },
  });
}

export async function listRequirementAssignees(db: TenantDbSession, organizationId: string): Promise<readonly { userId: string; nombre: string; rol: string }[]> {
  return runWithSavepointFallback({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ out_user_id: string; out_nombre: string; out_rol: string }>(`select * from licitaciones.post_award_list_responsables($1::uuid);`, [organizationId]);
      return rows.map((r) => ({ userId: r.out_user_id, nombre: r.out_nombre, rol: r.out_rol }));
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => [],
  });
}

export async function updateRequirementItem(
  db: TenantDbSession,
  organizationId: string,
  tenderId: string,
  itemId: string,
  patch: RequirementItemPatch,
  actorId: string,
  legacyUpdate: (sets: { responsibleRole?: string; status?: string }) => Promise<boolean>,
): Promise<RequirementItemDetail | null> {
  if (patch.assignedTo) {
    const assignees = await listRequirementAssignees(db, organizationId);
    if (!assignees.some((a) => a.userId === patch.assignedTo)) throw new RequirementAssigneeNotFoundError();
  }
  return runWithSavepointFallback<RequirementItemDetail | null>({
    session: db,
    primary: async () => {
      const sets: string[] = ["manually_edited_at = now()", "manually_edited_by = $4"];
      const params: unknown[] = [organizationId, tenderId, itemId, actorId];
      const push = (col: string, value: unknown, cast = ""): void => {
        params.push(value);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (patch.responsibleRole !== undefined) push("responsible_role", patch.responsibleRole);
      if (patch.status !== undefined) push("status", patch.status);
      if (patch.assignedTo !== undefined) push("assigned_to", patch.assignedTo, "::uuid");
      if (patch.disqualifying !== undefined) push("disqualifying", patch.disqualifying);
      const { rows } = await db.query<{ id: string }>(
        `update licitaciones.requirement_item set ${sets.join(", ")} where organization_id = $1 and tender_id = $2 and id = $3 and invalidated_at is null returning id;`,
        params,
      );
      if (!rows[0]) return null;
      const all = await selectMatrix(db, organizationId, tenderId, false);
      return all.find((i) => i.id === itemId) ?? null;
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => {
      // Base sin la 037: solo responsable y estado existen (006); asignado y causa de desechamiento exigen la migracion.
      if (patch.assignedTo !== undefined || patch.disqualifying !== undefined) throw new BovedaRevisionNoDisponibleError("matriz");
      const ok = await legacyUpdate({ responsibleRole: patch.responsibleRole, status: patch.status });
      if (!ok) return null;
      const { rows } = await db.query<MatrixRowLegacy>(
        `select id, document_id, description, requirement_kind, obligatoriedad, topic_key, required_evidence, extracted_by, page, clause, responsible_role, deadline::text as deadline, status, confidence::text as confidence
         from licitaciones.requirement_item where organization_id = $1 and tender_id = $2 and id = $3;`,
        [organizationId, tenderId, itemId],
      );
      const r = rows[0];
      if (!r) return null;
      return neutral({
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
      });
    },
  });
}

type MatrixRowLegacy = Pick<MatrixRow, "id" | "document_id" | "description" | "requirement_kind" | "obligatoriedad" | "topic_key" | "required_evidence" | "extracted_by" | "page" | "clause" | "responsible_role" | "deadline" | "status" | "confidence">;

// ---------------------------------------------------------------------------------------------------------------
// Conflictos persistidos
// ---------------------------------------------------------------------------------------------------------------
interface ConflictRow {
  id: string;
  tender_id: string;
  conflict_key: string;
  kind: RequirementConflictRecord["kind"];
  topic_key: string | null;
  description: string;
  item_ids: string[];
  status: RequirementConflictRecord["status"];
  resolution_notes: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}
const CONFLICT_COLUMNS = `id, tender_id, conflict_key, kind, topic_key, description, item_ids, status, resolution_notes, resolved_by, resolved_at::text as resolved_at, created_at::text as created_at`;

function mapConflict(r: ConflictRow): RequirementConflictRecord {
  return { id: r.id, tenderId: r.tender_id, kind: r.kind, topicKey: r.topic_key, description: r.description, itemIds: r.item_ids, status: r.status, resolutionNotes: r.resolution_notes, resolvedBy: r.resolved_by, resolvedAt: r.resolved_at, createdAt: r.created_at };
}

/** Bloquea los requisitos con plazo en un conflicto abierto y desbloquea los que ya no estan en ninguno (salvo edicion manual). */
async function reblockItems(db: TenantDbSession, organizationId: string, tenderId: string): Promise<void> {
  await db.query(
    `update licitaciones.requirement_item r set status = 'bloqueado'
     where r.organization_id = $1 and r.tender_id = $2 and r.invalidated_at is null and r.manually_edited_at is null and r.deadline is not null and r.status <> 'bloqueado'
       and exists (select 1 from licitaciones.requirement_conflict c where c.organization_id = r.organization_id and c.tender_id = r.tender_id and c.status = 'abierto' and r.id = any(c.item_ids));`,
    [organizationId, tenderId],
  );
  await db.query(
    `update licitaciones.requirement_item r set status = 'pendiente'
     where r.organization_id = $1 and r.tender_id = $2 and r.invalidated_at is null and r.manually_edited_at is null and r.status = 'bloqueado'
       and not exists (select 1 from licitaciones.requirement_conflict c where c.organization_id = r.organization_id and c.tender_id = r.tender_id and c.status = 'abierto' and r.id = any(c.item_ids));`,
    [organizationId, tenderId],
  );
}

export async function syncRequirementConflicts(db: TenantDbSession, organizationId: string, tenderId: string, detected: readonly DetectedRequirementConflict[]): Promise<{ disponible: boolean; conflicts: readonly RequirementConflictRecord[] }> {
  return runWithSavepointFallback<{ disponible: boolean; conflicts: readonly RequirementConflictRecord[] }>({
    session: db,
    primary: async () => {
      const keys: string[] = [];
      for (const d of detected) {
        const huella = conflictStableKey(d.kind, d.topicKey, d.stableKeys);
        keys.push(huella);
        // Un conflicto ya resuelto con la misma huella NO se reabre; uno abierto refresca descripcion y requisitos.
        await db.query(
          `insert into licitaciones.requirement_conflict (organization_id, tender_id, conflict_key, kind, topic_key, description, item_ids)
           values ($1, $2, $3, $4, $5, $6, $7::uuid[])
           on conflict (tender_id, conflict_key) do update
             set description = excluded.description, item_ids = excluded.item_ids, updated_at = now()
             where licitaciones.requirement_conflict.status = 'abierto';`,
          [organizationId, tenderId, huella, d.kind, d.topicKey, d.description, d.itemIds],
        );
      }
      // Cierre automatico de los abiertos que la ultima extraccion ya no detecta (sin resolved_by: lo cerro el sistema).
      await db.query(
        `update licitaciones.requirement_conflict
         set status = 'resuelto', resolved_at = now(), updated_at = now(),
             resolution_notes = 'Cierre automático: la última extracción ya no detecta este conflicto.'
         where organization_id = $1 and tender_id = $2 and status = 'abierto' and not (conflict_key = any($3::text[]));`,
        [organizationId, tenderId, keys],
      );
      await reblockItems(db, organizationId, tenderId);
      const { rows } = await db.query<ConflictRow>(`select ${CONFLICT_COLUMNS} from licitaciones.requirement_conflict where organization_id = $1 and tender_id = $2 order by created_at asc, id asc;`, [organizationId, tenderId]);
      return { disponible: true, conflicts: rows.map(mapConflict) };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, conflicts: [] }),
  });
}

export async function listRequirementConflicts(db: TenantDbSession, organizationId: string, tenderId: string): Promise<{ disponible: boolean; conflicts: readonly RequirementConflictRecord[] }> {
  return runWithSavepointFallback<{ disponible: boolean; conflicts: readonly RequirementConflictRecord[] }>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<ConflictRow>(`select ${CONFLICT_COLUMNS} from licitaciones.requirement_conflict where organization_id = $1 and tender_id = $2 order by created_at asc, id asc;`, [organizationId, tenderId]);
      return { disponible: true, conflicts: rows.map(mapConflict) };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, conflicts: [] }),
  });
}

export async function resolveRequirementConflict(db: TenantDbSession, organizationId: string, tenderId: string, conflictId: string, input: { actorId: string; notes: string }): Promise<RequirementConflictRecord | null> {
  return runWithSavepointFallback<RequirementConflictRecord | null>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<ConflictRow>(
        `update licitaciones.requirement_conflict
         set status = 'resuelto', resolution_notes = $4, resolved_by = $5, resolved_at = now(), updated_at = now()
         where organization_id = $1 and tender_id = $2 and id = $3 and status = 'abierto'
         returning ${CONFLICT_COLUMNS};`,
        [organizationId, tenderId, conflictId, input.notes, input.actorId],
      );
      if (!rows[0]) return null;
      await reblockItems(db, organizationId, tenderId);
      return mapConflict(rows[0]);
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => {
      throw new BovedaRevisionNoDisponibleError("conflictos");
    },
  });
}

export async function countOpenRequirementConflicts(db: TenantDbSession, organizationId: string, tenderId: string): Promise<number> {
  return runWithSavepointFallback({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from licitaciones.requirement_conflict where organization_id = $1 and tender_id = $2 and status = 'abierto';`, [organizationId, tenderId]);
      return Number(rows[0]?.n ?? 0);
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => 0,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Comentarios de revision
// ---------------------------------------------------------------------------------------------------------------
interface CommentRow {
  id: string;
  proposal_id: string;
  scope: ProposalCommentScope;
  scope_ref: string;
  kind: ProposalCommentKind;
  body: string;
  author_id: string;
  author_role: string;
  created_at: string;
}
const COMMENT_COLUMNS = `id, proposal_id, scope, scope_ref, kind, body, author_id, author_role, created_at::text as created_at`;
function mapComment(r: CommentRow): ProposalCommentRecord {
  return { id: r.id, proposalId: r.proposal_id, scope: r.scope, scopeRef: r.scope_ref, kind: r.kind, body: r.body, authorId: r.author_id, authorRole: r.author_role, createdAt: r.created_at };
}

export async function addProposalComment(
  db: TenantDbSession,
  organizationId: string,
  proposalId: string,
  input: { scope: ProposalCommentScope; scopeRef: string; kind: ProposalCommentKind; body: string; authorId: string; authorRole: string },
): Promise<ProposalCommentRecord> {
  return runWithSavepointFallback<ProposalCommentRecord>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<CommentRow>(
        `insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, kind, body, author_id, author_role)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COMMENT_COLUMNS};`,
        [organizationId, proposalId, input.scope, input.scopeRef, input.kind, input.body, input.authorId, input.authorRole],
      );
      return mapComment(rows[0]!);
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => {
      throw new BovedaRevisionNoDisponibleError("comentarios");
    },
  });
}

export async function listProposalComments(db: TenantDbSession, organizationId: string, proposalId: string): Promise<{ disponible: boolean; comments: readonly ProposalCommentRecord[] }> {
  return runWithSavepointFallback<{ disponible: boolean; comments: readonly ProposalCommentRecord[] }>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<CommentRow>(`select ${COMMENT_COLUMNS} from licitaciones.proposal_comment where organization_id = $1 and proposal_id = $2 order by created_at asc, id asc;`, [organizationId, proposalId]);
      return { disponible: true, comments: rows.map(mapComment) };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, comments: [] }),
  });
}

/** Ultima solicitud de revision por alcance: quien la hizo no puede aprobar ese alcance. Vacio sin la 037. */
export async function loadReviewSubmitters(db: TenantDbSession, organizationId: string, proposalId: string): Promise<Map<string, string>> {
  return runWithSavepointFallback({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ scope_ref: string; author_id: string }>(
        `select distinct on (scope_ref) scope_ref, author_id from licitaciones.proposal_comment
         where organization_id = $1 and proposal_id = $2 and kind = 'solicitud_revision' order by scope_ref, created_at desc, id desc;`,
        [organizationId, proposalId],
      );
      return new Map(rows.map((r) => [r.scope_ref, r.author_id]));
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => new Map<string, string>(),
  });
}
