// L-26 -- adaptador Postgres de la doble aprobacion contra la base SIN migrar (columna `stage`
// inexistente, 42703) y contra conflictos de requests cruzados (23505/23514), usando
// AbortAwareFakeSession: una sesion plana NO reproduce 25P02 ni el estado abortado de la
// transaccion unica del request, que es justo lo que hace falta ejercitar.
import { describe, expect, it } from "vitest";
import { ApprovalRejectedError, ExpedienteStageNotAvailableError } from "../src/errors.ts";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { sealInputs } from "../src/sealed-inputs.ts";
import type { ExpedienteInputs } from "../src/sealed-inputs.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const PROPOSAL = "00000000-0000-0000-0000-0000000000b1";
const INPUTS: ExpedienteInputs = { tenderVersionHash: "tv1", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] };

function pgError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const approvalRow = (id: string, stage: string | null, approver: string) => ({
  id,
  scope: "expediente",
  scope_ref: "expediente",
  approver_id: approver,
  approver_role: "owner",
  inputs_hash: sealInputs(INPUTS).hash,
  decided_at: "2026-10-01T12:00:00Z",
  status: "vigente",
  invalidated_at: null,
  invalidated_reason: null,
  stage,
});

describe("PostgresLicitacionesRepository.listExpedienteStageApprovals", () => {
  it("base MIGRADA: modo doble con la etapa de cada fila", async () => {
    const session = new AbortAwareFakeSession([{ match: /, stage from licitaciones\.approval/, respond: () => [approvalRow("a1", "tecnica_legal", "u1"), approvalRow("a2", "economica", "u2")] }]);
    const result = await new PostgresLicitacionesRepository(session).listExpedienteStageApprovals(ORG, PROPOSAL);
    expect(result.mode).toBe("doble");
    expect(result.approvals.map((a) => a.stage)).toEqual(["tecnica_legal", "economica"]);
  });

  it("base SIN migrar: 42703 cae al modo legacy con la sesion RECUPERADA (nada de 25P02 ni COMMIT que revierte en silencio)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /, stage from licitaciones\.approval/, respond: () => pgError("42703", 'column "stage" does not exist') },
      { match: /from licitaciones\.approval\s+where organization_id = \$1 and proposal_id = \$2 and status = 'vigente' and scope_ref = any/, respond: () => [approvalRow("legacy", null, "u1")] },
    ]);
    const result = await new PostgresLicitacionesRepository(session).listExpedienteStageApprovals(ORG, PROPOSAL);
    expect(result.mode).toBe("legacy");
    expect(result.approvals.map((a) => a.id)).toEqual(["legacy"]);
    expect(result.approvals[0]!.stage).toBeUndefined();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de migracion pendiente se propaga (nunca se enmascara como legacy)", async () => {
    const session = new AbortAwareFakeSession([{ match: /, stage from licitaciones\.approval/, respond: () => pgError("42501", "permission denied for table approval") }]);
    await expect(new PostgresLicitacionesRepository(session).listExpedienteStageApprovals(ORG, PROPOSAL)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("PostgresLicitacionesRepository.approve con etapa", () => {
  const stageInput = (stage: "tecnica_legal" | "economica", actorId: string) => ({
    scope: "expediente" as const,
    scopeRef: "expediente",
    actorId,
    actorRole: "owner" as const,
    inputsHash: sealInputs(INPUTS),
    stage,
  });
  const authors = { match: /from licitaciones\.section_author/, respond: () => [] as unknown[] };
  // paridad3: approve() tambien lee las solicitudes de revision (proposal_comment); sin filas nadie queda impedido.
  const submitters = { match: /from licitaciones\.proposal_comment/, respond: () => [] as unknown[] };

  it("base sin migrar: lanza ExpedienteStageNotAvailableError y NO escribe nada", async () => {
    const session = new AbortAwareFakeSession([
      authors,
      submitters,
      { match: /, stage from licitaciones\.approval/, respond: () => pgError("42703", 'column "stage" does not exist') },
      { match: /scope_ref = any/, respond: () => [] },
    ]);
    await expect(new PostgresLicitacionesRepository(session).approve(ORG, PROPOSAL, stageInput("tecnica_legal", "u1"))).rejects.toBeInstanceOf(ExpedienteStageNotAvailableError);
    expect(session.calls.some((c) => c.startsWith("insert into licitaciones.approval"))).toBe(false);
  });

  it("la economica sin tecnico-legal vigente se rechaza ANTES de tocar la base", async () => {
    const session = new AbortAwareFakeSession([authors, submitters, { match: /, stage from licitaciones\.approval/, respond: () => [] }]);
    await expect(new PostgresLicitacionesRepository(session).approve(ORG, PROPOSAL, stageInput("economica", "u2"))).rejects.toMatchObject({ reasonCode: "tecnica_legal_requerida_para_economica" });
    expect(session.calls.some((c) => c.startsWith("update licitaciones.approval") || c.startsWith("insert into licitaciones.approval"))).toBe(false);
  });

  it("choque del trigger (23514 doble_aprobacion_mismo_actor) en un request cruzado se traduce y la sesion queda recuperada", async () => {
    const session = new AbortAwareFakeSession([
      authors,
      submitters,
      { match: /, stage from licitaciones\.approval/, respond: () => [approvalRow("tl", "tecnica_legal", "u1")] },
      { match: /^update licitaciones\.approval/i, respond: () => [] },
      { match: /insert into licitaciones\.approval/, respond: () => pgError("23514", "doble_aprobacion_mismo_actor: la aprobacion tecnico-legal y la economica deben darlas dos personas distintas") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresLicitacionesRepository(session).approve(ORG, PROPOSAL, stageInput("economica", "u2"))).rejects.toMatchObject({ reasonCode: "doble_aprobacion_mismo_actor" });
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("choque del indice unico (23505) se traduce a conflicto concurrente", async () => {
    const session = new AbortAwareFakeSession([
      authors,
      submitters,
      { match: /, stage from licitaciones\.approval/, respond: () => [approvalRow("tl", "tecnica_legal", "u1")] },
      { match: /^update licitaciones\.approval/i, respond: () => [] },
      { match: /insert into licitaciones\.approval/, respond: () => pgError("23505", "duplicate key value violates unique constraint") },
    ]);
    const err = await new PostgresLicitacionesRepository(session).approve(ORG, PROPOSAL, stageInput("economica", "u2")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalRejectedError);
    expect((err as ApprovalRejectedError).reasonCode).toBe("doble_aprobacion_conflicto_concurrente");
  });

  it("camino feliz: invalida SOLO la misma etapa e inserta con la etapa", async () => {
    const session = new AbortAwareFakeSession([
      authors,
      submitters,
      { match: /, stage from licitaciones\.approval/, respond: () => [approvalRow("tl", "tecnica_legal", "u1")] },
      { match: /^update licitaciones\.approval/i, respond: () => [] },
      { match: /insert into licitaciones\.approval/, respond: () => [approvalRow("ec", "economica", "u2")] },
    ]);
    const approval = await new PostgresLicitacionesRepository(session).approve(ORG, PROPOSAL, stageInput("economica", "u2"));
    expect(approval.stage).toBe("economica");
    expect(approval.id).toBe("ec");
  });
});
