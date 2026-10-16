// import-orig-14: el panel de Productos lee y cancela `branch_products.agotado_hasta` (migración 050) sin romper una base SIN migrar.
// `AbortAwareFakeSession` reproduce la transacción abortada (25P02) de un 42703 sin SAVEPOINT.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const PROPERTY_ID = "00000000-0000-4000-8000-0000000000a1";
const PRODUCT_ID = "00000000-0000-4000-8000-0000000000d1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string): Error & { code: string } {
  const err = new Error(`pg ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe("getBranchProductState — agotado_hasta", () => {
  it("trae agotadoHasta leyendo la columna con to_jsonb (no falla si la columna no existe)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /to_jsonb\(bp\)->>'agotado_hasta'/, respond: () => [{ property_id: PROPERTY_ID, product_id: PRODUCT_ID, price: "30.00", is_available: false, agotado_hasta: "2026-10-08" }] },
    ]);
    const state = await new PostgresRestaurantesRepository(session).getBranchProductState(PROPERTY_ID, PRODUCT_ID);
    expect(state).toEqual({ propertyId: PROPERTY_ID, productId: PRODUCT_ID, price: 30, isAvailable: false, agotadoHasta: "2026-10-08" });
    expect(session.calls.join("\n")).not.toMatch(/bp\.agotado_hasta/);
  });

  it("base sin la 050: to_jsonb da null y el estado sale con agotadoHasta null", async () => {
    const session = new AbortAwareFakeSession([
      { match: /to_jsonb\(bp\)->>'agotado_hasta'/, respond: () => [{ property_id: PROPERTY_ID, product_id: PRODUCT_ID, price: "30.00", is_available: true, agotado_hasta: null }] },
    ]);
    const state = await new PostgresRestaurantesRepository(session).getBranchProductState(PROPERTY_ID, PRODUCT_ID);
    expect(state?.agotadoHasta).toBeNull();
  });
});

describe("limpiarAgotadoHasta", () => {
  it("con reposición programada hace DOS UPDATE de columnas permitidas (encender y apagar), nunca escribe agotado_hasta", async () => {
    const session = new AbortAwareFakeSession([
      { match: /set is_available = true/, respond: () => [{ id: PRODUCT_ID }] },
      { match: /set is_available = false/, respond: () => [] },
    ]);
    await new PostgresRestaurantesRepository(session).limpiarAgotadoHasta(PROPERTY_ID, PRODUCT_ID);
    const updates = session.calls.filter((c) => /update restaurantes\.branch_products/.test(c));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatch(/set is_available = true/);
    expect(updates[1]).toMatch(/set is_available = false/);
    expect(session.calls.join("\n")).not.toMatch(/set agotado_hasta/);
  });

  it("sin reposición programada (el primer UPDATE no toca filas) no apaga nada", async () => {
    const session = new AbortAwareFakeSession([{ match: /set is_available = true/, respond: () => [] }]);
    await new PostgresRestaurantesRepository(session).limpiarAgotadoHasta(PROPERTY_ID, PRODUCT_ID);
    expect(session.calls.filter((c) => /update restaurantes\.branch_products/.test(c))).toHaveLength(1);
  });

  it("base SIN la 050 (42703): no-op y la MISMA sesión sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /set is_available = true/, respond: () => pgError("42703") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).limpiarAgotadoHasta(PROPERTY_ID, PRODUCT_ID)).resolves.toBeUndefined();
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("42501 (sin permiso) NO se traga: se propaga, para no dejar al cron reactivando el producto en silencio", async () => {
    const session = new AbortAwareFakeSession([{ match: /set is_available = true/, respond: () => pgError("42501") }]);
    await expect(new PostgresRestaurantesRepository(session).limpiarAgotadoHasta(PROPERTY_ID, PRODUCT_ID)).rejects.toMatchObject({ code: "42501" });
  });

  it("un error que no es de base sin migrar (40001) se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /set is_available = true/, respond: () => pgError("40001") }]);
    await expect(new PostgresRestaurantesRepository(session).limpiarAgotadoHasta(PROPERTY_ID, PRODUCT_ID)).rejects.toMatchObject({ code: "40001" });
  });
});
