// Regla de notificaciones: un pedido nuevo (agente de WhatsApp/voz o checkout publico) y un contacto para devolver la llamada emiten
// la notificacion in-app del catalogo (`restaurantes.pedido.nuevo` / `restaurantes.callback.pendiente`) por el productor compartido:
// una por entidad (clave = id), sin PII y SIN romper el alta ni la transaccion del request contra la base sin migrar (SAVEPOINT).
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000d1";
const CALLBACK_ID = "00000000-0000-4000-8000-0000000000e1";
const EMITIR = /core\.emit_notification/i;
const CREAR_PEDIDO = /restaurantes\.create_order_idempotent/i;
const REGISTRAR_AGENTE = /restaurantes\.callback_registrar_agente/i;
const AVISO_NUEVO = { callback_id: CALLBACK_ID, resuelto: false, creado_at: "2026-10-01T10:00:00.000Z", registro: "nuevo" };
const INSERT_CALLBACK = /select restaurantes\.create_callback_request/i;
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente/, respond: () => [{ ok: true }] };

function filaPedido(source: string) {
  return {
    id: ORDER_ID,
    organization_id: ORG,
    property_id: PROP,
    customer_id: null,
    customer_name: "Ana Perez",
    customer_phone: "+525500000000",
    customer_address: "Calle Falsa 123",
    customer_email: null,
    branch: "Centro",
    total: 150,
    items: [],
    source,
    notes: null,
    payment_method: null,
    status: "pending",
    created_at: "2026-10-01T10:00:00.000Z",
  };
}

const PEDIDO = {
  organizationId: ORG,
  propertyId: PROP,
  customerId: null,
  customerName: "Ana Perez",
  customerPhone: "+525500000000",
  customerAddress: "Calle Falsa 123",
  customerEmail: null,
  branch: "Centro",
  total: 150,
  items: [],
  notes: null,
  paymentMethod: null,
  callTranscript: null,
  callRecordingUrl: null,
};

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Sesion que ademas deja registrados los parametros de cada emision. */
function conRegistro(handlers: FakeSessionHandler[]) {
  const session = new AbortAwareFakeSession(handlers);
  const vistos: unknown[][] = [];
  const original = session.query.bind(session);
  session.query = (async (sql: string, params?: unknown[]) => {
    if (EMITIR.test(sql)) vistos.push(params ?? []);
    return original(sql, params);
  }) as typeof session.query;
  return { session, vistos };
}

describe("restaurantes.pedido.nuevo", () => {
  it("un pedido de WhatsApp emite UN aviso con la clave del pedido, el evento del catalogo y sin PII", async () => {
    const { session, vistos } = conRegistro([
      { match: CREAR_PEDIDO, respond: () => [{ create_order_idempotent: filaPedido("whatsapp") }] },
      { match: EMITIR, respond: () => [{ emit_notification: 2 }] },
    ]);
    const pedido = await new PostgresRestaurantesRepository(session).createOrderIdempotent({ ...PEDIDO, source: "whatsapp" }, "fp", "k1");
    expect(pedido.id).toBe(ORDER_ID);
    expect(vistos).toHaveLength(1);
    const [p] = vistos;
    expect(p![0]).toBe(ORG);
    expect(p![1]).toBe(PROP);
    expect(p![2]).toBe("restaurantes.pedido.nuevo");
    expect(p![7]).toBe("/restaurantes/{orgSlug}/pedidos");
    expect(p![10]).toBe(`restaurantes.pedido.nuevo:${ORDER_ID}`);
    expect(p![11]).toEqual(["staff"]);
    expect(JSON.stringify(p)).not.toMatch(/Ana|5500000000|Calle Falsa/);
  });

  it("los pedidos capturados por el propio staff (admin) no avisan", async () => {
    const { session, vistos } = conRegistro([{ match: CREAR_PEDIDO, respond: () => [{ create_order_idempotent: filaPedido("admin") }] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    await new PostgresRestaurantesRepository(session).createOrderIdempotent({ ...PEDIDO, source: "admin" }, "fp", "k1");
    expect(vistos).toHaveLength(0);
  });

  it("base sin la migracion de notificaciones (42883): el pedido se crea y la MISMA sesion sigue viva (SAVEPOINT, sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: CREAR_PEDIDO, respond: () => [{ create_order_idempotent: filaPedido("voice") }] },
      { match: EMITIR, respond: () => pgError("42883", "function core.emit_notification does not exist") },
      SIGUIENTE,
    ]);
    const pedido = await new PostgresRestaurantesRepository(session).createOrderIdempotent({ ...PEDIDO, source: "voice" }, "fp", "k1");
    expect(pedido.id).toBe(ORDER_ID);
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });
});

describe("restaurantes.callback.pendiente", () => {
  const INPUT = { organizationId: ORG, propertyId: PROP, customerName: "Ana Perez", customerPhone: "+525500000000", reason: "queja", message: "quiero hablar con alguien", source: "voice" as const };

  it("un contacto anotado por el agente emite UN aviso con la clave de la solicitud; ni nombre, ni telefono ni mensaje viajan", async () => {
    const { session, vistos } = conRegistro([
      { match: REGISTRAR_AGENTE, respond: () => [AVISO_NUEVO] },
      { match: EMITIR, respond: () => [{ emit_notification: 1 }] },
    ]);
    const r = await new PostgresRestaurantesRepository(session).createCallbackRequest(INPUT);
    expect(r.id).toBe(CALLBACK_ID);
    expect(vistos).toHaveLength(1);
    expect(vistos[0]![2]).toBe("restaurantes.callback.pendiente");
    expect(vistos[0]![10]).toBe(`restaurantes.callback.pendiente:${CALLBACK_ID}`);
    expect(vistos[0]![7]).toBe("/restaurantes/{orgSlug}/conversaciones");
    expect(JSON.stringify(vistos[0])).not.toMatch(/Ana|5500000000|queja|hablar/);
  });

  it("base sin migrar (42883): el contacto queda anotado y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: REGISTRAR_AGENTE, respond: () => [AVISO_NUEVO] },
      { match: EMITIR, respond: () => pgError("42883", "function core.emit_notification does not exist") },
      SIGUIENTE,
    ]);
    const r = await new PostgresRestaurantesRepository(session).createCallbackRequest(INPUT);
    expect(r.id).toBe(CALLBACK_ID);
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("reason cliente_llego emite el aviso URGENTE propio (restaurantes.cliente.llego, enlace a pedidos) y NO el generico; sin PII", async () => {
    const { session, vistos } = conRegistro([
      { match: REGISTRAR_AGENTE, respond: () => [AVISO_NUEVO] },
      { match: EMITIR, respond: () => [{ emit_notification: 1 }] },
    ]);
    await new PostgresRestaurantesRepository(session).createCallbackRequest({ ...INPUT, reason: "cliente_llego", message: "auto gris afuera", source: "whatsapp" });
    expect(vistos).toHaveLength(1);
    expect(vistos[0]![2]).toBe("restaurantes.cliente.llego");
    expect(vistos[0]![10]).toBe(`restaurantes.cliente.llego:${CALLBACK_ID}`);
    expect(vistos[0]![7]).toBe("/restaurantes/{orgSlug}/pedidos");
    expect(JSON.stringify(vistos[0])).not.toMatch(/Ana|5500000000|auto gris/);
  });
});

describe("restaurantes.evento.solicitud (R-43)", () => {
  const EVENTO = { organizationId: ORG, propertyId: PROP, customerName: "Ana Perez", customerPhone: "9991234567", reason: "evento", message: "Fecha del evento: 2026-11-15\nPersonas: 40", source: "web" as const };

  it("una solicitud de evento emite el aviso PROPIO (no el generico de callback) con la clave de la solicitud y sin PII", async () => {
    const { session, vistos } = conRegistro([
      { match: INSERT_CALLBACK, respond: () => [{ callback: { id: CALLBACK_ID, resolved: false, created_at: "2026-10-01T10:00:00.000Z" } }] },
      { match: EMITIR, respond: () => [{ emit_notification: 1 }] },
    ]);
    await new PostgresRestaurantesRepository(session).createCallbackRequest(EVENTO);
    expect(vistos).toHaveLength(1);
    expect(vistos[0]![2]).toBe("restaurantes.evento.solicitud");
    expect(vistos[0]![10]).toBe(`restaurantes.evento.solicitud:${CALLBACK_ID}`);
    expect(vistos[0]![7]).toBe("/restaurantes/{orgSlug}/conversaciones");
    expect(JSON.stringify(vistos[0])).not.toMatch(/Ana|9991234567|2026-11-15|Personas/);
  });

  it("base sin migrar (42883): la solicitud queda registrada y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: INSERT_CALLBACK, respond: () => [{ callback: { id: CALLBACK_ID, resolved: false, created_at: "2026-10-01T10:00:00.000Z" } }] },
      { match: EMITIR, respond: () => pgError("42883", "function core.emit_notification does not exist") },
      SIGUIENTE,
    ]);
    const r = await new PostgresRestaurantesRepository(session).createCallbackRequest(EVENTO);
    expect(r.id).toBe(CALLBACK_ID);
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});

describe("registro de la solicitud de contacto: funcion de sistema con respaldo (migracion 062)", () => {
  const INPUT = { organizationId: ORG, propertyId: PROP, customerName: "Ana Perez", customerPhone: "9991234567", reason: "evento", message: "m", source: "web" as const };
  // Base sin la 048 (`create_callback_request`, 42883): el repositorio cae a `callback_registrar` (062) y despues al INSERT directo.
  const SIN_048 = { match: /create_callback_request/, respond: () => pgError("42883", "function restaurantes.create_callback_request does not exist") };
  const FILA = { id: CALLBACK_ID, resolved: false, created_at: "2026-10-01T10:00:00.000Z" };

  it("la sesion de la API corre como `authenticated` (sin INSERT sobre la tabla): se registra por callback_registrar con los 7 parametros en orden", async () => {
    const llamadas: Array<{ sql: string; params: unknown[] }> = [];
    const session = new AbortAwareFakeSession([SIN_048, { match: /callback_registrar/, respond: () => [FILA] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      llamadas.push({ sql, params: params ?? [] });
      return original(sql, params);
    }) as typeof session.query;
    await new PostgresRestaurantesRepository(session).createCallbackRequest(INPUT);
    const registro = llamadas.find((c) => /callback_registrar/.test(c.sql))!;
    expect(registro.params).toEqual([ORG, PROP, "Ana Perez", "9991234567", "evento", "m", "web"]);
    expect(llamadas.some((c) => /insert into restaurantes\.callback_requests/i.test(c.sql))).toBe(false);
  });

  it("base sin la 062 (42883): cae al INSERT anterior dentro de un SAVEPOINT y la sesion sigue viva (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      SIN_048,
      { match: /callback_registrar/, respond: () => pgError("42883", "function restaurantes.callback_registrar does not exist") },
      { match: /insert into restaurantes\.callback_requests/i, respond: () => [FILA] },
      { match: EMITIR, respond: () => [{ emit_notification: 1 }] },
      SIGUIENTE,
    ]);
    const r = await new PostgresRestaurantesRepository(session).createCallbackRequest(INPUT);
    expect(r.id).toBe(CALLBACK_ID);
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un rechazo real de la funcion (sucursal ajena 42501 o datos fuera de rango 22023) NO se esconde detras del INSERT: se propaga", async () => {
    for (const code of ["42501", "22023"]) {
      const session = new AbortAwareFakeSession([SIN_048, { match: /callback_registrar/, respond: () => pgError(code, "rechazado") }, SIGUIENTE]);
      await expect(new PostgresRestaurantesRepository(session).createCallbackRequest(INPUT)).rejects.toMatchObject({ code });
    }
  });
});
