// REGLA DURA de compatibilidad con la base SIN migrar (migracion 027, promociones 2x1/canal):
// mergear despliega el codigo al instante y la migracion NO se aplica sola. Leer promociones (p. ej.
// resolver el codigo de un pedido) corre DENTRO de la transaccion unica del request: un 42703 sin
// SAVEPOINT dejaria la transaccion abortada (25P02). `AbortAwareFakeSession` reproduce ese estado.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROMO_ID = "00000000-0000-4000-8000-0000000000c1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function sinColumna(columna: string): Error & { code: string } {
  const err = new Error(`column "${columna}" does not exist`) as Error & { code: string };
  err.code = "42703";
  return err;
}

const FILA_VIEJA = {
  id: PROMO_ID,
  organization_id: ORG,
  code: "LUNES",
  name: "Lunes",
  description: null,
  type: "percentage",
  value: "10.00",
  min_order_total: null,
  starts_at: null,
  ends_at: null,
  days_of_week: null,
  start_time: null,
  end_time: null,
  max_uses: null,
  times_used: 0,
  is_active: true,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("promociones: lectura con columnas de la migracion 027", () => {
  it("base MIGRADA: devuelve canales y productos elegibles", async () => {
    const session = new AbortAwareFakeSession([
      { match: /channels, product_ids/i, respond: () => [{ ...FILA_VIEJA, type: "bogo", value: "1.00", channels: ["recoger"], product_ids: [PROMO_ID] }] },
    ]);
    const found = await new PostgresRestaurantesRepository(session).findPromotionByCode(ORG, "LUNES");
    expect(found).toMatchObject({ type: "bogo", value: 1, channels: ["recoger"], productIds: [PROMO_ID] });
  });

  it("base SIN migrar (42703): cae a las columnas anteriores, channels/productIds = null, y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /channels, product_ids/i, respond: () => sinColumna("channels") },
      { match: /from restaurantes\.promotions/i, respond: () => [FILA_VIEJA] },
      SIGUIENTE,
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.findPromotionByCode(ORG, "LUNES")).toMatchObject({ code: "LUNES", type: "percentage", channels: null, productIds: null });
    await sesionSigueViva(session);
  });

  it("listar y buscar por id tambien degradan con SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([
      { match: /channels, product_ids/i, respond: () => sinColumna("product_ids") },
      { match: /from restaurantes\.promotions/i, respond: () => [FILA_VIEJA] },
      SIGUIENTE,
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.listPromotions(ORG)).toHaveLength(1);
    expect(await repo.findPromotion(ORG, PROMO_ID)).not.toBeNull();
    await sesionSigueViva(session);
  });
});

describe("promociones: escritura", () => {
  it("crear una promocion SIN campos nuevos usa el INSERT anterior (no toca columnas de la 027)", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /insert into restaurantes\.promotions/i,
        respond: () => [FILA_VIEJA],
      },
    ]);
    const created = await new PostgresRestaurantesRepository(session).createPromotion(ORG, { code: "LUNES", name: "Lunes", type: "percentage", value: 10 });
    expect(created.channels).toBeNull();
    expect(session.calls.join("\n")).not.toMatch(/channels/);
  });

  it("crear un 2x1 contra una base SIN migrar lanza RestaurantesConfigUnavailableError (503 honesto) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into restaurantes\.promotions/i, respond: () => sinColumna("channels") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).createPromotion(ORG, { code: "LUNES2X1", name: "x", type: "bogo", value: 1 })).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });

  it("editar un 2x1 / canales contra una base SIN migrar tambien es 'no disponible' con SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([{ match: /update restaurantes\.promotions/i, respond: () => sinColumna("channels") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).updatePromotion(ORG, PROMO_ID, { channels: ["recoger"] })).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });

  it("editar un campo comun contra una base SIN migrar sigue funcionando (el flujo de hoy no se rompe)", async () => {
    let intentos = 0;
    const session = new AbortAwareFakeSession([
      {
        match: /update restaurantes\.promotions/i,
        respond: () => {
          intentos += 1;
          return intentos === 1 ? sinColumna("channels") : [FILA_VIEJA];
        },
      },
      SIGUIENTE,
    ]);
    const updated = await new PostgresRestaurantesRepository(session).updatePromotion(ORG, PROMO_ID, { name: "Nuevo nombre" });
    expect(updated).toMatchObject({ id: PROMO_ID, channels: null });
    expect(intentos).toBe(2);
    await sesionSigueViva(session);
  });
});
