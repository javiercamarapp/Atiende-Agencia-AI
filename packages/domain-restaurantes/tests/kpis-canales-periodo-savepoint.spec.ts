// R-30 + REGLA DURA de compatibilidad con la base SIN migrar: `getChannelStats` con periodo llama a
// `orders_channel_stats_periodo` (migracion 036) dentro de un SAVEPOINT. Contra la base vieja (42883) cae al
// historico (`orders_channel_stats`, 2 argumentos) y lo DECLARA con `acotadoAPeriodo: false`; la sesion sigue
// utilizable (AbortAwareFakeSession reproduce el 25P02 de Postgres).
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const RANGO = { start: new Date("2026-09-01T06:00:00.000Z"), end: new Date("2026-09-08T06:00:00.000Z") };
const FILA = {
  total_orders: "3", total_revenue: "450", voice_orders: "2", voice_completed: "1", voice_cancelled: "1", voice_revenue: "200",
  whatsapp_orders: "1", whatsapp_completed: "1", whatsapp_cancelled: "0", whatsapp_revenue: "150",
};
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("getChannelStats con periodo", () => {
  it("base migrada: usa orders_channel_stats_periodo y marca acotadoAPeriodo=true", async () => {
    const s = new AbortAwareFakeSession([{ match: /orders_channel_stats_periodo/i, respond: () => [FILA] }]);
    const r = await new PostgresRestaurantesRepository(s).getChannelStats(ORG, null, RANGO);
    expect(r.acotadoAPeriodo).toBe(true);
    expect(r.totalRevenue).toBe(450);
    expect(r.voice).toEqual({ orders: 2, completed: 1, cancelled: 1, revenue: 200 });
  });

  it("base SIN migrar (42883): cae al historico, lo declara y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([
      { match: /orders_channel_stats_periodo/i, respond: () => pgError("42883", "function restaurantes.orders_channel_stats_periodo does not exist") },
      { match: /orders_channel_stats\(\$1, \$2::uuid\[\]\)/i, respond: () => [FILA] },
      SIGUIENTE,
    ]);
    const r = await new PostgresRestaurantesRepository(s).getChannelStats(ORG, null, RANGO);
    expect(r.acotadoAPeriodo).toBe(false);
    expect(r.totalOrders).toBe(3);
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de compatibilidad se repropaga", async () => {
    const s = new AbortAwareFakeSession([{ match: /orders_channel_stats_periodo/i, respond: () => pgError("57P01", "connection terminated") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(s).getChannelStats(ORG, null, RANGO)).rejects.toMatchObject({ code: "57P01" });
  });

  it("sin periodo: va directo al historico (acotadoAPeriodo=false), sin savepoint", async () => {
    const s = new AbortAwareFakeSession([{ match: /orders_channel_stats\(\$1, \$2::uuid\[\]\)/i, respond: () => [FILA] }]);
    const r = await new PostgresRestaurantesRepository(s).getChannelStats(ORG, null);
    expect(r.acotadoAPeriodo).toBe(false);
    expect(s.calls.some((c) => c.startsWith("savepoint"))).toBe(false);
  });
});
