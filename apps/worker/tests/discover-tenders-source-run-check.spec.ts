// a5-fix-licitaciones-source-run-check-yucatan-guadalajara -- EFECTO del job de descubrimiento
// con yucatan_ocds/guadalajara_ocds contra la base SIN y CON la migración 028. Usa el
// PostgresLicitacionesRepository REAL sobre AbortAwareFakeSession (25P02 tras un error) y un
// motor que imita BEGIN/COMMIT: si la sesión queda abortada al cerrar, lo escrito se descarta
// (Postgres devuelve ROLLBACK en el COMMIT). Solo se sustituye el transporte: los conectores
// de las 2 fuentes son stubs de red-nula con candidatos fijos.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LICITACIONES_CONNECTOR_REGISTRY, PostgresLicitacionesRepository } from "@atiende/domain-licitaciones";
import type { LicitacionesRepository, LicitacionesSourceConnector, SourceConnectorId } from "@atiende/domain-licitaciones";
import { runDiscoverTendersForOrganization } from "../src/jobs/licitaciones/discover-tenders.ts";
import { AbortAwareFakeSession } from "../../../packages/domain-licitaciones/tests/support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const SOURCES: SourceConnectorId[] = ["yucatan_ocds", "guadalajara_ocds"];

function stubConnector(id: SourceConnectorId): LicitacionesSourceConnector {
  return {
    id,
    async *discover() {
      yield { externalId: `${id}-1`, title: `Tender ${id}`, submissionDeadline: null, contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", state: null, procedureTypeRaw: null };
    },
    fetchDetail: () => Promise.reject(new Error("n/a")),
  };
}

/** Motor fake: una "transacción" por withRepo; committed solo si la sesión no quedó abortada. */
function makeDb(opts: { migrated: boolean; auditMigrated?: boolean }) {
  const committedTenders: string[] = [];
  const committedRuns: string[] = [];
  const withRepo = async <T>(fn: (repo: LicitacionesRepository) => Promise<T>): Promise<T> => {
    const pendingTenders: string[] = [];
    const pendingRuns: string[] = [];
    let n = 0;
    const session = new AbortAwareFakeSession([
      {
        match: /system_ingest_tender/,
        respond: () => {
          n += 1;
          pendingTenders.push(`t${n}`);
          return [{ out_id: `t${n}`, out_organization_id: ORG, out_title: "x", out_submission_deadline: null, out_updated_at: "2026-09-30T10:00:00.000Z", out_source: "yucatan_ocds", out_external_id: "e", out_contracting_body: null, out_cpv_codes: [], out_budget_amount: null, out_currency: "MXN", out_state: null, out_procedure_type_raw: null, out_status: "new", out_inserted: true }];
        },
      },
      {
        // L-P3-17: el alta de cada convocatoria nueva se anota en la bitacora (038). Sin la 038 la funcion no existe (42883) y el SAVEPOINT recupera.
        match: /licitaciones\.append_audit/,
        respond: () => {
          if (opts.auditMigrated === false) {
            const err = new Error("function licitaciones.append_audit(uuid, uuid, text, text, text, jsonb, jsonb, text) does not exist") as Error & { code: string };
            err.code = "42883";
            return err;
          }
          return [{ append_audit: "audit-1" }];
        },
      },
      {
        match: /system_record_source_run/,
        respond: () => {
          if (!opts.migrated) {
            const err = new Error('new row for relation "source_run" violates check constraint "source_run_source_check"') as Error & { code: string; constraint: string };
            err.code = "23514";
            err.constraint = "source_run_source_check";
            return err;
          }
          pendingRuns.push("run");
          return [{ out_id: "run-1", out_created_at: "2026-09-30T10:00:02.000Z" }];
        },
      },
    ]);
    const result = await fn(new PostgresLicitacionesRepository(session));
    const aborted = (session as unknown as { aborted: boolean }).aborted;
    if (!aborted) {
      committedTenders.push(...pendingTenders);
      committedRuns.push(...pendingRuns);
    }
    return result;
  };
  return { withRepo, committedTenders, committedRuns };
}

function spyRegistry() {
  const real = LICITACIONES_CONNECTOR_REGISTRY.all();
  vi.spyOn(LICITACIONES_CONNECTOR_REGISTRY, "all").mockReturnValue(
    SOURCES.map((id) => ({ ...real.find((d) => d.id === id)!, connector: stubConnector(id) })),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("discover-tenders con yucatan_ocds/guadalajara_ocds", () => {
  it("L-P3-17: base con 028 pero SIN la 038 (bitacora): los tenders y las corridas se PERSISTEN igual (SAVEPOINT, nunca 25P02)", async () => {
    spyRegistry();
    const db = makeDb({ migrated: true, auditMigrated: false });
    const results = await runDiscoverTendersForOrganization(db.withRepo, ORG);
    expect(db.committedTenders).toHaveLength(2);
    expect(db.committedRuns).toHaveLength(2);
    expect(results.every((r) => r.state === "ok")).toBe(true);
  });

  it("base SIN migrar: los tenders de ambas fuentes se PERSISTEN, no hay source_run y el aviso es explícito (log + resultado)", async () => {
    spyRegistry();
    const db = makeDb({ migrated: false });
    const warn = vi.fn();
    const results = await runDiscoverTendersForOrganization(db.withRepo, ORG, { logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never });

    expect(db.committedTenders).toHaveLength(2); // antes del fix: 0 (rollback completo)
    expect(db.committedRuns).toHaveLength(0);
    for (const r of results) {
      expect(r.state).toBe("ok");
      expect(r.created).toBe(1);
      expect(r.message).toMatch(/AVISO: source_run no registrado.*028_source_run_check_yucatan_guadalajara/);
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("base migrada (028): tenders persistidos Y source_run registrado por cada fuente, sin aviso", async () => {
    spyRegistry();
    const db = makeDb({ migrated: true });
    const results = await runDiscoverTendersForOrganization(db.withRepo, ORG);

    expect(db.committedTenders).toHaveLength(2);
    expect(db.committedRuns).toHaveLength(2);
    expect(results.every((r) => r.state === "ok" && !r.message.includes("AVISO"))).toBe(true);
  });
});
