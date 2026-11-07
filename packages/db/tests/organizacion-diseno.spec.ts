// Migracion 0060 (core.organization.diseno): lectura del diseno por organizacion. Contra la base sin migrar (42703) cae a un mapa vacio
// dentro de un SAVEPOINT (la transaccion compartida sigue usable); un error que no es de migracion pendiente se propaga.
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "../src/in-memory-core-repository.ts";
import { PostgresCoreRepository } from "../src/postgres-core-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_DS3 = "f838fd2c-0000-4000-8000-000000000001";
const ORG_ACTUAL = "f838fd2c-0000-4000-8000-000000000002";

function errorCodigo(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("PostgresCoreRepository.findDisenoPorOrganizacion", () => {
  it("devuelve solo las organizaciones con diseno", async () => {
    const session = new AbortAwareFakeSession([{ match: /from core\.organization/, respond: () => [{ id: ORG_DS3, diseno: "ds3" }] }]);
    const mapa = await new PostgresCoreRepository(session).findDisenoPorOrganizacion([ORG_DS3, ORG_ACTUAL]);
    expect([...mapa]).toEqual([[ORG_DS3, "ds3"]]);
  });

  it("sin organizaciones no consulta nada", async () => {
    const session = new AbortAwareFakeSession([]);
    expect((await new PostgresCoreRepository(session).findDisenoPorOrganizacion([])).size).toBe(0);
    expect(session.calls).toEqual([]);
  });

  it("base sin migrar (42703): mapa vacio, ROLLBACK TO SAVEPOINT y la transaccion sigue usable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from core\.organization/, respond: () => errorCodigo("42703", 'column "diseno" does not exist') },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const mapa = await new PostgresCoreRepository(session).findDisenoPorOrganizacion([ORG_DS3]);
    expect(mapa.size).toBe(0);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("un error que no es de migracion pendiente se propaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from core\.organization/, respond: () => errorCodigo("42501", "permission denied") }]);
    await expect(new PostgresCoreRepository(session).findDisenoPorOrganizacion([ORG_DS3])).rejects.toThrow(/permission denied/);
  });
});

describe("InMemoryCoreRepository.findDisenoPorOrganizacion", () => {
  it("lee el diseno sembrado y omite las organizaciones sin valor o inexistentes", async () => {
    const repo = new InMemoryCoreRepository();
    repo.addOrganization({ id: ORG_DS3, slug: "pm", name: "PM", vertical: "restaurantes", diseno: "ds3" });
    repo.addOrganization({ id: ORG_ACTUAL, slug: "otra", name: "Otra", vertical: "restaurantes" });
    const mapa = await repo.findDisenoPorOrganizacion([ORG_DS3, ORG_ACTUAL, "no-existe"]);
    expect([...mapa]).toEqual([[ORG_DS3, "ds3"]]);
  });
});
