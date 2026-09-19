// Compatibilidad con la base sin migrar (corrección obligatoria de la tarea):
// un mock de TenantDbSession que simula SQLSTATE 42883 (función no existe)
// en la llamada real, y verifica que (a) el método degrada a
// `availability: "not_migrated"` en vez de lanzar/simular éxito, y (b) el
// SAVEPOINT se liberó correctamente -- una query POSTERIOR en la MISMA
// sesión simulada sigue funcionando, prueba real de que la transacción del
// request no quedó abortada (25P02).
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { ImpersonationConflictError, ImpersonationForbiddenError, PostgresImpersonationRepository } from "../src/impersonation-repository.ts";

function migrationMissingError(): Error & { code: string } {
  const err = new Error('function core.start_impersonation_session(uuid, uuid, text) does not exist') as Error & { code: string };
  err.code = "42883";
  return err;
}

function businessError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Sesión falsa que registra CADA comando `exec` (para verificar el ciclo
 *  SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE SAVEPOINT exacto) y permite
 *  programar qué devuelve/lanza cada `query` en orden. */
function fakeSession(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  const execCalls: string[] = [];
  const session: TenantDbSession = {
    query: queryImpl as never,
    exec: async (sql: string) => {
      execCalls.push(sql.trim().split(" ")[0]! + " " + (sql.includes("RELEASE") ? "RELEASE" : sql.includes("ROLLBACK") ? "ROLLBACK" : ""));
      execCalls.push(sql);
    },
  };
  return { session, execCalls };
}

describe("PostgresImpersonationRepository -- fallback SQLSTATE 42883/42P01/42703", () => {
  it("startSession: degrada a not_migrated (nunca lanza, nunca simula éxito) y libera el SAVEPOINT", async () => {
    const query = vi.fn().mockRejectedValueOnce(migrationMissingError());
    const { session, execCalls } = fakeSession(query);
    const repo = new PostgresImpersonationRepository(session);

    const result = await repo.startSession("caller-1", "org-1", "motivo suficientemente largo para pasar el check");

    expect(result).toEqual({ availability: "not_migrated", session: null });
    // SAVEPOINT abierto, luego ROLLBACK TO + RELEASE (nunca solo RELEASE sin rollback).
    expect(execCalls.some((s) => s.startsWith("SAVEPOINT"))).toBe(true);
    expect(execCalls.some((s) => s.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);
    expect(execCalls.some((s) => s.startsWith("RELEASE SAVEPOINT"))).toBe(true);
  });

  it("startSession: una query POSTERIOR en la MISMA sesión sigue funcionando tras el fallback (prueba real del SAVEPOINT)", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(migrationMissingError())
      .mockResolvedValueOnce({ rows: [{ ok: true }] });
    const { session } = fakeSession(query);
    const repo = new PostgresImpersonationRepository(session);

    const first = await repo.startSession("caller-1", "org-1", "motivo suficientemente largo para pasar el check");
    expect(first.availability).toBe("not_migrated");

    // Si el SAVEPOINT no se hubiera liberado bien, esta segunda query fallaría
    // con 25P02 ("current transaction is aborted") -- aquí se resuelve porque
    // el mock la programó para responder distinto la segunda vez.
    const { rows } = await session.query<{ ok: boolean }>("select 1 as ok;");
    expect(rows[0]?.ok).toBe(true);
  });

  it("getActiveSession/listSessions/listAuditLog: degradan a vacío/null (lectura), nunca lanzan", async () => {
    const activeQuery = vi.fn().mockRejectedValueOnce(migrationMissingError());
    const repoActive = new PostgresImpersonationRepository(fakeSession(activeQuery).session);
    expect(await repoActive.getActiveSession("caller-1")).toEqual({ availability: "not_migrated", session: null });

    const listQuery = vi.fn().mockRejectedValueOnce(migrationMissingError());
    const repoList = new PostgresImpersonationRepository(fakeSession(listQuery).session);
    expect(await repoList.listSessions("caller-1")).toEqual({ availability: "not_migrated", sessions: [] });

    const auditQuery = vi.fn().mockRejectedValueOnce(migrationMissingError());
    const repoAudit = new PostgresImpersonationRepository(fakeSession(auditQuery).session);
    expect(await repoAudit.listAuditLog("caller-1")).toEqual({ availability: "not_migrated", entries: [] });
  });

  it("isActiveForOrganization: degrada a false (nunca lanza) cuando la función no existe", async () => {
    const query = vi.fn().mockRejectedValueOnce(migrationMissingError());
    const repo = new PostgresImpersonationRepository(fakeSession(query).session);
    expect(await repo.isActiveForOrganization("caller-1", "org-1")).toBe(false);
  });

  it("un error de NEGOCIO real (42501/55006) se traduce a la excepción tipada y SÍ se propaga (no es un fallback de compatibilidad)", async () => {
    const forbiddenQuery = vi.fn().mockRejectedValueOnce(businessError("42501", "solo un superadmin de plataforma real puede iniciar una impersonación"));
    const repoForbidden = new PostgresImpersonationRepository(fakeSession(forbiddenQuery).session);
    await expect(repoForbidden.startSession("caller-1", "org-1", "motivo suficientemente largo para pasar el check")).rejects.toBeInstanceOf(
      ImpersonationForbiddenError,
    );

    const conflictQuery = vi.fn().mockRejectedValueOnce(businessError("55006", "ya existe una sesión de impersonación activa"));
    const repoConflict = new PostgresImpersonationRepository(fakeSession(conflictQuery).session);
    await expect(repoConflict.startSession("caller-1", "org-1", "motivo suficientemente largo para pasar el check")).rejects.toBeInstanceOf(
      ImpersonationConflictError,
    );
  });
});
