// R-12: estado (nuevo/en_curso/resuelto), asignacion y SLA de callbacks. El repositorio en memoria replica las reglas de
// callback_actualizar (migracion 033); las de RLS/GRANT las prueba scripts/verify-restaurantes-agente-config-callbacks/ contra
// Postgres real. El adaptador de Postgres se prueba contra AbortAwareFakeSession (base sin migrar -> SAVEPOINT).
import { describe, expect, it } from "vitest";
import {
  ConversacionesConflictoError,
  ConversacionesNoDisponibleError,
  ConversacionesRechazadaError,
  HandoffYaTomadoError,
  InMemoryConversacionesRepository,
  PostgresConversacionesRepository,
} from "../src/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const ANA = "00000000-0000-4000-8000-0000000000c1";
const LUIS = "00000000-0000-4000-8000-0000000000c2";
const JEFA = "00000000-0000-4000-8000-0000000000c3";
const CB = "00000000-0000-4000-8000-0000000000d1";
const NOMBRES = { [ANA]: "Ana", [LUIS]: "Luis", [JEFA]: "Jefa" };

function almacen() {
  const base = new InMemoryConversacionesRepository({ actorUserId: ANA, nombres: NOMBRES, ahora: () => new Date("2026-10-01T12:30:00.000Z") });
  base.callbacks.push({ organizationId: ORG, id: CB, propertyId: PROP, customerName: "Cliente", customerPhone: "+521", reason: "escalada:queja", message: null, source: "voice", resolved: false, createdAt: "2026-10-01T12:00:00.000Z", intentos: [] });
  return { base, ana: base.comoActor(ANA, false), luis: base.comoActor(LUIS, false), jefa: base.comoActor(JEFA, true) };
}

describe("InMemory: transiciones de estado", () => {
  it("tomar: nuevo -> en_curso, asignado a quien toma; otra persona recibe HandoffYaTomadoError; la jefa si puede reasignar", async () => {
    const { ana, luis, jefa } = almacen();
    expect(await ana.actualizarCallback(ORG, CB, "tomar", {})).toBe("en_curso");
    const [cb] = (await ana.listarCallbacks(ORG, PROP, true)).valor;
    expect(cb).toMatchObject({ estado: "en_curso", asignadoA: ANA, asignadoNombre: "Ana", tomadoAt: "2026-10-01T12:30:00.000Z" });
    await expect(luis.actualizarCallback(ORG, CB, "tomar", {})).rejects.toBeInstanceOf(HandoffYaTomadoError);
    expect(await jefa.actualizarCallback(ORG, CB, "asignar", { asignadoA: LUIS })).toBe("en_curso");
    expect((await ana.listarCallbacks(ORG, PROP, true)).valor[0]).toMatchObject({ asignadoA: LUIS });
  });

  it("asignar: solo owner/admin y solo a alguien de la organizacion; staff recibe ConversacionesRechazadaError", async () => {
    const { ana, jefa } = almacen();
    await expect(ana.actualizarCallback(ORG, CB, "asignar", { asignadoA: LUIS })).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    await expect(jefa.actualizarCallback(ORG, CB, "asignar", { asignadoA: "00000000-0000-4000-8000-00000000ffff" })).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    await expect(jefa.actualizarCallback(ORG, CB, "asignar", {})).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    const intacto = (await ana.listarCallbacks(ORG, PROP, false)).valor[0]!;
    expect(intacto).toMatchObject({ resolved: false });
    expect(intacto).not.toHaveProperty("asignadoA");
  });

  it("liberar: solo quien lo tiene (o la jefa); vuelve a nuevo sin asignado", async () => {
    const { ana, luis, jefa } = almacen();
    await ana.actualizarCallback(ORG, CB, "tomar", {});
    await expect(luis.actualizarCallback(ORG, CB, "liberar", {})).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    expect(await ana.actualizarCallback(ORG, CB, "liberar", {})).toBe("nuevo");
    await ana.actualizarCallback(ORG, CB, "tomar", {});
    expect(await jefa.actualizarCallback(ORG, CB, "liberar", {})).toBe("nuevo");
    expect((await jefa.listarCallbacks(ORG, PROP, false)).valor[0]).toMatchObject({ estado: "nuevo", asignadoA: null });
  });

  it("resolver: guarda quien, cuando y la nota; sale de 'solo abiertos'; resolver de nuevo es conflicto; solo la jefa reabre", async () => {
    const { ana, luis, jefa } = almacen();
    await ana.actualizarCallback(ORG, CB, "tomar", {});
    await expect(luis.actualizarCallback(ORG, CB, "resolver", {})).rejects.toBeInstanceOf(HandoffYaTomadoError);
    expect(await ana.actualizarCallback(ORG, CB, "resolver", { nota: "  Se le devolvio la llamada " })).toBe("resuelto");
    expect((await ana.listarCallbacks(ORG, PROP, true)).valor).toHaveLength(0);
    expect((await ana.listarCallbacks(ORG, PROP, false)).valor[0]).toMatchObject({ estado: "resuelto", resolved: true, resueltoPorNombre: "Ana", notaResolucion: "Se le devolvio la llamada", resueltoAt: "2026-10-01T12:30:00.000Z" });
    await expect(ana.actualizarCallback(ORG, CB, "resolver", {})).rejects.toBeInstanceOf(ConversacionesConflictoError);
    await expect(ana.actualizarCallback(ORG, CB, "reabrir", {})).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    expect(await jefa.actualizarCallback(ORG, CB, "reabrir", {})).toBe("nuevo");
    expect((await ana.listarCallbacks(ORG, PROP, true)).valor[0]).toMatchObject({ estado: "nuevo", resolved: false, resueltoAt: null, notaResolucion: null });
    await expect(jefa.actualizarCallback(ORG, CB, "reabrir", {})).rejects.toBeInstanceOf(ConversacionesConflictoError);
  });

  it("un intento 'no_contesto' pasa nuevo -> en_curso asignado a quien intento; 'contactado' resuelve", async () => {
    const { ana } = almacen();
    await ana.registrarIntentoCallback(ORG, CB, { resultado: "no_contesto", nota: null, proximoIntentoAt: null });
    expect((await ana.listarCallbacks(ORG, PROP, true)).valor[0]).toMatchObject({ estado: "en_curso", asignadoA: ANA });
    await ana.registrarIntentoCallback(ORG, CB, { resultado: "contactado", nota: null, proximoIntentoAt: null });
    expect((await ana.listarCallbacks(ORG, PROP, false)).valor[0]).toMatchObject({ estado: "resuelto", resolved: true, resueltoPorNombre: "Ana" });
  });

  it("otra organizacion: el callback no existe (rechazado), base sin migrar: no disponible", async () => {
    const { ana, base } = almacen();
    await expect(ana.actualizarCallback("00000000-0000-4000-8000-0000000000ee", CB, "tomar", {})).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    base.disponible = false;
    await expect(base.actualizarCallback(ORG, CB, "tomar", {})).rejects.toBeInstanceOf(ConversacionesNoDisponibleError);
  });
});

function pgError(code: string): Error & { code: string } {
  const e = new Error("pg") as Error & { code: string };
  e.code = code;
  return e;
}
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
async function sesionSigueViva(s: AbortAwareFakeSession) {
  await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}
const FILA = { id: CB, property_id: PROP, customer_name: "Cliente", customer_phone: "+521", reason: null, message: null, source: "voice", resolved: false, created_at: new Date("2026-10-01T12:00:00Z"), intentos: [] };
const LEER_033 = /from restaurantes\.callbacks_sucursal_estado\(/i;
const LEER_028 = /from restaurantes\.callbacks_sucursal\(/i;
const ACTUALIZAR = /select restaurantes\.callback_actualizar\(/i;

describe("Postgres: callbacks contra la base sin migrar (AbortAwareFakeSession)", () => {
  it("con la 033: mapea estado, asignacion y tiempos", async () => {
    const s = new AbortAwareFakeSession([
      { match: LEER_033, respond: () => [{ ...FILA, status: "en_curso", assigned_to: ANA, assigned_to_nombre: "Ana", assigned_at: new Date("2026-10-01T12:10:00Z"), taken_at: new Date("2026-10-01T12:10:00Z"), resolved_at: null, resolved_by_nombre: null, resolution_note: null }] },
    ]);
    const l = await new PostgresConversacionesRepository(s).listarCallbacks(ORG, PROP, true);
    expect(l.disponible).toBe(true);
    expect(l.valor[0]).toMatchObject({ estado: "en_curso", asignadoA: ANA, asignadoNombre: "Ana", tomadoAt: "2026-10-01T12:10:00.000Z", resueltoAt: null });
  });

  it("sin la 033 pero con la 028 (42883): cae a callbacks_sucursal con SAVEPOINT, sin estado, y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([{ match: LEER_033, respond: () => pgError("42883") }, { match: LEER_028, respond: () => [FILA] }, SIGUIENTE]);
    const l = await new PostgresConversacionesRepository(s).listarCallbacks(ORG, PROP, true);
    expect(l.disponible).toBe(true);
    expect(l.valor[0]).toMatchObject({ id: CB, resolved: false });
    expect(l.valor[0]).not.toHaveProperty("estado");
    await sesionSigueViva(s);
  });

  it("sin la 028 tampoco: disponible=false y lista vacia, la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([{ match: LEER_033, respond: () => pgError("42883") }, { match: LEER_028, respond: () => pgError("42883") }, SIGUIENTE]);
    expect(await new PostgresConversacionesRepository(s).listarCallbacks(ORG, PROP, true)).toEqual({ disponible: false, valor: [] });
    await sesionSigueViva(s);
  });

  it.each([
    ["42883", ConversacionesNoDisponibleError],
    ["55006", HandoffYaTomadoError],
    ["55000", ConversacionesConflictoError],
    ["42501", ConversacionesRechazadaError],
  ] as const)("actualizarCallback: SQLSTATE %s -> error de dominio y la sesion sigue viva", async (codigo, Clase) => {
    const s = new AbortAwareFakeSession([{ match: ACTUALIZAR, respond: () => pgError(codigo) }, SIGUIENTE]);
    await expect(new PostgresConversacionesRepository(s).actualizarCallback(ORG, CB, "tomar", {})).rejects.toBeInstanceOf(Clase);
    await sesionSigueViva(s);
  });

  it("actualizarCallback: pasa accion, asignado y nota a la funcion y devuelve el estado", async () => {
    const s = new AbortAwareFakeSession([{ match: ACTUALIZAR, respond: () => [{ status: "resuelto" }] }]);
    const original = s.query.bind(s);
    let params: unknown[] = [];
    s.query = (async (sql: string, p?: unknown[]) => {
      if (ACTUALIZAR.test(sql)) params = p ?? [];
      return original(sql, p);
    }) as typeof s.query;
    expect(await new PostgresConversacionesRepository(s).actualizarCallback(ORG, CB, "resolver", { nota: "listo" })).toBe("resuelto");
    expect(params).toEqual([ORG, CB, "resolver", null, "listo"]);
  });
});
