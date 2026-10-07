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
function makeDb(opts: { migrated: boolean }) {
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
        // L-P3-08: el vigilante de cambios consulta la ultima version; estas pruebas modelan una base SIN la migracion 039
        // (42883 dentro de un SAVEPOINT): la ingesta y el registro de la corrida no deben verse afectados.
        match: /system_latest_tender_version/,
        respond: () => Object.assign(new Error("function licitaciones.system_latest_tender_version(uuid, uuid) does not exist"), { code: "42883" }),
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
    // un aviso por fuente por la 028 (source_run) y otro por la 039 (el vigilante de cambios no esta disponible: nunca en silencio)
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.filter(([m]) => /039_licitaciones_autopiloto/.test(String(m)))).toHaveLength(2);
    for (const r of results) expect(r.vigilanteNoDisponible).toMatch(/039_licitaciones_autopiloto/);
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
