// Compatibilidad con la base sin migrar (corrección obligatoria de la tarea):
// un mock de TenantDbSession que simula SQLSTATE 42883 (función no existe)
// en la llamada real, y verifica que (a) el método degrada a
// `availability: "not_migrated"` en vez de lanzar/simular éxito, y (b) el
// SAVEPOINT se liberó correctamente -- una query POSTERIOR en la MISMA
// sesión simulada sigue funcionando, prueba real de que la transacción del
// request no quedó abortada (25P02).
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { ImpersonationConflictError, ImpersonationForbiddenError, InMemoryImpersonationRepository, PostgresImpersonationRepository } from "../src/impersonation-repository.ts";

function migrationMissingError(): Error & { code: string } {
  const err = new Error('function core.start_impersonation_session(uuid, uuid, text) does not exist') as Error & { code: string };
  err.code = "42883";
  return err;
}

function abortedTransactionError(): Error & { code: string } {
  const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
  err.code = "25P02";
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

/** Doble de prueba que REPRODUCE la semántica real de una transacción de
 *  Postgres abortada -- mismo patrón EXACTO que
 *  `packages/domain-citas/tests/upsert-customer-savepoint.spec.ts`/
 *  `packages/domain-restaurantes/tests/upsert-customer-savepoint.spec.ts`
 *  (corrección de esta revisión: los tests de arriba usaban un
 *  `vi.fn().mockRejectedValueOnce/mockResolvedValueOnce` plano, que responde
 *  "bien" en la segunda llamada SIN IMPORTAR si el código bajo prueba hizo
 *  `ROLLBACK TO SAVEPOINT` o no -- no distinguiría una implementación
 *  sutilmente incorrecta que se saltara el SAVEPOINT de una correcta). Esta
 *  sesión SÍ lo distingue: una vez que `query()` lanza el error de "función
 *  no existe" queda en estado ABORTADO real -- cualquier `query()` posterior
 *  falla con 25P02 hasta que `exec("ROLLBACK TO SAVEPOINT ...")` la
 *  recupere, exactamente como Postgres real. */
class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  readonly calls: string[] = [];

  async query<T>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.trim().toLowerCase();
    this.calls.push(`query:${normalized.split("\n")[0]}`);
    if (this.aborted) {
      throw abortedTransactionError();
    }
    if (normalized.includes("core.start_impersonation_session")) {
      // Mismo efecto que Postgres real: el SQLSTATE 42883 de la propia query
      // deja la transacción ABORTADA para CUALQUIER consulta posterior
      // (hasta un `ROLLBACK TO SAVEPOINT`), no solo lanza el error al llamador.
      this.aborted = true;
      throw migrationMissingError();
    }
    if (normalized.includes("select 1 as ok")) {
      return { rows: [{ ok: true }] as unknown as T[] };
    }
    throw new Error(`AbortAwareFakeSession: query no soportada: ${sql}`);
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

  it("startSession: con una sesión que REPRODUCE el estado ABORTADO real de Postgres (25P02), el fallback hace SAVEPOINT -> query -> ROLLBACK TO SAVEPOINT -> RELEASE SAVEPOINT en ESE orden exacto, y una query posterior en la MISMA sesión sigue funcionando", async () => {
    const session = new AbortAwareFakeSession();
    const repo = new PostgresImpersonationRepository(session);

    const result = await repo.startSession("caller-1", "org-1", "motivo suficientemente largo para pasar el check");
    expect(result).toEqual({ availability: "not_migrated", session: null });

    // Orden exacto -- no solo "que estén todas", como el test anterior a esta
    // revisión permitía (un `vi.fn()` plano no puede violar el orden porque
    // no ejecuta lógica real; `AbortAwareFakeSession` SÍ lo haría fallar con
    // 25P02 si el código bajo prueba hiciera la query ANTES del SAVEPOINT, o
    // el RELEASE antes del ROLLBACK TO).
    const savepointIdx = session.calls.findIndex((c) => c.startsWith("exec:savepoint"));
    const queryIdx = session.calls.findIndex((c) => c.startsWith("query:"));
    const rollbackIdx = session.calls.findIndex((c) => c.startsWith("exec:rollback to savepoint"));
    const releaseIdx = session.calls.findIndex((c) => c.startsWith("exec:release savepoint"));
    expect(savepointIdx).toBeGreaterThanOrEqual(0);
    expect(savepointIdx).toBeLessThan(queryIdx);
    expect(queryIdx).toBeLessThan(rollbackIdx);
    expect(rollbackIdx).toBeLessThan(releaseIdx);

    // La transacción del request YA NO está abortada -- una query cualquiera
    // posterior en la MISMA sesión (ej. el resto del handler HTTP tras el
    // fallback) tiene que funcionar, no fallar con 25P02.
    const { rows } = await session.query<{ ok: boolean }>("select 1 as ok;");
    expect(rows[0]?.ok).toBe(true);
  });

  it("prueba de que el bug era real: SIN pasar por ROLLBACK TO SAVEPOINT, la misma secuencia de consultas SÍ deriva en 25P02", async () => {
    const session = new AbortAwareFakeSession();
    await expect(
      (async () => {
        try {
          await session.query("select * from core.start_impersonation_session($1, $2, $3);", []);
        } catch {
          // deliberadamente NO se llama a session.exec("ROLLBACK TO SAVEPOINT ...")
          // aquí -- este bloque reproduce el bug (un catch que traga el error
          // de Postgres y sigue usando la misma sesión sin SAVEPOINT).
        }
        return session.query("select 1 as ok;", []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
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

// Mismo defecto que la migración 0022 corrigió en SQL (`core.list_
// impersonation_audit_log_for_superadmin`, `order by occurred_at desc, seq
// desc`) -- este es su equivalente en el repositorio en memoria: sin el
// desempate por `seq`, dos eventos con el MISMO `occurredAtMs` (reloj de
// test congelado, el caso real que produce el empate en Postgres cuando
// `now()` es constante dentro de una transacción) quedaban en el orden que
// `Array.prototype.sort` (estable) heredara de la inserción -- no
// necesariamente "más reciente primero".
describe("InMemoryImpersonationRepository.listAuditLog -- orden total con occurredAtMs empatado", () => {
  it("con 3 eventos en el MISMO instante (reloj de test congelado), el orden es por seq desc -- nunca el orden de inserción sin más", async () => {
    const nowMs = Date.UTC(2026, 8, 19, 12, 0, 0);
    const repo = new InMemoryImpersonationRepository({ now: () => nowMs });
    repo.seedPlatformSuperadmin("superadmin-1", "superadmin-1@example.com");
    repo.seedOrganization("org-1");
    repo.seedOrganization("org-2");
    repo.seedOrganization("org-3");

    // Sin avanzar el reloj entre llamadas -- las 3 sesiones (y sus 6 eventos
    // start/end) comparten EXACTAMENTE el mismo occurredAtMs, igual que
    // varias filas de la misma transacción de Postgres compartirían el mismo
    // `now()`. `startSession` exige "sin sesión activa previa" -- cada una se
    // termina antes de abrir la siguiente, todo en el mismo tick del reloj.
    const s1 = await repo.startSession("superadmin-1", "org-1", "Ticket ORDEN-1: verificar orden total en memoria.");
    await repo.endSession("superadmin-1", s1.session!.id);
    const s2 = await repo.startSession("superadmin-1", "org-2", "Ticket ORDEN-2: verificar orden total en memoria.");
    await repo.endSession("superadmin-1", s2.session!.id);
    const s3 = await repo.startSession("superadmin-1", "org-3", "Ticket ORDEN-3: verificar orden total en memoria.");
    await repo.endSession("superadmin-1", s3.session!.id);

    const { entries } = await repo.listAuditLog("superadmin-1", 500);
    expect(entries.every((e) => e.occurredAtMs === nowMs)).toBe(true); // confirma el empate real
    // "más reciente" = el `seq` más alto, sin importar el orden de inserción.
    expect(entries.map((e) => e.seq)).toEqual([...entries.map((e) => e.seq)].sort((a, b) => b - a));
  });
});
