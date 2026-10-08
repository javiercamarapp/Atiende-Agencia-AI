// Repositorio de hechos del preflight (0057): la lectura corre bajo SAVEPOINT; sin la funcion (base sin migrar) responde `no_migrado` y la
// transaccion sigue viva para la lectura siguiente. Sesion que reproduce el estado ABORTADO real (AbortAwareFakeSession); una plana no sirve.
import { describe, expect, it } from "vitest";
import { InMemoryOrgPreflightRepository, PostgresOrgPreflightRepository } from "../src/index.ts";
import type { OrgPreflightHechos } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const HECHOS: OrgPreflightHechos = { vertical: "citas", restaurantes: null };

describe("PostgresOrgPreflightRepository", () => {
  it("devuelve los hechos que arma la funcion SQL", async () => {
    const session = new AbortAwareFakeSession([{ match: /get_org_preflight_restaurantes_for_superadmin/, respond: () => [{ hechos: HECHOS }] }]);
    await expect(new PostgresOrgPreflightRepository(session).hechos("u1", "o1")).resolves.toEqual({ ok: true, data: HECHOS });
  });

  it("organizacion inexistente: la funcion devuelve NULL y sale data null", async () => {
    const session = new AbortAwareFakeSession([{ match: /get_org_preflight_restaurantes_for_superadmin/, respond: () => [{ hechos: null }] }]);
    await expect(new PostgresOrgPreflightRepository(session).hechos("u1", "o1")).resolves.toEqual({ ok: true, data: null });
  });

  it("MISMA transaccion: la funcion ausente (42883) no tumba la lectura que sigue (SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_org_preflight_restaurantes_for_superadmin/, respond: () => pgError("42883", "function core.get_org_preflight_restaurantes_for_superadmin(uuid, uuid) does not exist") },
      { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
    ]);
    const repo = new PostgresOrgPreflightRepository(session);
    await expect(repo.hechos("u1", "o1")).resolves.toEqual({ ok: false, razon: "no_migrado" });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 (transaccion abortada) y el COMMIT daria ROLLBACK de todo el request.
    await expect(session.query("select 1 as despues")).resolves.toMatchObject({ rows: [{ despues: 1 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(1);
  });

  it("un 42501 (no superadmin) u otro error SQL es `error`, no `no_migrado`", async () => {
    const session = new AbortAwareFakeSession([{ match: /get_org_preflight_restaurantes_for_superadmin/, respond: () => pgError("42501", "acceso denegado") }]);
    await expect(new PostgresOrgPreflightRepository(session).hechos("u1", "o1")).resolves.toEqual({ ok: false, razon: "error" });
  });
});

describe("InMemoryOrgPreflightRepository", () => {
  it("un llamador que no es superadmin recibe error (como el 42501 real); un superadmin ve los hechos sembrados", async () => {
    const repo = new InMemoryOrgPreflightRepository();
    repo.seedOrganizacion("o1", HECHOS);
    repo.seedSuperadmin("sa");
    await expect(repo.hechos("otro", "o1")).resolves.toEqual({ ok: false, razon: "error" });
    await expect(repo.hechos("sa", "o1")).resolves.toEqual({ ok: true, data: HECHOS });
    await expect(repo.hechos("sa", "inexistente")).resolves.toEqual({ ok: true, data: null });
  });
});
