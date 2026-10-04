// P0 (PM, cuenta real; migracion 043): las escrituras de la sesion de sistema (cliente, direccion, aviso, evento de WhatsApp
// fallido) van por funciones `security definer` solo-sistema. Contra una base SIN esa migracion la funcion no existe (42883) y el
// repositorio cae al camino directo anterior. Todo corre dentro de la transaccion unica del request: sin SAVEPOINT el 42883 la
// dejaria abortada (25P02) y el COMMIT seria un ROLLBACK. `AbortAwareFakeSession` reproduce ese estado.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const CLIENTE = "00000000-0000-4000-8000-0000000000c1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const sinFuncion = (nombre: string) => pgError("42883", `function restaurantes.${nombre} does not exist`);
const FILA_CLIENTE = { id: CLIENTE, organization_id: ORG, phone: "9991234567", name: "Ana", order_count: 0 };

describe("upsertCustomer (043)", () => {
  it("con la funcion: un solo SELECT, devuelve el cliente y libera el SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([{ match: /select restaurantes\.upsert_customer/i, respond: () => [{ customer: FILA_CLIENTE }] }]);
    const cliente = await new PostgresRestaurantesRepository(session).upsertCustomer(ORG, "9991234567", "Ana");
    expect(cliente).toEqual({ id: CLIENTE, organizationId: ORG, phone: "9991234567", name: "Ana", orderCount: 0 });
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_restaurantes_upsert_customer_fn"))).toBe(true);
    expect(session.calls.some((c) => /insert into restaurantes\.customers/i.test(c))).toBe(false);
  });

  it("base sin migrar (42883): la transaccion se recupera y cae al camino directo", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select restaurantes\.upsert_customer/i, respond: () => sinFuncion("upsert_customer(uuid, text, text)") },
      { match: /select id, organization_id, phone, name, order_count from restaurantes\.customers/i, respond: () => [FILA_CLIENTE] },
      { match: /update restaurantes\.customers/i, respond: () => [FILA_CLIENTE] },
    ]);
    const cliente = await new PostgresRestaurantesRepository(session).upsertCustomer(ORG, "9991234567", "Ana");
    expect(cliente.id).toBe(CLIENTE);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_restaurantes_upsert_customer_fn"))).toBe(true);
  });

  it("un 42501 de la propia funcion (sesion con auth.uid()) se propaga: no se enmascara", async () => {
    const session = new AbortAwareFakeSession([{ match: /select restaurantes\.upsert_customer/i, respond: () => pgError("42501", "upsert_customer es solo para la sesión de sistema") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).upsertCustomer(ORG, "9991234567", "Ana")).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});

describe("addCustomerAddressIfNew (043)", () => {
  it("con la funcion: pasa organizacion, cliente y direccion", async () => {
    const session = new AbortAwareFakeSession([{ match: /select restaurantes\.add_customer_address_if_new/i, respond: () => [{ add_customer_address_if_new: null }] }]);
    await new PostgresRestaurantesRepository(session).addCustomerAddressIfNew(CLIENTE, "Calle 1 #2", ORG);
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_restaurantes_add_address_fn"))).toBe(true);
  });

  it("base sin migrar (42883): recupera la transaccion y cae al INSERT directo", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select restaurantes\.add_customer_address_if_new/i, respond: () => sinFuncion("add_customer_address_if_new(uuid, uuid, text)") },
      { match: /select count\(\*\)::text as count from restaurantes\.customer_addresses/i, respond: () => [{ count: "0" }] },
      { match: /insert into restaurantes\.customer_addresses/i, respond: () => [] },
    ]);
    await new PostgresRestaurantesRepository(session).addCustomerAddressIfNew(CLIENTE, "Calle 1 #2", ORG);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_restaurantes_add_address_fn"))).toBe(true);
    expect(session.calls.some((c) => /insert into restaurantes\.customer_addresses/i.test(c))).toBe(true);
  });

  it("cliente de otra organizacion (42501 de la funcion): se propaga y no inserta nada", async () => {
    const session = new AbortAwareFakeSession([{ match: /select restaurantes\.add_customer_address_if_new/i, respond: () => pgError("42501", "el cliente no pertenece a la organización") }]);
    await expect(new PostgresRestaurantesRepository(session).addCustomerAddressIfNew(CLIENTE, "Calle 1 #2", ORG)).rejects.toMatchObject({ code: "42501" });
    expect(session.calls.some((c) => /insert into restaurantes\.customer_addresses/i.test(c))).toBe(false);
  });
});

describe("createCallbackRequest (043)", () => {
  const ENTRADA = { organizationId: ORG, propertyId: PROP, customerName: "Ana", customerPhone: "+529991234567", reason: "queja", message: undefined, source: "whatsapp" as const };
  const CREADO = { id: "00000000-0000-4000-8000-0000000000d1", resolved: false, created_at: "2026-10-03T12:00:00.000Z" };
  // La notificacion in-app (best-effort, con su propio SAVEPOINT) se absorbe con un handler generico.
  const NOTIFICACION: FakeSessionHandler = { match: /notificacion|core\.notif|emitir/i, respond: () => [] };

  it("con la funcion: devuelve el aviso creado", async () => {
    const session = new AbortAwareFakeSession([{ match: /select restaurantes\.create_callback_request/i, respond: () => [{ callback: CREADO }] }, NOTIFICACION]);
    const aviso = await new PostgresRestaurantesRepository(session).createCallbackRequest(ENTRADA);
    expect(aviso).toMatchObject({ id: CREADO.id, resolved: false, customerName: "Ana", source: "whatsapp" });
    expect(session.calls.some((c) => /insert into restaurantes\.callback_requests/i.test(c))).toBe(false);
  });

  it("base sin migrar (42883): recupera la transaccion y cae al INSERT directo", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select restaurantes\.create_callback_request/i, respond: () => sinFuncion("create_callback_request(uuid, uuid, text, text, text, text, text)") },
      { match: /insert into restaurantes\.callback_requests/i, respond: () => [CREADO] },
      NOTIFICACION,
    ]);
    const aviso = await new PostgresRestaurantesRepository(session).createCallbackRequest(ENTRADA);
    expect(aviso.id).toBe(CREADO.id);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_restaurantes_callback_fn"))).toBe(true);
  });
});

describe("markInboundEventFailed (043)", () => {
  it("con la funcion: una sola llamada", async () => {
    const session = new AbortAwareFakeSession([{ match: /select restaurantes\.mark_whatsapp_inbound_failed/i, respond: () => [{ mark_whatsapp_inbound_failed: null }] }]);
    await new PostgresRestaurantesRepository(session).markInboundEventFailed(ORG, "wamid.1", "ConversationBusy");
    expect(session.calls.some((c) => /update restaurantes\.whatsapp_inbound_events/i.test(c))).toBe(false);
  });

  it("base sin migrar (42883): recupera la transaccion y cae al UPDATE directo, y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select restaurantes\.mark_whatsapp_inbound_failed/i, respond: () => sinFuncion("mark_whatsapp_inbound_failed(uuid, text, text)") },
      { match: /update restaurantes\.whatsapp_inbound_events/i, respond: () => [] },
      SIGUIENTE,
    ]);
    await new PostgresRestaurantesRepository(session).markInboundEventFailed(ORG, "wamid.1", "ConversationBusy");
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_restaurantes_inbound_failed_fn"))).toBe(true);
  });
});
