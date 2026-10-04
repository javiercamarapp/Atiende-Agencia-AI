// paridad3 L-P3-14 (REQ-152): la misma convocatoria que llega por dos fuentes NO se duplica. Repositorio en memoria (mismo contrato que
// la funcion SQL system_ingest_tender_dedupe) y fallback de la base sin la migracion 037 con AbortAwareFakeSession (una sesion plana NO
// reproduce el estado abortado de Postgres).
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import type { TenderSourceIngestCandidate } from "../src/connectors/types.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const OTRA_ORG = "00000000-0000-0000-0000-000000000002";

function candidato(overrides: Partial<TenderSourceIngestCandidate> = {}): TenderSourceIngestCandidate {
  return {
    externalId: "ocds-abc-1",
    title: "Adquisicion de equipo de computo",
    submissionDeadline: "2026-12-15T18:00:00-06:00",
    contractingBody: "Secretaría de Obras Públicas",
    cpvCodes: ["30200000"],
    budgetAmount: 250_000,
    currency: "MXN",
    state: "NL",
    procedureTypeRaw: "licitacion_publica",
    procedureNumber: "LA-931037999-E12-2026",
    ...overrides,
  };
}

describe("ingestTendersFromSource (en memoria) -- huella cruzada", () => {
  it("una fuente A y una fuente B con la misma huella crean UNA convocatoria con dos fuentes", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const a = await repo.ingestTendersFromSource(ORG, "nl_ocds", [candidato()]);
    expect(a).toMatchObject({ created: 1, updated: 0, linked: 0 });
    const b = await repo.ingestTendersFromSource(ORG, "cdmx_ocds", [
      candidato({ externalId: "CDMX-77", procedureNumber: " la-931037999-e12-2026 ", contractingBody: "SECRETARIA DE OBRAS PUBLICAS", submissionDeadline: "2026-12-15T10:00:00-06:00" }),
    ]);
    expect(b).toMatchObject({ created: 0, updated: 0, linked: 1 });
    expect(b.tenders[0]!.id).toBe(a.tenders[0]!.id);
    const fuentes = await repo.listTenderSources(ORG, a.tenders[0]!.id);
    expect(fuentes.map((f) => [f.source, f.externalId, f.primary])).toEqual([
      ["nl_ocds", "ocds-abc-1", true],
      ["cdmx_ocds", "CDMX-77", false],
    ]);
  });

  it("los conflictos de campos se registran en la fuente enlazada y NO sobrescriben la convocatoria", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const a = await repo.ingestTendersFromSource(ORG, "nl_ocds", [candidato()]);
    const b = await repo.ingestTendersFromSource(ORG, "cdmx_ocds", [candidato({ externalId: "CDMX-77", budgetAmount: 300_000, title: "Otro titulo" })]);
    expect(b.conflicts).toBe(2);
    const [, alt] = await repo.listTenderSources(ORG, a.tenders[0]!.id);
    expect(alt!.conflicts.map((c) => c.field).sort()).toEqual(["budget_amount", "title"]);
    expect(b.tenders[0]!.title).toBe("Adquisicion de equipo de computo");
    expect(b.tenders[0]!.budgetAmount).toBe(250_000);
  });

  it("reingerir la fuente enlazada no duplica ni crea otra convocatoria", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.ingestTendersFromSource(ORG, "nl_ocds", [candidato()]);
    const b1 = await repo.ingestTendersFromSource(ORG, "cdmx_ocds", [candidato({ externalId: "CDMX-77" })]);
    const b2 = await repo.ingestTendersFromSource(ORG, "cdmx_ocds", [candidato({ externalId: "CDMX-77" })]);
    expect(b2).toMatchObject({ created: 0, linked: 1 });
    expect(await repo.listTenderSources(ORG, b1.tenders[0]!.id)).toHaveLength(2);
    expect((await repo.listTendersPage(ORG, { limit: 50, offset: 0 })).total).toBe(1);
  });

  it("procedimientos distintos NO se fusionan", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.ingestTendersFromSource(ORG, "nl_ocds", [candidato()]);
    const b = await repo.ingestTendersFromSource(ORG, "cdmx_ocds", [candidato({ externalId: "CDMX-77", procedureNumber: "LA-931037999-E13-2026" })]);
    expect(b).toMatchObject({ created: 1, linked: 0 });
  });

  it("sin numero de procedimiento no hay huella: no se deduplica (un duplicado visible es mejor que una fusion falsa)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.ingestTendersFromSource(ORG, "nl_ocds", [candidato({ procedureNumber: null })]);
    const b = await repo.ingestTendersFromSource(ORG, "cdmx_ocds", [candidato({ externalId: "CDMX-77", procedureNumber: null })]);
    expect(b).toMatchObject({ created: 1, linked: 0 });
  });

  it("cross-tenant: la misma huella en otra organizacion NO enlaza", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.ingestTendersFromSource(ORG, "nl_ocds", [candidato()]);
    const b = await repo.ingestTendersFromSource(OTRA_ORG, "cdmx_ocds", [candidato({ externalId: "CDMX-77" })]);
    expect(b).toMatchObject({ created: 1, linked: 0 });
    expect(await repo.listTenderSources(ORG, b.tenders[0]!.id)).toEqual([]);
  });
});

function pgError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const FILA = {
  out_id: "t-1", out_organization_id: ORG, out_title: "x", out_submission_deadline: null, out_updated_at: "2026-10-04T00:00:00Z", out_source: "nl_ocds", out_external_id: "e", out_contracting_body: null,
  out_cpv_codes: [], out_budget_amount: null, out_currency: "MXN", out_state: null, out_procedure_type_raw: null, out_status: "discovered", out_inserted: true,
};

describe("PostgresLicitacionesRepository.ingestTendersFromSource -- base sin la migracion 037", () => {
  it("42883 en la funcion de huella: cae al camino anterior con SAVEPOINT, no aborta el lote y no reintenta la funcion ausente", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_ingest_tender_dedupe/, respond: () => pgError("function licitaciones.system_ingest_tender_dedupe does not exist", "42883") },
      { match: /system_ingest_tender\(/, respond: () => [FILA] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresLicitacionesRepository(session);
    const res = await repo.ingestTendersFromSource(ORG, "nl_ocds", [candidato({ externalId: "a" }), candidato({ externalId: "b" })]);
    expect(res).toMatchObject({ created: 2, linked: 0 });
    expect(session.calls.filter((c) => /system_ingest_tender_dedupe/.test(c))).toHaveLength(1);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("base migrada: usa la funcion de huella y cuenta el enlace y sus conflictos", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_ingest_tender_dedupe/, respond: () => [{ ...FILA, out_inserted: false, out_linked: true, out_conflicts: 3 }] }]);
    const res = await new PostgresLicitacionesRepository(session).ingestTendersFromSource(ORG, "cdmx_ocds", [candidato()]);
    expect(res).toMatchObject({ created: 0, updated: 0, linked: 1, conflicts: 3 });
  });

  it("un error NO recuperable (conexion caida) se repropaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_ingest_tender_dedupe/, respond: () => pgError("connection terminated", "08006") }]);
    await expect(new PostgresLicitacionesRepository(session).ingestTendersFromSource(ORG, "nl_ocds", [candidato()])).rejects.toThrow("connection terminated");
  });

  it("sin numero de procedimiento ni siquiera intenta la funcion nueva", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_ingest_tender\(/, respond: () => [FILA] }]);
    await new PostgresLicitacionesRepository(session).ingestTendersFromSource(ORG, "nl_ocds", [candidato({ procedureNumber: undefined })]);
    expect(session.calls.some((c) => /dedupe/.test(c))).toBe(false);
  });

  it("listTenderSources: 42P01 (sin tabla de fuentes) devuelve solo la primaria y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from licitaciones\.tender where/, respond: () => [{ source: "nl_ocds", external_id: "e", updated_at: "2026-10-04T00:00:00Z" }] },
      { match: /tender_alt_source/, respond: () => pgError('relation "licitaciones.tender_alt_source" does not exist', "42P01") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const fuentes = await new PostgresLicitacionesRepository(session).listTenderSources(ORG, "t-1");
    expect(fuentes.map((f) => f.primary)).toEqual([true]);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});
