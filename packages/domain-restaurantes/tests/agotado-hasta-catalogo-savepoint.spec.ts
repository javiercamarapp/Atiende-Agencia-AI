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
  it("con la 050 pone agotado_hasta en null", async () => {
    const session = new AbortAwareFakeSession([{ match: /set agotado_hasta = null/, respond: () => [] }]);
    await new PostgresRestaurantesRepository(session).limpiarAgotadoHasta(PROPERTY_ID, PRODUCT_ID);
    expect(session.calls.some((c) => /set agotado_hasta = null/.test(c))).toBe(true);
  });

  it("base SIN la 050 (42703): no-op y la MISMA sesión sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /set agotado_hasta = null/, respond: () => pgError("42703") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).limpiarAgotadoHasta(PROPERTY_ID, PRODUCT_ID)).resolves.toBeUndefined();
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que no es de base sin migrar se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /set agotado_hasta = null/, respond: () => pgError("40001") }]);
    await expect(new PostgresRestaurantesRepository(session).limpiarAgotadoHasta(PROPERTY_ID, PRODUCT_ID)).rejects.toMatchObject({ code: "40001" });
  });
});
