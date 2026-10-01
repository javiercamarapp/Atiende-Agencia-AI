// REGLA DURA de compatibilidad con la base SIN migrar (migracion 032 y columna no_domicilio de la 023):
// el menu y el rastreo del storefront corren DENTRO de la transaccion unica de un request. Un 42883/42703
// sin SAVEPOINT la dejaria abortada (25P02) y el COMMIT seria un ROLLBACK. `AbortAwareFakeSession`
// reproduce ese estado: cada caso verifica el camino anterior / vacio honesto y que la MISMA sesion
// sigue viva despues.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const PROPERTY_ID = "00000000-0000-4000-8000-0000000000a1";
const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000c1";
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

const FILA = {
  id: "p1",
  name: "Tacos de pastor (orden de 3)",
  description: null,
  price: "164.00",
  image_url: null,
  is_popular: true,
  is_available: false,
  category_id: "c1",
  category_name: "Tacos",
  category_display_order: 1,
  display_order: 2,
};

describe("listStorefrontCatalog", () => {
  it("lee el menu con no_domicilio y respeta 'hoy no hay'", async () => {
    const session = new AbortAwareFakeSession([{ match: /coalesce\(c\.no_domicilio/i, respond: () => [{ ...FILA, no_domicilio: true }] }]);
    const rows = await new PostgresRestaurantesRepository(session).listStorefrontCatalog(PROPERTY_ID);
    expect(rows).toEqual([expect.objectContaining({ id: "p1", price: 164, isAvailable: false, noDomicilio: true, categoryDisplayOrder: 1 })]);
  });

  it("base SIN la migracion 023 (42703 en no_domicilio): cae al SELECT anterior y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /coalesce\(c\.no_domicilio/i, respond: () => pgError("42703", 'column "no_domicilio" does not exist') },
      { match: /from restaurantes\.branch_products bp/i, respond: () => [FILA] },
      SIGUIENTE,
    ]);
    const rows = await new PostgresRestaurantesRepository(session).listStorefrontCatalog(PROPERTY_ID);
    expect(rows).toEqual([expect.objectContaining({ id: "p1", noDomicilio: false })]);
    await sesionSigueViva(session);
  });

  it("un error que NO es de base sin migrar (p. ej. 40001) se propaga, no se traga", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.branch_products bp/i, respond: () => pgError("40001", "serialization failure") }]);
    await expect(new PostgresRestaurantesRepository(session).listStorefrontCatalog(PROPERTY_ID)).rejects.toMatchObject({ code: "40001" });
  });
});

describe("findStorefrontOrderTracking", () => {
  it("mapea la respuesta acotada de la funcion", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /storefront_order_tracking/i,
        respond: () => [{ tracking: { status: "preparando", branch: "Centro", total: "250.50", payment_method: "efectivo", canal: "recoger", created_at: "2026-09-30T20:00:00Z", items: [{ name: "Tacos", quantity: 2, tortilla: "maiz" }, { name: "Agua", quantity: 1 }] } }],
      },
    ]);
    const res = await new PostgresRestaurantesRepository(session).findStorefrontOrderTracking(ORG_ID, ORDER_ID);
    expect(res).toEqual({
      disponible: true,
      pedido: { status: "preparando", branch: "Centro", total: 250.5, paymentMethod: "efectivo", canal: "recoger", createdAt: "2026-09-30T20:00:00Z", items: [{ name: "Tacos", quantity: 2, tortilla: "maiz" }, { name: "Agua", quantity: 1, tortilla: null }] },
    });
  });

  it("pedido que no es de la organizacion (la funcion devuelve NULL): disponible pero sin pedido", async () => {
    const session = new AbortAwareFakeSession([{ match: /storefront_order_tracking/i, respond: () => [{ tracking: null }] }]);
    expect(await new PostgresRestaurantesRepository(session).findStorefrontOrderTracking(ORG_ID, ORDER_ID)).toEqual({ disponible: true, pedido: null });
  });

  it("base SIN la migracion 032 (42883): 'no disponible aun' y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /storefront_order_tracking/i, respond: () => pgError("42883", "function restaurantes.storefront_order_tracking(uuid, uuid) does not exist") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).findStorefrontOrderTracking(ORG_ID, ORDER_ID)).toEqual({ disponible: false, pedido: null });
    await sesionSigueViva(session);
  });
});
