// FASE 3 (producto, restaurantes) — regresión de `PostgresCoreRepository.
// removeMembership` (ver `migrations/0022_remove_membership.sql` y el comentario de
// cabecera de este método en `../src/postgres-core-repository.ts`). Mismo criterio
// EXACTO que `postgres-core-repository-org-admin-fallback.spec.ts`: un doble de
// prueba que SÍ reproduce la semántica de aborto de transacción real de Postgres
// (`AbortAwareFakeSession`), nunca uno plano.
//
// Dos escenarios reales que este archivo cubre:
//   1. La función SQL existe -> camino feliz, DELETE real (en producción, sobre
//      `core.membership`).
//   2. La función SQL todavía no existe (SQLSTATE 42883, base real sin migrar) ->
//      `MembershipRemovalUnavailableError` (nunca un 500, ver REGLA DURA de
//      compatibilidad de AGENTS.md), Y la transacción queda recuperada (SAVEPOINT)
//      para la query siguiente del request (el resto del handler / el commit final).
import { describe, expect, it } from "vitest";
import { MembershipRemovalError, MembershipRemovalUnavailableError } from "../src/core-repository.ts";
import { PostgresCoreRepository } from "../src/postgres-core-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-0000-0000-0000000000aa";
const TARGET_ID = "00000000-0000-0000-0000-0000000000bb";

function undefinedFunctionError(): Error & { code: string } {
  const err = new Error("function core.remove_membership(uuid, uuid) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

function p0001Error(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = "P0001";
  return err;
}

describe("PostgresCoreRepository.removeMembership — camino feliz", () => {
  it("función existente: DELETE real, sin lanzar", async () => {
    const session = new AbortAwareFakeSession([{ match: /select core\.remove_membership/, respond: () => [] }]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.removeMembership(ORG_ID, TARGET_ID)).resolves.toBeUndefined();
    expect(session.calls).toContain("select core.remove_membership($1, $2);");
  });

  it("rechazo real de la función SQL (P0001, ej. 'no puedes darte de baja a ti mismo') -> MembershipRemovalError, transacción recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select core\.remove_membership/, respond: () => p0001Error("no puedes darte de baja a ti mismo") },
      { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.removeMembership(ORG_ID, TARGET_ID)).rejects.toBeInstanceOf(MembershipRemovalError);
    await expect(repo.removeMembership(ORG_ID, TARGET_ID)).rejects.toThrow("no puedes darte de baja a ti mismo");

    // La transacción quedó recuperada -- una query posterior (el resto del handler)
    // NO ve 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});

describe("PostgresCoreRepository.removeMembership — fallback SQLSTATE 42883 (base real sin migrar)", () => {
  it("función todavía no existe -> MembershipRemovalUnavailableError (nunca un 500), transacción recuperada para la query siguiente", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select core\.remove_membership/, respond: () => undefinedFunctionError() },
      { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.removeMembership(ORG_ID, TARGET_ID)).rejects.toBeInstanceOf(MembershipRemovalUnavailableError);

    expect(session.calls).toContain("savepoint sp_core_remove_membership");
    expect(session.calls).toContain("rollback to savepoint sp_core_remove_membership");
    expect(session.calls).toContain("release savepoint sp_core_remove_membership");

    // La transacción quedó recuperada -- una query posterior (el resto del handler /
    // el commit final del request) NO ve 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("sin el SAVEPOINT, la misma secuencia SÍ deriva en 25P02 (prueba de que el bug sería real)", async () => {
    const session = new AbortAwareFakeSession([{ match: /select core\.remove_membership/, respond: () => undefinedFunctionError() }]);
    await expect(
      (async () => {
        try {
          await session.query("select core.remove_membership($1, $2);", []);
        } catch {
          // el código sin SAVEPOINT no hacía nada aquí -- solo dejaba la sesión abortada.
        }
        return session.query("select 1 as siguiente_query_del_request;");
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
