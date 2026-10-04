// QA-restaurantes-R1-features-01 / 01b / 06a / 06b: cursores y busqueda del repositorio Postgres.
// Sesion falsa que registra el SQL y los parametros: sin Postgres real.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";

const ORG = "11111111-1111-4111-8111-111111111111";

function orderRow(i: number, createdAt: Date, cursorText: string) {
  return {
    id: `00000000-0000-4000-8000-00000000000${i}`, organization_id: ORG, property_id: "22222222-2222-4222-8222-222222222222",
    customer_id: null, customer_name: "C", customer_phone: "9990000000", customer_address: null, customer_email: null,
    branch: "S", total: "10", status: "pendiente", items: [], source: "web", notes: null, payment_method: "efectivo",
    call_transcript: null, call_recording_url: null, dedupe_fingerprint: null, idempotency_key: null,
    // pg entrega timestamptz como Date
    created_at: createdAt, created_at_cursor: cursorText, assigned_repartidor_id: null, estimated_delivery_at: null, incident_note: null,
  };
}

function fakeSession(rows: unknown[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const session: TenantDbSession = {
    async query<T>(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      return { rows: rows as T[] };
    },
    async exec() {},
  };
  return { session, calls };
}

describe("listOrders: cursor de pagina", () => {
  it("el cursor conserva los microsegundos de Postgres y no usa Date.toString()", async () => {
    const rows = [
      orderRow(1, new Date("2026-10-03T19:16:33.123Z"), "2026-10-03 19:16:33.123456+00"),
      orderRow(2, new Date("2026-10-03T19:16:33.123Z"), "2026-10-03 19:16:33.123455+00"),
      orderRow(3, new Date("2026-10-03T19:16:33.100Z"), "2026-10-03 19:16:33.100000+00"),
    ];
    const { session, calls } = fakeSession(rows);
    const repo = new PostgresRestaurantesRepository(session);
    const page = await repo.listOrders(ORG, { propertyIds: null, limit: 2 });
    expect(page.orders).toHaveLength(2);
    const decoded = Buffer.from(page.nextCursor!, "base64url").toString("utf8");
    expect(decoded).toBe("2026-10-03 19:16:33.123455+00|00000000-0000-4000-8000-000000000002");
    expect(decoded).not.toContain("GMT");

    await repo.listOrders(ORG, { propertyIds: null, limit: 2, cursor: page.nextCursor! });
    expect(calls[1]!.params).toContain("2026-10-03 19:16:33.123455+00");
    expect(calls[1]!.sql).toContain("(created_at, id) <");
  });

  it("un cursor manipulado o con Date.toString() se ignora (no llega a Postgres)", async () => {
    const { session, calls } = fakeSession([]);
    const repo = new PostgresRestaurantesRepository(session);
    const basura = Buffer.from("no-es-fecha|00000000-0000-4000-8000-000000000002", "utf8").toString("base64url");
    const viejo = Buffer.from("Sat Oct 03 2026 19:16:33 GMT-0600 (CST)|00000000-0000-4000-8000-000000000002", "utf8").toString("base64url");
    const sinUuid = Buffer.from("2026-10-03T19:16:33.000Z|no-uuid", "utf8").toString("base64url");
    for (const cursor of [basura, viejo, sinUuid, "%%%"]) {
      await repo.listOrders(ORG, { propertyIds: null, limit: 2, cursor });
    }
    for (const c of calls) expect(c.sql).not.toContain("(created_at, id) <");
  });
});

describe("listCustomers: cursor y busqueda", () => {
  it("un cursor que no es uuid se ignora", async () => {
    const { session, calls } = fakeSession([]);
    await new PostgresRestaurantesRepository(session).listCustomers(ORG, { limit: 5, cursor: "pagina-2" });
    expect(calls[0]!.sql).not.toContain("id >");
    expect(calls[0]!.params).not.toContain("pagina-2");
  });

  it("un cursor uuid valido si filtra", async () => {
    const { session, calls } = fakeSession([]);
    const id = "00000000-0000-4000-8000-000000000009";
    await new PostgresRestaurantesRepository(session).listCustomers(ORG, { limit: 5, cursor: id });
    expect(calls[0]!.sql).toContain("id >");
    expect(calls[0]!.params).toContain(id);
  });

  it("% _ y \\ en la busqueda son literales (se escapan)", async () => {
    const { session, calls } = fakeSession([]);
    const repo = new PostgresRestaurantesRepository(session);
    await repo.listCustomers(ORG, { limit: 5, search: "%" });
    await repo.listCustomers(ORG, { limit: 5, search: "a_b\\c" });
    expect(calls[0]!.params[1]).toBe("%\\%%");
    expect(calls[1]!.params[1]).toBe("%a\\_b\\\\c%");
  });
});
