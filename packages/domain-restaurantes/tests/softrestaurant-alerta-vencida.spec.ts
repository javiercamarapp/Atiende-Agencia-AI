// Alerta de comanda esperando captura manual: emision por el productor compartido, idempotencia (dedupe) y comportamiento contra la
// base SIN migrar (AbortAwareFakeSession: una sesion falsa plana no reproduce la transaccion abortada).
import { describe, expect, it, vi } from "vitest";
import { barrerCapturaManualVencida } from "../src/softrestaurant/alerta-vencida.ts";
import { InMemoryComandaOutboxStore } from "../src/softrestaurant/outbox-memory-store.ts";
import { PostgresComandaOutboxStore } from "../src/softrestaurant/outbox-postgres-store.ts";
import type { ComandaInput } from "../src/softrestaurant/types.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000a001";
const PROP_A = "00000000-0000-0000-0000-00000000c001";
const PROP_B = "00000000-0000-0000-0000-00000000c002";
const PAYLOAD: ComandaInput = { idempotencyKey: "k", sucursal: "T1", tipo: "recoger", cliente: { nombre: "Ana", telefono: "9991112222" }, formaPago: "efectivo", items: [{ codigo: "X", cantidad: 1, modificadores: [] }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Sesion falsa con la semantica de dedupe de core.emit_notification: la segunda emision de la misma clave inserta 0. */
function sesionConDedupe() {
  const vistas = new Set<string>();
  const emisiones: unknown[][] = [];
  const session = new AbortAwareFakeSession([{ match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] }]);
  const original = session.query.bind(session);
  session.query = (async (sql: string, p?: unknown[]) => {
    if (/select core\.emit_notification/.test(sql)) {
      const clave = String((p ?? [])[10]);
      emisiones.push(p ?? []);
      if (vistas.has(clave)) return { rows: [{ emit_notification: 0 }] };
      vistas.add(clave);
    }
    return original(sql, p);
  }) as typeof session.query;
  return { session, emisiones };
}

async function capturaManualHace(store: InMemoryComandaOutboxStore, propertyId: string, minutos: number, reloj: { ahora: Date }): Promise<string> {
  reloj.ahora = new Date(Date.now() - minutos * 60_000);
  store.ponerModo(ORG, "activo");
  const orderId = crypto.randomUUID();
  const r = await store.encolar({ organizationId: ORG, propertyId, orderId, idempotencyKey: `k-${orderId}`, modo: "activo", payload: PAYLOAD, maxIntentos: 5 });
  if (!r.disponible) throw new Error("no disponible");
  await store.reclamarPorId(r.fila.id, reloj.ahora, 1000);
  await store.completar(r.fila.id, { estado: "captura_manual", folio: null, ultimoError: "rechazada:x", proximoIntentoEn: null, alertarCapturaManual: true });
  return r.fila.id;
}

function nuevoStore() {
  const reloj = { ahora: new Date() };
  const store = new InMemoryComandaOutboxStore({ ahora: () => reloj.ahora });
  store.registrarSucursal(PROP_A, ORG);
  store.registrarSucursal(PROP_B, ORG);
  return { store, reloj };
}

describe("barrerCapturaManualVencida", () => {
  it("emite una alerta por comanda vencida (umbral 5 min por omision), con texto del catalogo, enlace relativo y solo los minutos", async () => {
    const { store, reloj } = nuevoStore();
    const vencida = await capturaManualHace(store, PROP_A, 12, reloj);
    await capturaManualHace(store, PROP_A, 2, reloj); // aun no vence
    const { session, emisiones } = sesionConDedupe();
    const r = await barrerCapturaManualVencida(session, store);
    expect(r).toEqual({ disponible: true, candidatas: 1, emitidas: 1, sinNuevas: 0, errores: 0 });
    const e = emisiones[0]!;
    expect(e[2]).toBe("restaurantes.comanda.captura_manual_vencida");
    expect(e[4]).toBe("atencion");
    expect(e[5]).toBe("Una comanda espera captura manual en el POS");
    expect(String(e[6])).toContain("Lleva 12 minutos");
    expect(e[7]).toBe("/restaurantes/{orgSlug}/comandas-pos");
    expect(e[10]).toBe(`restaurantes.comanda.captura_manual_vencida:${vencida}`);
    expect(JSON.stringify(e)).not.toMatch(/Ana|9991112222/);
  });

  it("idempotente: dos ticks dejan UNA alerta por comanda (el segundo cuenta sinNuevas)", async () => {
    const { store, reloj } = nuevoStore();
    await capturaManualHace(store, PROP_A, 12, reloj);
    const { session } = sesionConDedupe();
    const primero = await barrerCapturaManualVencida(session, store);
    const segundo = await barrerCapturaManualVencida(session, store);
    expect(primero.emitidas).toBe(1);
    expect(segundo).toEqual({ disponible: true, candidatas: 1, emitidas: 0, sinNuevas: 1, errores: 0 });
  });

  it("el umbral es por sucursal: con 30 min en A no avisa, con 5 min por omision en B si", async () => {
    const { store, reloj } = nuevoStore();
    await capturaManualHace(store, PROP_A, 12, reloj);
    const enB = await capturaManualHace(store, PROP_B, 12, reloj);
    await store.fijarUmbralCapturaManual(PROP_A, 30);
    const { session, emisiones } = sesionConDedupe();
    const r = await barrerCapturaManualVencida(session, store);
    expect(r.candidatas).toBe(1);
    expect(emisiones[0]![10]).toBe(`restaurantes.comanda.captura_manual_vencida:${enB}`);
  });

  it("una comanda capturada a mano deja de ser candidata", async () => {
    const { store, reloj } = nuevoStore();
    const id = await capturaManualHace(store, PROP_A, 12, reloj);
    await store.marcarCapturada(ORG, id, "u", "folio 123");
    const { session, emisiones } = sesionConDedupe();
    expect((await barrerCapturaManualVencida(session, store)).candidatas).toBe(0);
    expect(emisiones).toHaveLength(0);
  });

  it("store sin la migracion => disponible:false y no emite", async () => {
    const { store } = nuevoStore();
    store.disponible = false;
    const { session, emisiones } = sesionConDedupe();
    expect(await barrerCapturaManualVencida(session, store)).toEqual({ disponible: false, candidatas: 0, emitidas: 0, sinNuevas: 0, errores: 0 });
    expect(emisiones).toHaveLength(0);
  });
});

describe("PostgresComandaOutboxStore (migracion 054) contra la base SIN migrar", () => {
  function sinMigrar(): AbortAwareFakeSession {
    return new AbortAwareFakeSession([
      { match: /restaurantes\.pos_comandas_captura_manual_vencidas|restaurantes\.set_umbral_captura_manual/i, respond: () => pgError("42883", "function restaurantes.* does not exist") },
      { match: /from restaurantes\.pos_comanda_alerta_config/i, respond: () => pgError("42P01", 'relation "restaurantes.pos_comanda_alerta_config" does not exist') },
      { match: /select order_id, estado from restaurantes\.pos_comanda_outbox/i, respond: () => [{ order_id: "o1", estado: "captura_manual" }] },
      { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
  }
  async function sigueUsable(s: AbortAwareFakeSession) {
    expect((await s.query<{ ok: boolean }>("select 1 as siguiente_query_del_request")).rows).toEqual([{ ok: true }]);
  }

  it("candidatos / umbrales / fijar => vacio honesto y la transaccion sigue usable (sin 25P02)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = sinMigrar();
    const store = new PostgresComandaOutboxStore(s);
    expect(await store.listarCapturaManualVencidas(new Date())).toEqual({ disponible: false, filas: [] });
    await sigueUsable(s);
    expect(await store.leerUmbralesCapturaManual(ORG)).toEqual({ disponible: false, porSucursal: {} });
    await sigueUsable(s);
    expect(await store.fijarUmbralCapturaManual(PROP_A, 10)).toEqual({ disponible: false });
    await sigueUsable(s);
  });

  it("estadosPorPedidos solo usa la tabla de la migracion 024 (existe en la base de produccion) y devuelve los estados", async () => {
    const s = sinMigrar();
    const r = await new PostgresComandaOutboxStore(s).estadosPorPedidos(ORG, ["o1", "o2"]);
    expect(r).toEqual({ disponible: true, estados: { o1: "captura_manual" } });
  });

  it("un error de permisos al fijar el umbral se repropaga (el route lo traduce a 403)", async () => {
    const s = new AbortAwareFakeSession([{ match: /set_umbral_captura_manual/i, respond: () => pgError("42501", "requiere owner/admin") }]);
    await expect(new PostgresComandaOutboxStore(s).fijarUmbralCapturaManual(PROP_A, 10)).rejects.toMatchObject({ code: "42501" });
  });
});
