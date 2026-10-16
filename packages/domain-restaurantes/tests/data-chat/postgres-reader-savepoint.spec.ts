// Compatibilidad con la base SIN MIGRAR: el lector de "Chatea con tus datos" corre dentro de la
// transaccion UNICA de la request (`dbSession`). Un 42P01/42703/42883 sin SAVEPOINT dejaria la
// transaccion abortada (25P02 en la consulta siguiente y COMMIT -> ROLLBACK silencioso). Se prueba con
// AbortAwareFakeSession, que reproduce ese estado abortado (una sesion falsa plana no sirve).
import { describe, expect, it } from "vitest";
import { buildRestaurantesDataChatTools, PostgresRestaurantesDataChatReader, DataChatUnavailableError } from "../../src/data-chat/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";
import { NOW, OWNER_SCOPE, ORG_A } from "./support.ts";
import type { DataChatWindow } from "../../src/data-chat/index.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const SET_TIMEOUT = { match: /^\s*set local statement_timeout = 8000/i, respond: () => [] };

const WINDOW: DataChatWindow = {
  organizationId: ORG_A,
  propertyIds: null,
  start: new Date("2026-09-29T06:00:00.000Z"),
  end: new Date("2026-09-30T06:00:00.000Z"),
  timezone: "America/Merida",
  limit: 51,
};

describe("PostgresRestaurantesDataChatReader — base sin migrar", () => {
  it("tabla inexistente (42P01) -> DataChatUnavailableError y la transaccion queda UTILIZABLE (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from restaurantes\.orders/i, respond: () => pgError("42P01", 'relation "restaurantes.orders" does not exist') },
      { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
    const reader = new PostgresRestaurantesDataChatReader(session);

    await expect(reader.orderStats(WINDOW)).rejects.toBeInstanceOf(DataChatUnavailableError);
    // La "siguiente consulta del request" (p.ej. la bitacora o el COMMIT) funciona: no hay 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(session.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(1);
  });

  it("columna inexistente (42703) y funcion inexistente (42883) tambien degradan a 'no disponible'", async () => {
    for (const err of [pgError("42703", 'column pr.times_used does not exist'), pgError("42883", "function restaurantes.algo() does not exist")]) {
      const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from restaurantes\.promotions/i, respond: () => err }]);
      await expect(new PostgresRestaurantesDataChatReader(session).promotions(ORG_A, 51)).rejects.toBeInstanceOf(DataChatUnavailableError);
    }
  });

  it("un error real (statement timeout 57014) NO se enmascara como 'no disponible', pero la sesion igual se recupera", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from restaurantes\.orders/i, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
    const reader = new PostgresRestaurantesDataChatReader(session);
    await expect(reader.salesByBranch(WINDOW)).rejects.toMatchObject({ code: "57014" });
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("de punta a punta: la herramienta responde 'unavailable' y la transaccion sigue sirviendo a la bitacora", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from core\.property p\s+join restaurantes\.branch_detail/i, respond: () => [{ property_id: "p1", name: "Centro", slug: "centro" }] },
      { match: /from restaurantes\.orders/i, respond: () => pgError("42P01", "relation does not exist") },
      { match: /insert into core\.data_chat_query_log|select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
    const tool = buildRestaurantesDataChatTools(new PostgresRestaurantesDataChatReader(session)).find((t) => t.name === "ticket_medio")!;
    const r = await tool.run({ scope: OWNER_SCOPE, now: NOW, signal: new AbortController().signal, maxRows: 50 }, { periodo: "hoy" });
    expect(r.status).toBe("unavailable");
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("camino feliz: convierte numeric/bigint (texto de pg) a numeros y manda los parametros en el orden del SQL", async () => {
    const seen: unknown[][] = [];
    const base = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /to_char\(date_trunc/i, respond: () => [{ bucket: "2026-09-29", revenue: "1500.50", orders: "12" }] },
      { match: /extract\(hour from/i, respond: () => [{ hour: 14, orders: "9", revenue: "1100.00" }] },
      { match: /with in_period/i, respond: () => [{ customers: "40", recurring: "18", new_customers: "22" }] },
    ]);
    const original = base.query.bind(base);
    base.query = (async (sql: string, params?: unknown[]) => {
      seen.push(params ?? []);
      return original(sql, params);
    }) as typeof base.query;
    const reader = new PostgresRestaurantesDataChatReader(base);

    expect(await reader.salesByPeriod(WINDOW, "day")).toEqual([{ bucket: "2026-09-29", revenue: 1500.5, orders: 12 }]);
    expect(await reader.peakHours(WINDOW)).toEqual([{ hour: 14, orders: 9, revenue: 1100 }]);
    expect(await reader.recurringCustomers(WINDOW)).toEqual({ customers: 40, recurring: 18, newCustomers: 22 });
    // con zona horaria: [org, props, inicio, fin, tz, limite, (unidad)]
    expect(seen[0]).toEqual([ORG_A, null, "2026-09-29T06:00:00.000Z", "2026-09-30T06:00:00.000Z", "America/Merida", 51, "day"]);
    // sin zona horaria: [org, props, inicio, fin, limite]
    expect(seen[2]).toEqual([ORG_A, null, "2026-09-29T06:00:00.000Z", "2026-09-30T06:00:00.000Z", 51]);
  });

  it("sucursales permitidas viajan como arreglo (nunca null) cuando la membresia esta acotada", async () => {
    const seen: unknown[][] = [];
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from restaurantes\.orders/i, respond: () => [{ orders: "0", revenue: "0", cancelled: "0" }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      seen.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    await new PostgresRestaurantesDataChatReader(session).orderStats({ ...WINDOW, propertyIds: ["p1", "p2"] });
    expect(seen[0]![1]).toEqual(["p1", "p2"]);
  });
});

/** AbortAwareFakeSession solo guarda la primera linea: se registra el SQL completo de cada query. */
function espiarSql(session: AbortAwareFakeSession): string[] {
  const vistas: string[] = [];
  const original = session.query.bind(session);
  session.query = (async (sql: string, params?: unknown[]) => {
    vistas.push(sql);
    return original(sql, params);
  }) as typeof session.query;
  return vistas;
}

describe("PostgresRestaurantesDataChatReader — dia de venta con promovido_at (QA R2 viaje-03)", () => {
  it("con la migracion 034 la consulta cuenta el dia por coalesce(promovido_at, created_at) y excluye por_aprobar", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from restaurantes\.orders/i, respond: () => [{ orders: "3", revenue: "600", cancelled: "0" }] }]);
    const vistas = espiarSql(session);
    const stats = await new PostgresRestaurantesDataChatReader(session).orderStats(WINDOW);
    expect(stats.orders).toBe(3);
    const sql = vistas.find((c) => /from restaurantes\.orders/i.test(c)) ?? "";
    expect(sql).toContain("coalesce(o.promovido_at, o.created_at)");
    expect(sql).toContain("'por_aprobar'");
  });

  it("base SIN la migracion 034 (42703 en promovido_at): reintenta con created_at en vez de 'no disponible', y la sesion sigue sana", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /promovido_at/i, respond: () => pgError("42703", "column o.promovido_at does not exist") },
      { match: /from restaurantes\.orders/i, respond: () => [{ orders: "2", revenue: "400", cancelled: "0" }] },
      { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
    const vistas = espiarSql(session);
    const stats = await new PostgresRestaurantesDataChatReader(session).orderStats(WINDOW);
    expect(stats.orders).toBe(2);
    const ordenes = vistas.filter((c) => /from restaurantes\.orders/i.test(c));
    expect(ordenes).toHaveLength(2);
    expect(ordenes[0]).toContain("promovido_at");
    expect(ordenes[1]).not.toContain("promovido_at");
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });
});
