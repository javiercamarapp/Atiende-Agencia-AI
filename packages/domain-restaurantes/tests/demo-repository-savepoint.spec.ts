// REGLA DURA de compatibilidad con la base SIN migrar (migracion 037, marca demo): la lectura corre dentro de la
// transaccion unica del request. Un 42P01/42703/42883/42501 sin SAVEPOINT la dejaria abortada (25P02).
// `AbortAwareFakeSession` reproduce ese estado; cada caso verifica el camino anterior ("no es demo") y que la MISMA
// sesion sigue viva para la siguiente consulta del request.
import { describe, expect, it } from "vitest";
import { PostgresDemoRepository } from "../src/demo/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const LEER = /from restaurantes\.demo_organization/i;
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("PostgresDemoRepository.findDemoOrganization", () => {
  it("lee la marca (organizacion demo activa)", async () => {
    const session = new AbortAwareFakeSession([{ match: LEER, respond: () => [{ organization_id: ORG_ID, seed_version: "pm-1", activo: true }] }]);
    expect(await new PostgresDemoRepository(session).findDemoOrganization(ORG_ID)).toEqual({ organizationId: ORG_ID, seedVersion: "pm-1", activo: true });
  });

  it("sin fila: null (organizacion real)", async () => {
    const session = new AbortAwareFakeSession([{ match: LEER, respond: () => [] }]);
    expect(await new PostgresDemoRepository(session).findDemoOrganization(ORG_ID)).toBeNull();
  });

  it.each([
    ["42P01", "tabla inexistente"],
    ["42703", "columna inexistente"],
    ["42883", "funcion inexistente"],
    ["42501", "permiso denegado"],
  ])("base sin migrar (%s): null y la sesion sigue viva (SAVEPOINT)", async (code, msg) => {
    const session = new AbortAwareFakeSession([{ match: LEER, respond: () => pgError(code, msg) }, SIGUIENTE]);
    expect(await new PostgresDemoRepository(session).findDemoOrganization(ORG_ID)).toBeNull();
    await sesionSigueViva(session);
  });

  it("un error que NO es de base sin migrar se propaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: LEER, respond: () => pgError("57014", "statement timeout") }, SIGUIENTE]);
    await expect(new PostgresDemoRepository(session).findDemoOrganization(ORG_ID)).rejects.toMatchObject({ code: "57014" });
  });
});
