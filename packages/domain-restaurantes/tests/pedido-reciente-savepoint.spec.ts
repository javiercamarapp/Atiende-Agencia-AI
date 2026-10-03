// PM-C5 (estado del pedido). `findLatestOrderByPhone` corre en CADA mensaje de WhatsApp dentro de la transaccion unica del lote:
// un error de Postgres sin SAVEPOINT la dejaria abortada (25P02) y el COMMIT seria un ROLLBACK. `AbortAwareFakeSession` reproduce ese
// estado; el respaldo es "sin pedido reciente" (el agente nunca inventa un estado) y la MISMA sesion sigue viva.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const FILA = {
  id: "00000000-0000-4000-8000-0000000000c1",
  organization_id: ORG_ID,
  property_id: "00000000-0000-4000-8000-0000000000a1",
  customer_id: null,
  customer_name: "Cliente",
  customer_phone: "9991234567",
  customer_address: null,
  customer_email: null,
  branch: "García Lavín (Victory Platz)",
  total: "275.00",
  status: "en_camino",
  items: [],
  source: "whatsapp",
  notes: null,
  payment_method: "tarjeta",
  call_transcript: null,
  call_recording_url: null,
  dedupe_fingerprint: null,
  idempotency_key: null,
  created_at: "2026-10-02T20:00:00.000Z",
  assigned_repartidor_id: null,
  estimated_delivery_at: null,
  incident_note: null,
};

describe("findLatestOrderByPhone", () => {
  it("devuelve el pedido mas reciente del telefono (dentro de un SAVEPOINT que se libera)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.orders|select id, organization_id/i, respond: () => [FILA] }]);
    const order = await new PostgresRestaurantesRepository(session).findLatestOrderByPhone(ORG_ID, "9991234567", "2026-10-02T08:00:00.000Z");
    expect(order).toMatchObject({ status: "en_camino", total: 275, branch: "García Lavín (Victory Platz)" });
    expect(session.calls.some((c) => c.includes("savepoint sp_restaurantes_pedido_reciente"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("release savepoint"))).toBe(true);
  });

  it("sin filas devuelve null", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.orders|select id, organization_id/i, respond: () => [] }]);
    expect(await new PostgresRestaurantesRepository(session).findLatestOrderByPhone(ORG_ID, "9991234567", "2026-10-02T08:00:00.000Z")).toBeNull();
  });

  it.each([
    ["42501", "permission denied for table orders"],
    ["42P01", 'relation "restaurantes.orders" does not exist'],
    ["42703", 'column "customer_phone" does not exist'],
    ["42883", "function regexp_replace does not exist"],
  ])("SQLSTATE %s: devuelve undefined (estado desconocido, distinto de null) y la sesion del request sigue viva", async (code, mensaje) => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.orders|select id, organization_id/i, respond: () => pgError(code, mensaje) }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).findLatestOrderByPhone(ORG_ID, "9991234567", "2026-10-02T08:00:00.000Z")).toBeUndefined();
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de compatibilidad (p. ej. 40001) se propaga, tambien con la sesion recuperada", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.orders|select id, organization_id/i, respond: () => pgError("40001", "serialization failure") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).findLatestOrderByPhone(ORG_ID, "9991234567", "2026-10-02T08:00:00.000Z")).rejects.toThrow(/serialization/);
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});
