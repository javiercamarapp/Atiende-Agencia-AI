// REGLA DURA de compatibilidad con la base SIN migrar (migracion 057): la politica de sucursal se lee dentro de
// la transaccion unica de un request. Contra una base sin las columnas nuevas (42703) la lectura cae a las
// columnas de 023 SIN perder horario ni minimos, y la sesion sigue viva (AbortAwareFakeSession reproduce 25P02).
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const PROPERTY_ID = "00000000-0000-4000-8000-0000000000a1";
const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const HORARIO = [{ dias: [1, 2], abre: "12:00", cierra: "22:00" }];

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("findBranchPolicy con la migracion 057", () => {
  it("lee las columnas nuevas y entiende smallint[] como arreglo o como literal", async () => {
    const fila = { horario: HORARIO, pedido_minimo_domicilio: "200", pedido_minimo_recoger: null, propina_politica: null, visible_en_directorio: true, acepta_domicilio: true, de_temporada: true };
    const a = new AbortAwareFakeSession([{ match: /dias_domicilio/, respond: () => [{ ...fila, dias_domicilio: [5, 6, 0] }] }]);
    expect(await new PostgresRestaurantesRepository(a).findBranchPolicy(PROPERTY_ID)).toMatchObject({ visibleEnDirectorio: true, aceptaDomicilio: true, diasDomicilio: [0, 5, 6], deTemporada: true, pedidoMinimoDomicilio: 200 });
    const b = new AbortAwareFakeSession([{ match: /dias_domicilio/, respond: () => [{ ...fila, dias_domicilio: "{5,6}" }] }]);
    expect((await new PostgresRestaurantesRepository(b).findBranchPolicy(PROPERTY_ID)).diasDomicilio).toEqual([5, 6]);
  });

  it("base SIN la 057 (42703): cae a la politica de 023 sin perder horario ni minimos, y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /dias_domicilio/, respond: () => pgError("42703", 'column "dias_domicilio" does not exist') },
      { match: /from restaurantes\.branch_policy where property_id/, respond: () => [{ horario: HORARIO, pedido_minimo_domicilio: "150", pedido_minimo_recoger: null, propina_politica: "solo_tarjeta" }] },
      SIGUIENTE,
    ]);
    const policy = await new PostgresRestaurantesRepository(session).findBranchPolicy(PROPERTY_ID);
    expect(policy).toMatchObject({ horario: HORARIO, pedidoMinimoDomicilio: 150, propinaPolitica: "solo_tarjeta", aceptaDomicilio: true, diasDomicilio: null, visibleEnDirectorio: null });
    await sesionSigueViva(session);
  });

  it("un error que NO es de base sin migrar (40001) se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /dias_domicilio/, respond: () => pgError("40001", "serialization failure") }]);
    await expect(new PostgresRestaurantesRepository(session).findBranchPolicy(PROPERTY_ID)).rejects.toMatchObject({ code: "40001" });
  });
});

describe("upsertBranchPolicy con la migracion 057", () => {
  const base = { horario: HORARIO, pedidoMinimoDomicilio: 100, pedidoMinimoRecoger: null, propinaPolitica: null } as const;

  it("base SIN la 057 y politica solo con campos de 023: se guarda con el SQL anterior", async () => {
    const session = new AbortAwareFakeSession([
      { match: /dias_domicilio/, respond: () => pgError("42703", 'column "dias_domicilio" of relation "branch_policy" does not exist') },
      { match: /insert into restaurantes\.branch_policy/, respond: () => [{ horario: HORARIO, pedido_minimo_domicilio: "100", pedido_minimo_recoger: null, propina_politica: null }] },
      SIGUIENTE,
    ]);
    const guardada = await new PostgresRestaurantesRepository(session).upsertBranchPolicy(ORG_ID, PROPERTY_ID, base);
    expect(guardada.pedidoMinimoDomicilio).toBe(100);
    await sesionSigueViva(session);
  });

  it("base SIN la 057 y una restriccion de domicilio: NO se descarta en silencio, la configuracion no esta disponible aun", async () => {
    const session = new AbortAwareFakeSession([{ match: /dias_domicilio/, respond: () => pgError("42703", "column does not exist") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).upsertBranchPolicy(ORG_ID, PROPERTY_ID, { ...base, diasDomicilio: [5, 6, 0] })).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });

  it("con la 057 aplicada escribe los cuatro campos nuevos (dias como literal de arreglo)", async () => {
    let params: unknown[] = [];
    const session = new AbortAwareFakeSession([
      {
        match: /insert into restaurantes\.branch_policy/,
        respond: () => [{ horario: HORARIO, pedido_minimo_domicilio: "100", pedido_minimo_recoger: null, propina_politica: null, visible_en_directorio: true, acepta_domicilio: false, dias_domicilio: null, de_temporada: true }],
      },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      params = p ?? [];
      return original(sql, p);
    }) as typeof session.query;
    const g = await new PostgresRestaurantesRepository(session).upsertBranchPolicy(ORG_ID, PROPERTY_ID, { ...base, visibleEnDirectorio: true, aceptaDomicilio: false, diasDomicilio: [5, 6, 0], deTemporada: true });
    expect(params.slice(6)).toEqual([true, false, "{5,6,0}", true]);
    expect(g).toMatchObject({ visibleEnDirectorio: true, aceptaDomicilio: false, deTemporada: true });
  });
});
