// QA-PM-R2-whatsapp-02 (migracion 071): las lecturas de cliente/pedido de la sesion de sistema van por funciones `security definer`, cada una en su
// SAVEPOINT. Contra la base SIN migrar (42883) o con una sesion de staff (42501) cae a la lectura directa y la MISMA sesion sigue viva (nunca 25P02).
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const CLIENTE = "00000000-0000-4000-8000-0000000000d1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const FILA_CLIENTE = { id: CLIENTE, organization_id: ORG, phone: "9991230001", name: "Nora", order_count: 1 };

describe("findCustomerByPhone con la funcion de sistema", () => {
  it("usa sistema_buscar_cliente_por_telefono y devuelve el cliente (antes: RLS devolvia 0 filas y el agente decia 'cliente nuevo')", async () => {
    const session = new AbortAwareFakeSession([{ match: /sistema_buscar_cliente_por_telefono/, respond: () => [{ cliente: FILA_CLIENTE }] }]);
    const c = await new PostgresRestaurantesRepository(session).findCustomerByPhone(ORG, "9991230001");
    expect(c).toMatchObject({ id: CLIENTE, name: "Nora", orderCount: 1 });
    expect(session.calls.some((q) => q.includes("from restaurantes.customers"))).toBe(false);
  });

  it("la funcion devuelve null: cliente nuevo de verdad (sin caer a la lectura directa)", async () => {
    const session = new AbortAwareFakeSession([{ match: /sistema_buscar_cliente_por_telefono/, respond: () => [{ cliente: null }] }]);
    expect(await new PostgresRestaurantesRepository(session).findCustomerByPhone(ORG, "9990000000")).toBeNull();
  });

  it.each([["42883"], ["42501"]])("SQLSTATE %s: lectura directa y la sesion sigue viva", async (code) => {
    const session = new AbortAwareFakeSession([
      { match: /sistema_buscar_cliente_por_telefono/, respond: () => pgError(code, "no disponible") },
      { match: /from restaurantes\.customers/, respond: () => [FILA_CLIENTE] },
      SIGUIENTE,
    ]);
    const c = await new PostgresRestaurantesRepository(session).findCustomerByPhone(ORG, "9991230001");
    expect(c?.id).toBe(CLIENTE);
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("un error que NO es de compatibilidad se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /sistema_buscar_cliente_por_telefono/, respond: () => pgError("40001", "serialization failure") }]);
    await expect(new PostgresRestaurantesRepository(session).findCustomerByPhone(ORG, "9991230001")).rejects.toThrow(/serialization/);
  });
});

describe("direcciones, historial, pedido por id y pedido reciente", () => {
  it("direcciones e historial por funcion de sistema (con la organizacion)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /sistema_direcciones_cliente/, respond: () => [{ direcciones: [{ address: "Calle 20 #300", label: null, is_default: true }] }] },
      { match: /sistema_historial_pedidos_cliente/, respond: () => [{ historial: [{ items: [{ id: "p", name: "Taco Al Pastor (individual)", price: 42, quantity: 6 }], created_at: "2026-10-02T20:00:00.000Z" }] }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.listCustomerAddresses(CLIENTE, ORG)).toEqual([{ address: "Calle 20 #300", label: null, isDefault: true }]);
    const h = await repo.listEligibleOrderHistory(CLIENTE, ORG);
    expect(h[0]!.items[0]!.name).toBe("Taco Al Pastor (individual)");
  });

  it("sin organizacion (llamadores del panel/staff) sigue la lectura directa", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.customer_addresses/, respond: () => [{ address: "X", label: null, is_default: false }] }]);
    expect(await new PostgresRestaurantesRepository(session).listCustomerAddresses(CLIENTE)).toHaveLength(1);
  });

  it("pedido reciente por funcion: devuelve el pedido; sin pedido, null", async () => {
    const fila = { id: "o1", organization_id: ORG, property_id: "p1", customer_id: CLIENTE, customer_name: "Nora", customer_phone: "9991230001", customer_address: null, customer_email: null, branch: "T7", total: "301.00", status: "entregado", items: [], source: "whatsapp", notes: null, payment_method: "efectivo", call_transcript: null, call_recording_url: null, dedupe_fingerprint: null, idempotency_key: null, created_at: "2026-10-02T20:00:00.000Z", assigned_repartidor_id: null, estimated_delivery_at: null, incident_note: null };
    const conPedido = new AbortAwareFakeSession([{ match: /sistema_pedido_reciente_por_telefono/, respond: () => [{ pedido: fila }] }]);
    expect(await new PostgresRestaurantesRepository(conPedido).findLatestOrderByPhone(ORG, "9991230001", "2026-10-01T00:00:00.000Z")).toMatchObject({ status: "entregado", total: 301 });
    const sin = new AbortAwareFakeSession([{ match: /sistema_pedido_reciente_por_telefono/, respond: () => [{ pedido: null }] }]);
    expect(await new PostgresRestaurantesRepository(sin).findLatestOrderByPhone(ORG, "9991230001", "2026-10-01T00:00:00.000Z")).toBeNull();
  });

  it("findOrderById por funcion y, sin migrar, directo", async () => {
    const fila = { id: "o1", organization_id: ORG, property_id: "p1", customer_id: null, customer_name: "N", customer_phone: "1", customer_address: null, customer_email: null, branch: "T7", total: "10.00", status: "pending", items: [], source: "voice", notes: null, payment_method: "efectivo", call_transcript: null, call_recording_url: null, dedupe_fingerprint: null, idempotency_key: null, created_at: "2026-10-02T20:00:00.000Z", assigned_repartidor_id: null, estimated_delivery_at: null, incident_note: null };
    const viaFn = new AbortAwareFakeSession([{ match: /sistema_pedido_por_id/, respond: () => [{ pedido: fila }] }]);
    expect((await new PostgresRestaurantesRepository(viaFn).findOrderById(ORG, "o1"))?.id).toBe("o1");
    const sinMigrar = new AbortAwareFakeSession([{ match: /from restaurantes\.orders/, respond: () => [fila] }]);
    expect((await new PostgresRestaurantesRepository(sinMigrar).findOrderById(ORG, "o1"))?.id).toBe("o1");
  });
});
