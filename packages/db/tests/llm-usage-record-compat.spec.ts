// `recordUsage` contra la base SIN migrar (0040 pendiente): la funcion de 12 argumentos no existe (42883) y debe
// caer a la de 10. La sesion falsa reproduce el estado ABORTADO real de Postgres (25P02 hasta ROLLBACK TO
// SAVEPOINT): una sesion plana no distinguiria un fallback que se salte el SAVEPOINT.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresLlmUsageRepository } from "../src/llm-usage-repository.ts";

class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  readonly calls: string[] = [];
  readonly params: unknown[][] = [];
  constructor(private readonly onQuery: (sql: string) => { throws: Error } | undefined) {}

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push(`query:${sql.replace(/\s+/g, " ").trim()}`);
    this.params.push(params ?? []);
    if (this.aborted) throw Object.assign(new Error("current transaction is aborted, commands ignored until end of transaction block"), { code: "25P02" });
    const r = this.onQuery(sql);
    if (r) {
      this.aborted = true;
      throw r.throws;
    }
    return { rows: [] };
  }

  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    this.calls.push(`exec:${n}`);
    if (n.startsWith("rollback to savepoint")) this.aborted = false;
  }
}

const EVENT = {
  organizationId: "00000000-0000-0000-0000-000000000001",
  vertical: "restaurantes",
  role: "restaurantes:data_chat",
  providerId: "openrouter:openai/gpt-6-luna",
  model: "openai/gpt-6-luna",
  lane: "interactive",
  tokensIn: 1000,
  tokensOut: 200,
  tokensCached: 600,
  tokensReasoning: 80,
  costMicroUsd: 150,
  fallbackUsed: false,
};

const missingFn = () => ({ throws: Object.assign(new Error("function core.record_llm_usage(uuid, text, ..., bigint, bigint) does not exist"), { code: "42883" }) });

describe("PostgresLlmUsageRepository.recordUsage: compatibilidad con la base sin migrar", () => {
  it("base migrada: una sola llamada de 12 argumentos con tokens de cache y razonamiento", async () => {
    const session = new AbortAwareFakeSession(() => undefined);
    await new PostgresLlmUsageRepository(session).recordUsage(EVENT);
    const queries = session.calls.filter((c) => c.startsWith("query:"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("$12");
    expect(session.params[0]!.slice(-2)).toEqual([600, 80]);
    expect(session.aborted).toBe(false);
  });

  it("base SIN migrar (42883): cae a la funcion de 10 argumentos DENTRO de un SAVEPOINT y la sesion queda usable", async () => {
    const session = new AbortAwareFakeSession((sql) => (sql.includes("$12") ? missingFn() : undefined));
    await new PostgresLlmUsageRepository(session).recordUsage(EVENT);
    const queries = session.calls.filter((c) => c.startsWith("query:"));
    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain("$11");
    expect(session.params[1]).toHaveLength(10);
    expect(session.calls.some((c) => c.startsWith("exec:rollback to savepoint"))).toBe(true);
    expect(session.aborted).toBe(false);
  });

  it("sin tokens de cache/razonamiento (proveedor que no los reporta) manda 0", async () => {
    const session = new AbortAwareFakeSession(() => undefined);
    const { tokensCached: _c, tokensReasoning: _r, ...sinTokens } = EVENT;
    await new PostgresLlmUsageRepository(session).recordUsage(sinTokens);
    expect(session.params[0]!.slice(-2)).toEqual([0, 0]);
  });

  it("otro error de Postgres (no 42883) se propaga: nunca enmascara un fallo real", async () => {
    const session = new AbortAwareFakeSession(() => ({ throws: Object.assign(new Error("new row violates check constraint"), { code: "23514" }) }));
    await expect(new PostgresLlmUsageRepository(session).recordUsage(EVENT)).rejects.toThrow(/check constraint/);
    expect(session.aborted).toBe(false);
  });
});
