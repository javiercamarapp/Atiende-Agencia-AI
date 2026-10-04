// paridad3 -- PostgresLicitacionesRepository contra la base SIN la migracion 037. Usa AbortAwareFakeSession (reproduce
// el estado abortado 25P02 tras un error): una sesion falsa plana NO detectaria que, sin SAVEPOINT, el 42703 deja la
// transaccion compartida abortada y la consulta de respaldo falla.
import { describe, expect, it } from "vitest";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { BovedaRevisionNoDisponibleError } from "../src/errors.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { RequirementUpsertItem } from "../src/repository.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const TENDER = "00000000-0000-0000-0000-0000000000e1";
const PROPOSAL = "00000000-0000-0000-0000-0000000000f1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const undefinedColumn = () => pgError("42703", 'column "extraction_status" does not exist');
const undefinedTable = () => pgError("42P01", 'relation "licitaciones.requirement_conflict" does not exist');

const item: RequirementUpsertItem = {
  id: "req-1",
  documentId: null,
  documentRef: "bases",
  text: "Presentar acta constitutiva.",
  requirementKind: "legal",
  obligatoriedad: "obligatorio",
  topicKey: null,
  requiredEvidence: [],
  extractedBy: "rule",
  page: 1,
  clause: null,
  responsibleRole: "legal",
  deadline: null,
  status: "pendiente",
  confidence: null,
};

function sessionUsable(session: AbortAwareFakeSession): Promise<unknown> {
  return session.query("select 1 as ok");
}

describe("boveda / matriz / conflictos / comentarios -- base sin la migracion 037", () => {
  it("listar documentos: vacio honesto con disponible=false y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from licitaciones\.tender_document/, respond: undefinedColumn }, { match: /select 1 as ok/, respond: () => [{ ok: 1 }] }]);
    expect(await new PostgresLicitacionesRepository(session).listTenderDocuments(ORG, TENDER)).toEqual({ disponible: false, documents: [] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(sessionUsable(session)).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("subir un documento: BovedaRevisionNoDisponibleError (no un 500) y el blob insertado se revierte con el savepoint", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into licitaciones\.file_blob/, respond: () => [{ id: "blob-1" }] },
      { match: /insert into licitaciones\.tender_document/, respond: undefinedColumn },
      { match: /select 1 as ok/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(
      new PostgresLicitacionesRepository(session).createTenderDocument(ORG, TENDER, {
        documentType: "bases",
        title: null,
        filename: "bases.txt",
        mimeType: "text/plain",
        buffer: new TextEncoder().encode("texto"),
        extractionStatus: "extracted",
        extractionDetail: null,
        pageCount: 1,
        pages: [{ page: 1, text: "texto" }],
        actorId: "u1",
        replacesDocumentId: null,
      }),
    ).rejects.toBeInstanceOf(BovedaRevisionNoDisponibleError);
    await expect(sessionUsable(session)).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("extraer: cae al reemplazo anterior con ids uuid reales (el id req-N del extractor no es uuid)", async () => {
    const inserted: unknown[][] = [];
    const session = new (class extends AbortAwareFakeSession {
      override async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        if (/insert into licitaciones\.requirement_item/.test(sql) && !/stable_key/.test(sql)) inserted.push(params ?? []);
        return super.query<T>(sql, params);
      }
    })([
      { match: /left join licitaciones\.tender_document/, respond: undefinedColumn },
      { match: /delete from licitaciones\.requirement_item/, respond: () => [] },
      { match: /insert into licitaciones\.requirement_item/, respond: () => [] },
      { match: /from licitaciones\.requirement_item where organization_id = \$1 and tender_id = \$2 and invalidated_at is null/, respond: () => [] },
    ]);
    const res = await new PostgresLicitacionesRepository(session).upsertRequirementItems(ORG, TENDER, [item], { actorId: "u1", scope: { lineageIds: [], includeUnlinked: true }, retiredInVersion: null });
    expect(res.mode).toBe("reemplazo");
    expect(res.created).toBe(1);
    expect(res.idByInputId["req-1"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]![0]).toBe(res.idByInputId["req-1"]);
  });

  it("conflictos: listar y sincronizar dan vacio, contar da 0 y resolver pide la migracion", async () => {
    const session = new AbortAwareFakeSession([{ match: /requirement_conflict/, respond: undefinedTable }, { match: /select 1 as ok/, respond: () => [{ ok: 1 }] }]);
    const repo = new PostgresLicitacionesRepository(session);
    expect(await repo.listRequirementConflicts(ORG, TENDER)).toEqual({ disponible: false, conflicts: [] });
    expect(await repo.syncRequirementConflicts(ORG, TENDER, [])).toEqual({ disponible: false, conflicts: [] });
    expect(await repo.countOpenRequirementConflicts(ORG, TENDER)).toBe(0);
    await expect(repo.resolveRequirementConflict(ORG, TENDER, "c1", { actorId: "u1", notes: "n" })).rejects.toBeInstanceOf(BovedaRevisionNoDisponibleError);
    await expect(sessionUsable(session)).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("comentarios: listar da vacio, comentar pide la migracion, y la bitacora nueva se ignora sin romper la sesion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /proposal_comment/, respond: undefinedTable },
      { match: /insert into licitaciones\.tender_audit_log/, respond: () => pgError("23514", 'violates check constraint "tender_audit_log_action_check"') },
      { match: /select 1 as ok/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresLicitacionesRepository(session);
    expect(await repo.listProposalComments(ORG, PROPOSAL)).toEqual({ disponible: false, comments: [] });
    await expect(repo.addProposalComment(ORG, PROPOSAL, { scope: "expediente", scopeRef: "expediente", kind: "comentario", body: "x", authorId: "u1", authorRole: "writer" })).rejects.toBeInstanceOf(BovedaRevisionNoDisponibleError);
    await expect(repo.recordTenderAuditEvent(ORG, TENDER, "document.uploaded", "u1")).resolves.toBeUndefined();
    await expect(sessionUsable(session)).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("matriz: listar cae a la lectura anterior con valores neutros; un error que no es de migracion se repropaga", async () => {
    const legacyRow = { id: "i1", document_id: null, description: "Req", requirement_kind: "legal", obligatoriedad: "obligatorio", topic_key: null, required_evidence: [], extracted_by: "rule", page: 1, clause: null, responsible_role: "legal", deadline: null, status: "pendiente", confidence: null };
    const session = new AbortAwareFakeSession([
      { match: /left join licitaciones\.tender_document/, respond: undefinedColumn },
      { match: /from licitaciones\.requirement_item where organization_id = \$1 and tender_id = \$2 and invalidated_at is null/, respond: () => [legacyRow] },
    ]);
    const res = await new PostgresLicitacionesRepository(session).listRequirementMatrix(ORG, TENDER, { includeRetired: true });
    expect(res.migrated).toBe(false);
    expect(res.items[0]).toMatchObject({ id: "i1", assignedTo: null, disqualifying: false, retiredAt: null });

    const boom = new AbortAwareFakeSession([{ match: /left join licitaciones\.tender_document/, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresLicitacionesRepository(boom).listRequirementMatrix(ORG, TENDER, { includeRetired: false })).rejects.toMatchObject({ code: "57014" });
  });
});
