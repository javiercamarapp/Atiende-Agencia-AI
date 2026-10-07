// QA R2 viaje-03/04: las ventas del Resumen cuentan el dia en que un pedido programado se promueve (como el Cierre del dia) y
// no cuentan un pedido retenido sin aprobar. Contra la base SIN la migracion 034 (42703 en promovido_at) la consulta cae a
// created_at dentro de un SAVEPOINT: la transaccion compartida de la request no queda abortada (25P02).
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const BUCKET = [{ start: new Date("2026-03-10T06:00:00.000Z"), end: new Date("2026-03-11T06:00:00.000Z") }];

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error("column o.promovido_at does not exist"), { code });
}

describe("getSalesBucketedStats — dia de negocio y compatibilidad con la base sin migrar", () => {
  it("la consulta usa coalesce(promovido_at, created_at) y excluye por_aprobar", async () => {
    const session = new AbortAwareFakeSession([{ match: /unnest/i, respond: () => [{ idx: 1, revenue: "600", order_count: "3", customer_count: "2" }] }]);
    const vistas: string[] = [];
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      vistas.push(sql);
      return original(sql, params);
    }) as typeof session.query;
    const res = await new PostgresRestaurantesRepository(session).getSalesBucketedStats(ORG, null, BUCKET);
    expect(res).toEqual([{ revenue: 600, orderCount: 3, customerCount: 2 }]);
    expect(vistas[0]).toContain("coalesce(o.promovido_at, o.created_at) >= b.bucket_start");
    expect(vistas[0]).toContain("'por_aprobar'");
  });

  it("base sin migrar (42703): reintenta con created_at y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /promovido_at/i, respond: () => pgError("42703") },
      { match: /unnest/i, respond: () => [{ idx: 1, revenue: "400", order_count: "2", customer_count: "1" }] },
      { match: /select 1 as siguiente/i, respond: () => [{ ok: true }] },
    ]);
    const res = await new PostgresRestaurantesRepository(session).getSalesBucketedStats(ORG, null, BUCKET);
    expect(res[0]?.orderCount).toBe(2);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1 as siguiente")).resolves.toBeDefined();
  });

  it("un error real (no 42703) se propaga y la sesion tambien se recupera", async () => {
    const session = new AbortAwareFakeSession([
      { match: /unnest/i, respond: () => pgError("57014") },
      { match: /select 1 as siguiente/i, respond: () => [{ ok: true }] },
    ]);
    await expect(new PostgresRestaurantesRepository(session).getSalesBucketedStats(ORG, null, BUCKET)).rejects.toMatchObject({ code: "57014" });
    await expect(session.query("select 1 as siguiente")).resolves.toBeDefined();
  });
});

describe("getSalesBucketedStats en memoria (espejo)", () => {
  it("un programado cuenta el dia que se promueve; un por_aprobar no cuenta", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const base = { organizationId: ORG, propertyId: "p1", total: 200 } as const;
    // helper interno: se siembran pedidos directamente
    (repo as unknown as { orders: unknown[] }).orders.push(
      { ...base, id: "o1", status: "entregado", createdAt: "2026-03-09T18:00:00.000Z", promovidoAt: "2026-03-10T18:30:00.000Z", customerId: null },
      { ...base, id: "o2", status: "entregado", createdAt: "2026-03-10T17:00:00.000Z", promovidoAt: null, customerId: null, total: 400 },
      { ...base, id: "o3", status: "por_aprobar", createdAt: "2026-03-10T19:00:00.000Z", promovidoAt: null, customerId: null, total: 4500 },
    );
    const [dia] = await repo.getSalesBucketedStats(ORG, null, BUCKET);
    expect(dia).toEqual({ revenue: 600, orderCount: 2, customerCount: 0 });
  });
});
