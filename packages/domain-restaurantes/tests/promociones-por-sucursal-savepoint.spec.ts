// REGLA DURA de compatibilidad con la base SIN migrar (migracion 038: `promotions.property_ids`). Mergear despliega el
// codigo y la base va atras: leer el alcance corre DENTRO de la transaccion unica del request (cotizar, crear pedido).
// `AbortAwareFakeSession` reproduce el estado abortado (25P02) de Postgres: cada caso verifica (1) el camino anterior
// (la promocion vale en todas las sucursales, como antes) y (2) que la MISMA sesion sigue utilizable despues.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const T2 = "00000000-0000-4000-8000-0000000000a2";
const T3 = "00000000-0000-4000-8000-0000000000a3";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function sinColumna(columna: string): Error & { code: string } {
  const err = new Error(`column "${columna}" does not exist`) as Error & { code: string };
  err.code = "42703";
  return err;
}
async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

const PROMO = {
  id: "00000000-0000-4000-8000-0000000000d1",
  organization_id: ORG_ID,
  code: "LUNES2X1PM",
  name: "Lunes 2x1",
  description: null,
  type: "bogo",
  value: "1",
  min_order_total: null,
  starts_at: null,
  ends_at: null,
  days_of_week: [1],
  start_time: null,
  end_time: null,
  max_uses: null,
  times_used: 0,
  is_active: true,
  channels: ["recoger"],
  product_ids: ["p1"],
  auto_apply: true,
  courtesy_product_ids: null,
  courtesy_quantity: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

describe("promotions.property_ids (migracion 038)", () => {
  it("base migrada: listAutoApplyPromotions y findPromotionByCode leen el alcance por sucursal", async () => {
    const session = new AbortAwareFakeSession([{ match: /property_ids/i, respond: () => [{ ...PROMO, property_ids: [T2, T3] }] }]);
    const repo = new PostgresRestaurantesRepository(session);
    expect((await repo.listAutoApplyPromotions(ORG_ID))[0]).toMatchObject({ code: "LUNES2X1PM", propertyIds: [T2, T3] });
    expect(await repo.findPromotionByCode(ORG_ID, "LUNES2X1PM")).toMatchObject({ propertyIds: [T2, T3] });
  });

  it("base SIN 038 (con 031): listAutoApplyPromotions cae a la lectura anterior con propertyIds null y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /property_ids/i, respond: () => sinColumna("property_ids") },
      { match: /from restaurantes\.promotions where organization_id = \$1 and auto_apply/i, respond: () => [PROMO] },
      SIGUIENTE,
    ]);
    const [p] = await new PostgresRestaurantesRepository(session).listAutoApplyPromotions(ORG_ID);
    expect(p).toMatchObject({ code: "LUNES2X1PM", autoApply: true, propertyIds: null });
    await sesionSigueViva(session);
  });

  it("base SIN 031 ni 038: listAutoApplyPromotions sigue devolviendo [] (vacio honesto) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /auto_apply|property_ids/i, respond: () => sinColumna("auto_apply") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).listAutoApplyPromotions(ORG_ID)).toEqual([]);
    await sesionSigueViva(session);
  });

  it("base SIN 038: findPromotionByCode cae a las columnas de la 031 y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /property_ids/i, respond: () => sinColumna("property_ids") },
      { match: /from restaurantes\.promotions where/i, respond: () => [PROMO] },
      SIGUIENTE,
    ]);
    expect(await new PostgresRestaurantesRepository(session).findPromotionByCode(ORG_ID, "LUNES2X1PM")).toMatchObject({ code: "LUNES2X1PM", propertyIds: null, autoApply: true });
    await sesionSigueViva(session);
  });

  it("base SIN 038: crear o acotar una promocion CON alcance lanza Unavailable (503), nunca una promocion sin su alcance", async () => {
    const alta = new AbortAwareFakeSession([{ match: /insert into restaurantes\.promotions/i, respond: () => sinColumna("property_ids") }, SIGUIENTE]);
    await expect(
      new PostgresRestaurantesRepository(alta).createPromotion(ORG_ID, { code: "LUNES2X1PM", name: "Lunes", type: "bogo", value: 1, autoApply: true, channels: ["recoger"], productIds: ["p1"], propertyIds: [T2] }),
    ).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(alta);

    const cambio = new AbortAwareFakeSession([{ match: /update restaurantes\.promotions/i, respond: () => sinColumna("property_ids") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(cambio).updatePromotion(ORG_ID, PROMO.id, { propertyIds: [T2] })).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(cambio);
  });

  it("base migrada: crear y acotar mandan property_ids como uuid[]", async () => {
    const consultas: Array<{ sql: string; params: unknown[] }> = [];
    const session = new AbortAwareFakeSession([
      {
        match: /restaurantes\.promotions/i,
        respond: () => [{ ...PROMO, property_ids: [T2] }],
      },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      consultas.push({ sql, params: params ?? [] });
      return original(sql, params);
    }) as typeof session.query;
    const repo = new PostgresRestaurantesRepository(session);
    const creada = await repo.createPromotion(ORG_ID, { code: "LUNES2X1PM", name: "Lunes", type: "bogo", value: 1, autoApply: true, channels: ["recoger"], productIds: ["p1"], propertyIds: [T2] });
    expect(creada.propertyIds).toEqual([T2]);
    expect(consultas[0]!.sql).toMatch(/property_ids\)\s+values/);
    expect(consultas[0]!.params.at(-1)).toEqual([T2]);
    await repo.updatePromotion(ORG_ID, PROMO.id, { propertyIds: null });
    expect(consultas[1]!.sql).toMatch(/property_ids = \$33::uuid\[\]/);
    expect(consultas[1]!.params.at(-1)).toBeNull();
  });
});
