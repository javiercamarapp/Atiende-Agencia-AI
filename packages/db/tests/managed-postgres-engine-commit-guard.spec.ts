// Hallazgo CRÍTICO de auditoría (a1, r3) — defensa en el motor: en Postgres real,
// un `COMMIT` sobre una transacción ABORTADA (cualquier error dentro del bloque que
// un `catch` haya atrapado SIN `SAVEPOINT`, ver `../src/savepoint-fallback.ts`) NO
// lanza error -- el servidor lo trata como `ROLLBACK` implícito y devuelve ese
// mismo tag de comando. Sin esta defensa, `withAppSession` devolvería el resultado
// de `fn()` normalmente y el handler HTTP respondería 200/201 con TODO lo escrito
// en el request revertido en silencio.
//
// `pg` real no es viable aquí (este test corre sin Postgres) -- se mockea el driver
// con un `FakePoolClient` mínimo que solo entiende las pocas sentencias que
// `withAppSession` emite (`begin;`/`set local role...`/`select set_config(...)`/
// `commit;`/`rollback;`), controlado por `commitResponse` (compartido vía
// `vi.hoisted` con el factory de `vi.mock`).
import { afterEach, describe, expect, it, vi } from "vitest";

const { commitResponse, releaseCalls, queryLog } = vi.hoisted(() => ({
  commitResponse: { current: { rows: [] as unknown[], command: "COMMIT" } },
  releaseCalls: { current: [] as unknown[] },
  queryLog: { current: [] as string[] },
}));

vi.mock("pg", () => {
  class FakePoolClient {
    async query(sql: string, _params?: unknown[]): Promise<{ rows: unknown[]; command: string }> {
      const normalized = sql.trim().toLowerCase();
      queryLog.current.push(normalized);
      if (normalized.startsWith("begin")) return { rows: [], command: "BEGIN" };
      if (normalized.startsWith("set local role")) return { rows: [], command: "SET" };
      if (normalized.startsWith("select set_config")) return { rows: [{ set_config: "" }], command: "SELECT" };
      if (normalized.startsWith("commit")) return commitResponse.current;
      if (normalized.startsWith("rollback")) return { rows: [], command: "ROLLBACK" };
      return { rows: [], command: "SELECT" };
    }
    release(err?: unknown): void {
      releaseCalls.current.push(err);
    }
  }
  class FakePool {
    async connect(): Promise<FakePoolClient> {
      return new FakePoolClient();
    }
    on(): void {
      // no-op -- withAppSession no usa el listener "error" del pool en este test.
    }
    async end(): Promise<void> {}
  }
  return { default: { Pool: FakePool } };
});

const { openManagedPostgres, AbortedTransactionCommitError } = await import("../src/managed-postgres-engine.ts");

describe("ManagedPostgresEngine.withAppSession — defensa: COMMIT que devuelve ROLLBACK", () => {
  afterEach(() => {
    commitResponse.current = { rows: [], command: "COMMIT" };
    releaseCalls.current = [];
    queryLog.current = [];
  });

  it("COMMIT normal (tag 'COMMIT'): devuelve el resultado de fn() tal cual, un solo release() sin error", async () => {
    const engine = openManagedPostgres({ connectionString: "postgres://fake" });

    const result = await engine.withAppSession({ userId: "u1" }, async () => "ok");

    expect(result).toBe("ok");
    expect(releaseCalls.current).toEqual([undefined]);
  });

  it("fn() NO lanza error, pero el COMMIT devuelve el tag 'ROLLBACK' (transacción abortada en silencio): lanza AbortedTransactionCommitError, un solo release() SIN error (nada que revertir dos veces)", async () => {
    commitResponse.current = { rows: [], command: "ROLLBACK" };
    const engine = openManagedPostgres({ connectionString: "postgres://fake" });

    await expect(engine.withAppSession({ userId: "u1" }, async () => "ok, pero mentira")).rejects.toBeInstanceOf(AbortedTransactionCommitError);

    // El cliente se liberó UNA sola vez (justo antes de lanzar) -- el catch NUNCA
    // debe intentar rollback/release de nuevo sobre un cliente ya devuelto al pool.
    expect(releaseCalls.current).toEqual([undefined]);
    expect(queryLog.current.filter((q) => q.startsWith("rollback")).length).toBe(0);
  });

  it("fn() SÍ lanza: rollback + release(err) normal, nunca llega a evaluar el COMMIT", async () => {
    const engine = openManagedPostgres({ connectionString: "postgres://fake" });
    const boom = new Error("fn falló de verdad");

    await expect(
      engine.withAppSession({ userId: "u1" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(queryLog.current.filter((q) => q.startsWith("rollback")).length).toBe(1);
    expect(queryLog.current.filter((q) => q.startsWith("commit")).length).toBe(0);
    expect(releaseCalls.current).toEqual([boom]);
  });
});
