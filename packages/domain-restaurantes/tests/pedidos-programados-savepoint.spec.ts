// REGLA DURA de compatibilidad con la base SIN migrar (migracion 034: pedidos programados). Todo corre DENTRO
// de la transaccion unica del request/barrido; `AbortAwareFakeSession` reproduce el estado abortado (25P02):
// cada caso verifica (1) el vacio honesto y (2) que la MISMA sesion sigue utilizable despues.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const PROPERTY_ID = "00000000-0000-4000-8000-0000000000a1";
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
  id: ORDER_ID,
  organization_id: ORG_ID,
  property_id: PROPERTY_ID,
  customer_id: null,
  customer_name: "Marcela",
  customer_phone: "9991234567",
  customer_address: null,
  customer_email: null,
  branch: "Francisco de Montejo",
  total: "90",
  status: "programado",
  items: [],
  source: "web",
  notes: null,
  payment_method: null,
  call_transcript: null,
  call_recording_url: null,
  dedupe_fingerprint: null,
  idempotency_key: null,
  created_at: "2026-10-02T18:00:00Z",
  assigned_repartidor_id: null,
  estimated_delivery_at: null,
  incident_note: null,
  programado_para: new Date("2026-10-03T20:00:00Z"),
  promovido_at: null,
};

describe("pedidos programados contra la base SIN migrar (SAVEPOINT)", () => {
  it("promoteDueScheduledOrders: funcion inexistente (42883) -> disponible=false y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /promover_pedidos_programados/, respond: () => pgError("42883", "function restaurantes.promover_pedidos_programados does not exist") },
      SIGUIENTE,
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.promoteDueScheduledOrders(ORG_ID, { now: new Date("2026-10-03T19:00:00Z"), anticipacionMin: 30 })).toEqual({ disponible: false, promoted: [] });
    await sesionSigueViva(session);
  });

  it("listScheduledOrders: columna inexistente (42703) -> disponible=false, sin lanzar", async () => {
    const session = new AbortAwareFakeSession([{ match: /programado_para/, respond: () => pgError("42703", 'column "programado_para" does not exist') }, SIGUIENTE]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.listScheduledOrders(ORG_ID, { propertyIds: null, limit: 20 })).toEqual({ disponible: false, orders: [] });
    await sesionSigueViva(session);
  });

  it("listOrderScheduleInfo: 42703 -> [] y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /programado_para/, respond: () => pgError("42703", 'column "programado_para" does not exist') }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).listOrderScheduleInfo(ORG_ID, [ORDER_ID])).toEqual([]);
    await sesionSigueViva(session);
  });

  it("supportsScheduledOrders: false cuando la columna no existe; true cuando existe", async () => {
    const sin = new AbortAwareFakeSession([{ match: /information_schema\.columns/, respond: () => [{ existe: false }] }]);
    expect(await new PostgresRestaurantesRepository(sin).supportsScheduledOrders()).toBe(false);
    const con = new AbortAwareFakeSession([{ match: /information_schema\.columns/, respond: () => [{ existe: true }] }]);
    expect(await new PostgresRestaurantesRepository(con).supportsScheduledOrders()).toBe(true);
    const falla = new AbortAwareFakeSession([{ match: /information_schema\.columns/, respond: () => pgError("42P01", "relation does not exist") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(falla).supportsScheduledOrders()).toBe(false);
    await sesionSigueViva(falla);
  });

  it("un rechazo REAL (42501 sin acceso) no se disfraza de base sin migrar: se propaga", async () => {
    const session = new AbortAwareFakeSession([
      { match: /promover_pedidos_programados/, respond: () => pgError("42501", "promover_pedidos_programados: sin acceso a esta organización") },
      SIGUIENTE,
    ]);
    await expect(new PostgresRestaurantesRepository(session).promoteDueScheduledOrders(ORG_ID, { now: new Date(), anticipacionMin: 30 })).rejects.toMatchObject({ code: "42501" });
  });
});

describe("pedidos programados contra la base migrada", () => {
  it("promoteDueScheduledOrders manda (org, ahora, anticipacion, sucursales) y mapea las filas", async () => {
    let params: unknown[] = [];
    const session = new AbortAwareFakeSession([
      {
        match: /promover_pedidos_programados/,
        respond: () => [{ promover_pedidos_programados: [{ ...FILA, status: "pending", promovido_at: "2026-10-03T19:10:00Z" }] }],
      },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      params = p ?? [];
      return original(sql, p);
    }) as typeof session.query;
    const r = await new PostgresRestaurantesRepository(session).promoteDueScheduledOrders(ORG_ID, {
      now: new Date("2026-10-03T19:10:00Z"),
      anticipacionMin: 30,
      propertyIds: [PROPERTY_ID],
    });
    expect(params).toEqual([ORG_ID, "2026-10-03T19:10:00.000Z", 30, [PROPERTY_ID]]);
    expect(r.disponible).toBe(true);
    expect(r.promoted[0]).toMatchObject({ id: ORDER_ID, status: "pending", programadoPara: "2026-10-03T20:00:00.000Z", promovidoAt: "2026-10-03T19:10:00Z" });
  });

  it("listScheduledOrders mapea programadoPara a ISO (la columna llega como Date)", async () => {
    const session = new AbortAwareFakeSession([{ match: /status = 'programado'/, respond: () => [FILA] }]);
    const r = await new PostgresRestaurantesRepository(session).listScheduledOrders(ORG_ID, { propertyIds: [PROPERTY_ID], limit: 10 });
    expect(r.disponible).toBe(true);
    expect(r.orders[0]).toMatchObject({ status: "programado", programadoPara: "2026-10-03T20:00:00.000Z", promovidoAt: null });
  });
});
