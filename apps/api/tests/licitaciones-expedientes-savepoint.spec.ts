// paridad3 L-P3-16 (correccion de revision PR #443): la fila de la bandeja de expedientes comparte UNA transaccion y
// `listExpedienteStageApprovals` abre un SAVEPOINT (la columna approval.stage solo existe tras la 033). Contra la base SIN
// migrar la consulta primaria falla con 42703; ninguna otra consulta de la fila puede correr en paralelo, o caeria en la
// transaccion abortada (25P02). AbortAwareFakeSession reproduce ese estado abortado (una sesion plana NO sirve).
import { describe, expect, it, vi } from "vitest";
import { PostgresLicitacionesRepository } from "@atiende/domain-licitaciones";
import type { TenderRecord } from "@atiende/domain-licitaciones";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import { filaDe } from "../src/routes/verticals/licitaciones/expedientes.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const TENDER: TenderRecord = { id: "00000000-0000-0000-0000-0000000000b1", organizationId: ORG, title: "Convocatoria", submissionDeadline: null, updatedAt: "2026-09-01T00:00:00Z", source: "manual", status: "go" };
const PROPOSAL_ID = "00000000-0000-0000-0000-0000000000c1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const tick = async (): Promise<void> => { await Promise.resolve(); };

describe("filaDe (bandeja de expedientes) contra la base sin la 033", () => {
  it("la consulta de etapa responde 42703: la fila sale en modo legacy, sin 25P02 y con la sesion recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select .*, stage from licitaciones\.approval/s, respond: () => pgError("42703", 'column "stage" does not exist') },
      { match: /from licitaciones\.approval/, respond: () => [] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresLicitacionesRepository(session);
    // Las demas lecturas se simulan como consultas reales y SECUENCIALES de la misma sesion (algunas con varios pasos), para
    // que una consulta concurrente al SAVEPOINT caiga en la transaccion abortada exactamente como en Postgres.
    const leer = async <T>(valor: T, pasos = 1): Promise<T> => { for (let i = 0; i < pasos; i += 1) { await tick(); await session.query("select 1"); } return valor; };
    vi.spyOn(repo, "listRequirementItems").mockImplementation(() => leer([]));
    vi.spyOn(repo, "findProposal").mockImplementation(() => leer({ id: PROPOSAL_ID } as never));
    vi.spyOn(repo, "listComplianceItems").mockImplementation(() => leer([]));
    vi.spyOn(repo, "findLatestManifest").mockImplementation(() => leer(null));
    vi.spyOn(repo, "findSubmission").mockImplementation(() => leer(null));
    vi.spyOn(repo, "computeCurrentInputsHash").mockImplementation(() => leer({ raw: { tenderVersionHash: "h1", companyProfileHash: "h2", companyDocuments: [], rates: [], templates: [] } } as never, 8));

    const fila = await filaDe(repo, ORG, TENDER);

    expect(fila.aprobacion).toMatchObject({ modo: "legacy", completa: false });
    expect(fila.redaccion).toBe("hecho");
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});
