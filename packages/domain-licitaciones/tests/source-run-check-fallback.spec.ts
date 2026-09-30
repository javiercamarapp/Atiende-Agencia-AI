// a5-fix-licitaciones-source-run-check-yucatan-guadalajara -- `recordSourceRun` contra la
// base SIN la migración 028 (CHECK `source_run_source_check` sin yucatan_ocds /
// guadalajara_ocds). Usa AbortAwareFakeSession (reproduce 25P02 tras un error): una sesión
// plana NO detectaría que, sin SAVEPOINT, el 23514 deja la transacción compartida
// abortada y el COMMIT revierte los tenders ya insertados.
import { describe, expect, it } from "vitest";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const RUN = {
  source: "yucatan_ocds" as const,
  state: "ok" as const,
  startedAt: "2026-09-30T10:00:00.000Z",
  finishedAt: "2026-09-30T10:00:01.000Z",
  evidence: { message: "Ingesta", coverage: { expected: 1, obtained: 1 } },
  correlationId: null,
};

function checkViolation(constraint: string): Error & { code: string; constraint: string } {
  const err = new Error(`new row for relation "source_run" violates check constraint "${constraint}"`) as Error & { code: string; constraint: string };
  err.code = "23514";
  err.constraint = constraint;
  return err;
}

describe("PostgresLicitacionesRepository.recordSourceRun -- base sin migración 028", () => {
  it("23514 en source_run_source_check: degrada con SAVEPOINT, NO lanza y deja la sesión utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_record_source_run/, respond: () => checkViolation("source_run_source_check") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresLicitacionesRepository(session);

    const rec = await repo.recordSourceRun(ORG, RUN);

    expect(rec.id).toBe("");
    expect(rec.notPersistedReason).toMatch(/028_source_run_check_yucatan_guadalajara/);
    expect(rec.notPersistedReason).toMatch(/yucatan_ocds/);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    // la transacción NO quedó abortada: una consulta posterior (p. ej. el COMMIT real) funciona
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("base migrada: registra la corrida normalmente (sin notPersistedReason)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_record_source_run/, respond: () => [{ out_id: "run-1", out_created_at: "2026-09-30T10:00:02.000Z" }] },
    ]);
    const rec = await new PostgresLicitacionesRepository(session).recordSourceRun(ORG, RUN);
    expect(rec.id).toBe("run-1");
    expect(rec.notPersistedReason).toBeUndefined();
  });

  it("otro 23514 (CHECK de state) NO se enmascara: se repropaga", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_record_source_run/, respond: () => checkViolation("source_run_state_check") },
    ]);
    await expect(new PostgresLicitacionesRepository(session).recordSourceRun(ORG, RUN)).rejects.toMatchObject({ code: "23514", constraint: "source_run_state_check" });
  });
});
