// REGLA DURA de compatibilidad con la base SIN migrar: PostgresComandaOutboxStore corre
// dentro de la transaccion compartida del request. Un 42883/42P01/42703 sin SAVEPOINT
// deja esa transaccion abortada (25P02) y el COMMIT devuelve ROLLBACK: se perderia el
// PEDIDO que ya se habia creado. `AbortAwareFakeSession` reproduce ese estado abortado;
// una sesion falsa plana NO sirve para probarlo.
import { describe, expect, it, vi } from "vitest";
import { FakeSoftRestaurantAdapter } from "../src/softrestaurant/fake-adapter.ts";
import { MapaProductoCodigo } from "../src/softrestaurant/catalog-map.ts";
import { PostgresComandaOutboxStore, mapFilaComanda } from "../src/softrestaurant/outbox-postgres-store.ts";
import { crearResolverSucursalPos, encolarComandaParaPedido } from "../src/softrestaurant/outbox-service.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const SIGUIENTE_QUERY: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] };
const ORG = "11111111-1111-1111-1111-111111111111";
const PROP = "22222222-2222-2222-2222-222222222222";

/** Sesion donde TODA funcion/tabla de la migracion 024 no existe (base sin migrar). */
function sesionSinMigrar(): AbortAwareFakeSession {
  return new AbortAwareFakeSession([
    { match: /restaurantes\.softrestaurant_modo|restaurantes\.set_softrestaurant_modo|restaurantes\.pos_comanda_/i, respond: () => pgError("42883", "function restaurantes.* does not exist") },
    { match: /from restaurantes\.pos_comanda_outbox/i, respond: () => pgError("42P01", 'relation "restaurantes.pos_comanda_outbox" does not exist') },
    SIGUIENTE_QUERY,
  ]);
}

async function sigueUsable(s: AbortAwareFakeSession) {
  const r = await s.query<{ ok: boolean }>("select 1 as siguiente_query_del_request");
  expect(r.rows).toEqual([{ ok: true }]);
}

describe("PostgresComandaOutboxStore contra la base SIN migrar", () => {
  it("leerModo => apagado y la transaccion sigue usable (sin 25P02)", async () => {
    const s = sesionSinMigrar();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await new PostgresComandaOutboxStore(s).leerModo(ORG)).toBe("apagado");
    await sigueUsable(s);
  });

  it("fijarModo => disponible:false", async () => {
    const s = sesionSinMigrar();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await new PostgresComandaOutboxStore(s).fijarModo(ORG, "activo")).toEqual({ disponible: false });
    await sigueUsable(s);
  });

  it("encolar / reclamar / completar => vacio honesto y la sesion sigue usable", async () => {
    const s = sesionSinMigrar();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new PostgresComandaOutboxStore(s);
    const payload = { idempotencyKey: "k", sucursal: "T1", tipo: "recoger", cliente: { nombre: "A", telefono: "1" }, formaPago: "efectivo", items: [] } as const;
    expect(await store.encolar({ organizationId: ORG, propertyId: PROP, orderId: "o", idempotencyKey: "k", modo: "activo", payload, maxIntentos: 5 })).toEqual({ disponible: false });
    await sigueUsable(s);
    expect(await store.reclamarLote(5, new Date(), 1000)).toEqual([]);
    expect(await store.reclamarPorId("x", new Date(), 1000)).toBeNull();
    expect(await store.completar("x", { estado: "fallida", folio: null, ultimoError: "e", proximoIntentoEn: new Date(), alertarCapturaManual: false })).toBe(false);
    await sigueUsable(s);
  });

  it("listar y resumen => disponible:false (nunca una lista vacia fingida ni un 500)", async () => {
    const s = sesionSinMigrar();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new PostgresComandaOutboxStore(s);
    expect(await store.listar(ORG, { propertyIds: null, limite: 10, offset: 0 })).toEqual({ disponible: false, filas: [] });
    const r = await store.resumen(ORG, [PROP]);
    expect(r.disponible).toBe(false);
    await sigueUsable(s);
  });

  it("marcarCapturada => no_disponible", async () => {
    const s = sesionSinMigrar();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await new PostgresComandaOutboxStore(s).marcarCapturada(ORG, "x", "u", null)).toEqual({ resultado: "no_disponible" });
    await sigueUsable(s);
  });

  it("el enganche del pedido no rompe la transaccion: el agente sigue como hoy y la sesion queda usable", async () => {
    const s = sesionSinMigrar();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new PostgresComandaOutboxStore(s);
    const r = await encolarComandaParaPedido(
      { store, port: new FakeSoftRestaurantAdapter(), resolverCodigos: new MapaProductoCodigo(), resolverSucursal: crearResolverSucursalPos() },
      {
        order: { id: "o1", organizationId: ORG, propertyId: PROP, customerName: "Ana", customerPhone: "9990001111", customerAddress: "Calle 1", notes: null, paymentMethod: "efectivo", items: [], branch: "T1" },
      },
    );
    expect(r).toMatchObject({ modo: "apagado", agente: null });
    await sigueUsable(s);
  });
});

describe("PostgresComandaOutboxStore: errores reales y camino feliz", () => {
  it("un error NO de compatibilidad se repropaga, pero deja la sesion recuperada con ROLLBACK TO SAVEPOINT", async () => {
    const s = new AbortAwareFakeSession([
      { match: /restaurantes\.softrestaurant_modo/i, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      SIGUIENTE_QUERY,
    ]);
    await expect(new PostgresComandaOutboxStore(s).leerModo(ORG)).rejects.toMatchObject({ code: "57014" });
    await sigueUsable(s);
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("marcarCapturada traduce los errores de negocio de la funcion SQL a resultados", async () => {
    const casos: Array<[string, string]> = [
      ["P0002", "no_encontrada"],
      ["55000", "estado_invalido"],
      ["42501", "prohibido"],
    ];
    for (const [code, esperado] of casos) {
      const s = new AbortAwareFakeSession([{ match: /pos_comanda_marcar_capturada/i, respond: () => pgError(code, "x") }, SIGUIENTE_QUERY]);
      expect(await new PostgresComandaOutboxStore(s).marcarCapturada(ORG, "id", "u", "n")).toEqual({ resultado: esperado });
      await sigueUsable(s);
    }
  });

  it("mapFilaComanda convierte fechas y acepta payload como texto JSON", () => {
    const fila = mapFilaComanda({
      id: "i",
      organization_id: ORG,
      property_id: PROP,
      order_id: "o",
      estado: "fallida",
      modo: "activo",
      payload: JSON.stringify({ idempotencyKey: "k", sucursal: "T1", tipo: "recoger", cliente: { nombre: "A", telefono: "1" }, formaPago: "efectivo", items: [] }),
      intentos: "2",
      max_intentos: 5,
      proximo_intento_en: new Date("2026-09-30T18:00:00.000Z"),
      folio: null,
      ultimo_error: "no_disponible:timeout",
      capturado_por: null,
      capturado_en: null,
      nota_captura: null,
      creado_en: "2026-09-30T17:00:00.000Z",
      actualizado_en: new Date("2026-09-30T17:30:00.000Z"),
    });
    expect(fila).toMatchObject({ estado: "fallida", intentos: 2, maxIntentos: 5, proximoIntentoEn: "2026-09-30T18:00:00.000Z", creadoEn: "2026-09-30T17:00:00.000Z" });
    expect(fila.payload.cliente.nombre).toBe("A");
    expect(() => mapFilaComanda({ ...({} as never), estado: "inventado" })).toThrow(/estado desconocido/);
  });

  it("listar pide solo columnas con GRANT (nunca idempotency_key ni reclamada_en) y filtra por sucursal/estado", async () => {
    let sqlVisto = "";
    let paramsVistos: unknown[] = [];
    const s: AbortAwareFakeSession = new AbortAwareFakeSession([]);
    const original = s.query.bind(s);
    s.query = (async (sql: string, params?: unknown[]) => {
      sqlVisto = sql;
      paramsVistos = params ?? [];
      return { rows: [] };
    }) as typeof original;
    const r = await new PostgresComandaOutboxStore(s).listar(ORG, { propertyIds: [PROP], estados: ["captura_manual", "fallida"], limite: 500, offset: 3 });
    expect(r).toEqual({ disponible: true, filas: [] });
    expect(sqlVisto).not.toMatch(/idempotency_key|reclamada_en|select \*/i);
    expect(sqlVisto).toMatch(/property_id = any\(\$2::uuid\[\]\)/);
    expect(sqlVisto).toMatch(/estado = any\(\$3::text\[\]\)/);
    expect(paramsVistos).toEqual([ORG, [PROP], ["captura_manual", "fallida"], 200, 3]);
  });
});
