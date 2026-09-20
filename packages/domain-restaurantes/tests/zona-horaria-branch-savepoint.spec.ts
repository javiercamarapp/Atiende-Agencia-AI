// FASE 3 (producto) — zona horaria por negocio (migración 022,
// `restaurantes.branch_detail.zona_horaria`). `findBranchZonaHoraria` corre
// SIEMPRE dentro de la transacción de `prepareCreateOrder` (que sigue con el
// INSERT del pedido después) cuando hay un `promoCode` -- REGLA DURA de
// compatibilidad del repo: un `try/catch` simple sobre 42703 dejaría la
// transacción ABORTADA (25P02) para esas queries posteriores.
// `AbortAwareFakeSession` (mismo doble que `config-editable-savepoint.spec.ts`,
// leído primero como plantilla) reproduce ese estado real de Postgres.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PROPERTY_ID = "00000000-0000-0000-0000-0000000000p1";

const SELECT_RE = /select zona_horaria from restaurantes\.branch_detail where property_id = \$1/i;
const UPDATE_RE = /update restaurantes\.branch_detail set zona_horaria/i;

function undefinedColumnError(): Error & { code: string } {
  const err = new Error('column "zona_horaria" does not exist') as Error & { code: string };
  err.code = "42703";
  return err;
}

describe("PostgresRestaurantesRepository.findBranchZonaHoraria", () => {
  it("columna configurada -- devuelve la zona real", async () => {
    const session = new AbortAwareFakeSession([{ match: SELECT_RE, respond: () => [{ zona_horaria: "America/Tijuana" }] }]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.findBranchZonaHoraria(PROPERTY_ID)).toEqual({ zonaHoraria: "America/Tijuana" });
  });

  it("columna NULL (sucursal nunca configuró zona horaria) -- null, nunca un error", async () => {
    const session = new AbortAwareFakeSession([{ match: SELECT_RE, respond: () => [{ zona_horaria: null }] }]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.findBranchZonaHoraria(PROPERTY_ID)).toEqual({ zonaHoraria: null });
  });

  it("REGLA DURA de compatibilidad (42703, migración 022 sin aplicar) -- degrada a null, el SAVEPOINT recupera la sesión para el INSERT del pedido que sigue", async () => {
    const session = new AbortAwareFakeSession([
      { match: SELECT_RE, respond: () => undefinedColumnError() },
      { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    expect(await repo.findBranchZonaHoraria(PROPERTY_ID)).toEqual({ zonaHoraria: null });
    // La prueba real del SAVEPOINT: `prepareCreateOrder` sigue con el INSERT del
    // pedido en la MISMA sesión después de resolver la zona horaria -- eso
    // resuelve en vez de lanzar 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("cualquier otro error de Postgres (nunca 42501/42883/42P01/42703) se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: SELECT_RE,
        respond: () => {
          const err = new Error("connection terminated") as Error & { code: string };
          err.code = "57P01";
          return err;
        },
      },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    await expect(repo.findBranchZonaHoraria(PROPERTY_ID)).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("PostgresRestaurantesRepository.upsertBranchZonaHoraria", () => {
  it("UPDATE real (la fila de branch_detail siempre existe) -- devuelve la zona persistida", async () => {
    const session = new AbortAwareFakeSession([{ match: UPDATE_RE, respond: () => [{ zona_horaria: "America/Hermosillo" }] }]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.upsertBranchZonaHoraria(PROPERTY_ID, "America/Hermosillo")).toEqual({ zonaHoraria: "America/Hermosillo" });
  });

  it("zonaHoraria: null -- borra la configuración explícita", async () => {
    const session = new AbortAwareFakeSession([{ match: UPDATE_RE, respond: () => [{ zona_horaria: null }] }]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.upsertBranchZonaHoraria(PROPERTY_ID, null)).toEqual({ zonaHoraria: null });
  });

  it("REGLA DURA de compatibilidad (42703, migración 022 sin aplicar) -- RestaurantesConfigUnavailableError (503 honesto), el SAVEPOINT recupera la sesión", async () => {
    const session = new AbortAwareFakeSession([
      { match: UPDATE_RE, respond: () => undefinedColumnError() },
      { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    await expect(repo.upsertBranchZonaHoraria(PROPERTY_ID, "America/Mazatlan")).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("cualquier otro error de Postgres se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: UPDATE_RE,
        respond: () => {
          const err = new Error('new row for relation "branch_detail" violates check constraint') as Error & { code: string };
          err.code = "23514";
          return err;
        },
      },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    await expect(repo.upsertBranchZonaHoraria(PROPERTY_ID, "")).rejects.toMatchObject({ code: "23514" });
  });
});
