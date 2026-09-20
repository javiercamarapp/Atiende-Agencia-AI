// Compatibilidad con la base sin migrar + best-effort real de `recordDenial`
// (mandato de la tarea: "registrar la denegación NUNCA debe cambiar la
// respuesta ni tumbar el request") -- mismo patrón `AbortAwareFakeSession` que
// packages/db/tests/impersonation-repository.spec.ts (reproduce el estado
// ABORTADO real de una transacción de Postgres, no un mock plano que no
// distinguiría un SAVEPOINT saltado).
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryAuthzAuditRepository, PostgresAuthzAuditRepository } from "../src/authz-audit-repository.ts";
import type { AuthzAuditLogEntryInput } from "../src/authz-audit-repository.ts";

function migrationMissingError(): Error & { code: string } {
  const err = new Error("function core.record_authz_audit_denial(...) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

function abortedTransactionError(): Error & { code: string } {
  const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
  err.code = "25P02";
  return err;
}

/** Reproduce el estado ABORTADO real de Postgres tras un SQLSTATE dentro del
 *  SAVEPOINT: cualquier `query()` posterior falla con 25P02 hasta que
 *  `exec("ROLLBACK TO SAVEPOINT ...")` la recupere -- una sesión falsa plana
 *  (`vi.fn().mockRejectedValueOnce/mockResolvedValueOnce`) NO distinguiría una
 *  implementación que se saltara el `ROLLBACK TO SAVEPOINT`. */
class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  readonly calls: string[] = [];
  constructor(
    private readonly onQuery: (sql: string, params: unknown[] | undefined) => { rows: unknown[] } | { throws: Error },
  ) {}

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.trim().toLowerCase();
    this.calls.push(`query:${normalized.split("\n")[0]}`);
    if (this.aborted) throw abortedTransactionError();
    const result = this.onQuery(sql, params);
    if ("throws" in result) {
      this.aborted = true;
      throw result.throws;
    }
    return { rows: result.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    const normalized = sql.trim().toLowerCase();
    this.calls.push(`exec:${normalized}`);
    if (normalized.startsWith("savepoint")) return;
    if (normalized.startsWith("rollback to savepoint")) {
      this.aborted = false;
      return;
    }
    if (normalized.startsWith("release savepoint")) return;
    throw new Error(`AbortAwareFakeSession: exec no soportado: ${sql}`);
  }
}

const ENTRADA_BASE: AuthzAuditLogEntryInput = {
  actorUserId: "staff-1",
  actorIp: "203.0.113.7",
  organizationId: null,
  action: "admin:access",
  route: "/superadmin/impersonacion/sesiones",
  method: "POST",
  decision: "denied",
  reason: "no_membership",
  metadata: { platformRole: null, allowedRoles: ["owner"] },
  occurredAtMs: Date.UTC(2026, 8, 19, 12, 0, 0),
};

describe("PostgresAuthzAuditRepository.recordDenial", () => {
  it("camino feliz -- inserta y libera el SAVEPOINT (nunca lo deja abierto)", async () => {
    const session = new AbortAwareFakeSession((sql) => {
      if (sql.includes("core.record_authz_audit_denial")) return { rows: [{ id: "row-1" }] };
      throw new Error(`query inesperada: ${sql}`);
    });
    const repo = new PostgresAuthzAuditRepository(session);

    const result = await repo.recordDenial(ENTRADA_BASE);

    expect(result).toEqual({ availability: "available", id: "row-1" });
    expect(session.calls).toEqual([
      "exec:savepoint sp_record_authz_audit_denial",
      "query:select core.record_authz_audit_denial($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as id;",
      "exec:release savepoint sp_record_authz_audit_denial",
    ]);
  });

  it("migración 0021 no aplicada (42883) -- degrada a not_migrated/id null, SAVEPOINT recuperado (la sesión sigue usable después)", async () => {
    const session = new AbortAwareFakeSession((sql) => {
      if (sql.includes("core.record_authz_audit_denial")) return { throws: migrationMissingError() };
      if (sql.includes("select 1 as ok")) return { rows: [{ ok: true }] };
      throw new Error(`query inesperada: ${sql}`);
    });
    const repo = new PostgresAuthzAuditRepository(session);

    const result = await repo.recordDenial(ENTRADA_BASE);
    expect(result).toEqual({ availability: "not_migrated", id: null });

    // Prueba real de que el ROLLBACK TO SAVEPOINT corrió: una query posterior
    // en la MISMA sesión funciona, no 25P02.
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls).toContain("exec:rollback to savepoint sp_record_authz_audit_denial");
  });

  it("cualquier OTRO error real de Postgres (ej. tope defensivo / conexión) -- NUNCA lanza, degrada a id:null, SAVEPOINT recuperado", async () => {
    const errorInesperado = Object.assign(new Error("connection terminated unexpectedly"), { code: "57P01" });
    const session = new AbortAwareFakeSession((sql) => {
      if (sql.includes("core.record_authz_audit_denial")) return { throws: errorInesperado };
      throw new Error(`query inesperada: ${sql}`);
    });
    const repo = new PostgresAuthzAuditRepository(session);

    // El mandato de la tarea es literal: "registrar la denegación NUNCA debe
    // cambiar la respuesta ni tumbar el request" -- por eso este `await`
    // NUNCA debe rechazar, sin importar el error real.
    const result = await repo.recordDenial(ENTRADA_BASE);
    expect(result).toEqual({ availability: "available", id: null });
    expect(session.calls).toContain("exec:rollback to savepoint sp_record_authz_audit_denial");
    expect(session.calls).toContain("exec:release savepoint sp_record_authz_audit_denial");
  });
});

describe("PostgresAuthzAuditRepository.list", () => {
  function filaCruda(id: string, occurredAt: string) {
    return {
      id,
      actor_user_id: "staff-1",
      actor_ip: "203.0.113.7",
      organization_id: null,
      action: "admin:access",
      route: "/superadmin/impersonacion/sesiones",
      method: "POST",
      decision: "denied" as const,
      reason: "no_membership" as const,
      metadata: {},
      occurred_at: occurredAt,
    };
  }

  it("camino feliz -- hasMore:false cuando la página trae menos filas que el límite", async () => {
    const session = new AbortAwareFakeSession((sql) => {
      if (sql.includes("core.list_authz_audit_log_for_superadmin")) return { rows: [filaCruda("a", "2026-09-19T12:00:00Z")] };
      throw new Error(`query inesperada: ${sql}`);
    });
    const repo = new PostgresAuthzAuditRepository(session);

    const result = await repo.list("superadmin-1", 50, 0);
    expect(result.availability).toBe("available");
    expect(result.hasMore).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe("a");
  });

  it("hasMore:true cuando el 'peek' (limit+1) trae una fila de más -- esa fila NUNCA se devuelve al llamador", async () => {
    const session = new AbortAwareFakeSession((sql, params) => {
      if (sql.includes("core.list_authz_audit_log_for_superadmin")) {
        expect(params).toEqual(["superadmin-1", 3, 0]); // limit(2)+1
        return { rows: [filaCruda("a", "2026-09-19T12:02:00Z"), filaCruda("b", "2026-09-19T12:01:00Z"), filaCruda("c", "2026-09-19T12:00:00Z")] };
      }
      throw new Error(`query inesperada: ${sql}`);
    });
    const repo = new PostgresAuthzAuditRepository(session);

    const result = await repo.list("superadmin-1", 2, 0);
    expect(result.hasMore).toBe(true);
    expect(result.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("hasMore:true en el caso límite duro limit===200 -- el 'peek' pide 201 (migración 0022) y SÍ detecta la fila 201+, sin subir el máximo expuesto a 200", async () => {
    const filas201 = Array.from({ length: 201 }, (_, i) => filaCruda(`row-${i}`, `2026-09-19T12:${String(i).padStart(2, "0")}:00Z`));
    const session = new AbortAwareFakeSession((sql, params) => {
      if (sql.includes("core.list_authz_audit_log_for_superadmin")) {
        // Antes de la migración 0022, este repositorio pedía como máximo 200
        // (el mismo tope duro que la función SQL aplicaba) -- así que el
        // "peek" quedaba deshabilitado exactamente en este caso límite. Este
        // assert es el regression guard: sin el fix, `params` sería
        // `["superadmin-1", 200, 0]` (limit sin +1) y esta prueba fallaría.
        expect(params).toEqual(["superadmin-1", 201, 0]);
        return { rows: filas201 };
      }
      throw new Error(`query inesperada: ${sql}`);
    });
    const repo = new PostgresAuthzAuditRepository(session);

    const result = await repo.list("superadmin-1", 200, 0);
    expect(result.hasMore).toBe(true);
    expect(result.entries).toHaveLength(200); // nunca se expone la fila 201 al llamador
  });

  it("migración 0021 no aplicada (42P01) -- degrada a not_migrated/lista vacía, SAVEPOINT recuperado", async () => {
    const err = Object.assign(new Error("relation core.authz_audit_log does not exist"), { code: "42P01" });
    const session = new AbortAwareFakeSession((sql) => {
      if (sql.includes("core.list_authz_audit_log_for_superadmin")) return { throws: err };
      throw new Error(`query inesperada: ${sql}`);
    });
    const repo = new PostgresAuthzAuditRepository(session);

    const result = await repo.list("superadmin-1");
    expect(result).toEqual({ availability: "not_migrated", entries: [], hasMore: false });
  });

  it("un error real DISTINTO de migración-faltante SÍ se relanza (a diferencia de recordDenial -- una lectura GET explícita puede fallar visiblemente)", async () => {
    const err = Object.assign(new Error("permission denied for function"), { code: "42501" });
    const session = new AbortAwareFakeSession((sql) => {
      if (sql.includes("core.list_authz_audit_log_for_superadmin")) return { throws: err };
      throw new Error(`query inesperada: ${sql}`);
    });
    const repo = new PostgresAuthzAuditRepository(session);

    await expect(repo.list("superadmin-1")).rejects.toBe(err);
  });
});

describe("InMemoryAuthzAuditRepository", () => {
  it("recordDenial + list -- orden más reciente primero, paginado con hasMore", async () => {
    const repo = new InMemoryAuthzAuditRepository();
    await repo.recordDenial({ ...ENTRADA_BASE, route: "/superadmin/a" });
    await repo.recordDenial({ ...ENTRADA_BASE, route: "/superadmin/b" });
    await repo.recordDenial({ ...ENTRADA_BASE, route: "/superadmin/c" });

    const primeraPagina = await repo.list("superadmin-1", 2, 0);
    expect(primeraPagina.entries.map((e) => e.route)).toEqual(["/superadmin/c", "/superadmin/b"]);
    expect(primeraPagina.hasMore).toBe(true);

    const segundaPagina = await repo.list("superadmin-1", 2, 2);
    expect(segundaPagina.entries.map((e) => e.route)).toEqual(["/superadmin/a"]);
    expect(segundaPagina.hasMore).toBe(false);
  });
});
