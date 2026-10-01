// D-11 (migracion 017): el repositorio corre en la transaccion compartida del request. REGLA DURA de
// compatibilidad: contra la base SIN migrar, 42883/42P01/42703 degradan a `{ disponible: false }` SIN dejar la
// transaccion abortada (25P02); AbortAwareFakeSession reproduce ese estado (una sesion falsa plana no). Tambien
// fija la traduccion de SQLSTATE a errores de dominio, que el listado del outbox no pide `telefono` y el
// comportamiento del repositorio en memoria (cross-tenant, consentimiento, dedupe, topes).
import { describe, expect, it } from "vitest";
import {
  ColaCuotaExcedidaError,
  ColaEntradaInvalidaError,
  ColaEstadoInvalidoError,
  ColaNoEncontradaError,
  ColaSinAccesoError,
  ColaSinConsentimientoError,
  InMemoryColaCobranzaRepository,
  PostgresColaCobranzaRepository,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

const PROP = "00000000-0000-0000-0000-0000000000b1";
const CUENTA = "00000000-0000-0000-0000-0000000000e1";
const SIGUIENTE = /select 1/;

describe("PostgresColaCobranzaRepository -- base SIN migrar (REGLA DURA)", () => {
  const casos: [string, () => Error][] = [
    ["42883 funcion inexistente", () => pgError("42883", "function despachos.cobranza_gestion_crear(uuid, uuid, text, text, bigint, date, date) does not exist")],
    ["42P01 tabla inexistente", () => pgError("42P01", 'relation "despachos.cobranza_gestion" does not exist')],
    ["42703 columna inexistente", () => pgError("42703", 'column "x" does not exist')],
  ];

  for (const [nombre, error] of casos) {
    it(`${nombre}: degrada a no disponible y la transaccion sigue utilizable`, async () => {
      const session = new AbortAwareFakeSession([{ match: /cobranza_/i, respond: error }, { match: SIGUIENTE, respond: () => [{ ok: 1 }] }]);
      const repo = new PostgresColaCobranzaRepository(session);
      expect(await repo.listarGestiones(PROP)).toEqual({ disponible: false });
      // La consulta POSTERIOR del mismo request no falla con 25P02 (sin SAVEPOINT fallaria).
      expect(await session.query("select 1")).toEqual({ rows: [{ ok: 1 }] });
      expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    });
  }

  it("las 7 operaciones degradan a no disponible y dejan la sesion utilizable tras cada una", async () => {
    const session = new AbortAwareFakeSession([{ match: /cobranza_/i, respond: () => pgError("42P01", 'relation "despachos.cobranza_gestion" does not exist') }, { match: SIGUIENTE, respond: () => [{ ok: 1 }] }]);
    const repo = new PostgresColaCobranzaRepository(session);
    const resultados = [
      await repo.listarGestiones(PROP),
      await repo.crearGestion({ propertyId: PROP, receivableId: CUENTA, tipo: "nota", nota: "x", montoPromesaCentavos: null, fechaPromesa: null, fechaSeguimiento: null }),
      await repo.resolverGestion(PROP, CUENTA, "cancelada", null),
      await repo.listarConsentimientos(PROP),
      await repo.fijarConsentimiento({ propertyId: PROP, rfcReceptor: "RRR010101RR1", telefono: "+529981234567", estado: "opt_out", evidencia: null }),
      await repo.encolarWhatsApp({ propertyId: PROP, receivableId: CUENTA, cuerpo: "hola", dedupeKey: "k" }),
      await repo.listarOutbox(PROP),
    ];
    for (const r of resultados) expect(r).toEqual({ disponible: false });
    expect(await session.query("select 1")).toEqual({ rows: [{ ok: 1 }] });
  });

  it("un 42883 de una funcion AJENA a cobranza_ no se enmascara como migracion pendiente", async () => {
    const session = new AbortAwareFakeSession([{ match: /cobranza_/i, respond: () => pgError("42883", "function core.otra_cosa(uuid) does not exist") }]);
    const repo = new PostgresColaCobranzaRepository(session);
    await expect(repo.crearGestion({ propertyId: PROP, receivableId: CUENTA, tipo: "recordatorio", nota: null, montoPromesaCentavos: null, fechaPromesa: null, fechaSeguimiento: null })).rejects.toMatchObject({ code: "42883" });
  });
});

describe("PostgresColaCobranzaRepository -- SQLSTATE a errores de dominio (sin dejar la sesion abortada)", () => {
  const tabla: [string, unknown][] = [
    ["P0002", ColaNoEncontradaError],
    ["42501", ColaSinAccesoError],
    ["54000", ColaCuotaExcedidaError],
    ["55000", ColaEstadoInvalidoError],
    ["CB001", ColaSinConsentimientoError],
    ["22023", ColaEntradaInvalidaError],
    ["23514", ColaEntradaInvalidaError],
  ];
  for (const [code, clase] of tabla) {
    it(`${code} -> ${(clase as { name: string }).name}`, async () => {
      const session = new AbortAwareFakeSession([{ match: /cobranza_gestion_resolver/i, respond: () => pgError(code, "boom interno de postgres") }, { match: SIGUIENTE, respond: () => [{ ok: 1 }] }]);
      const repo = new PostgresColaCobranzaRepository(session);
      const err = await repo.resolverGestion(PROP, CUENTA, "cumplida", null).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(clase as new () => Error);
      expect((err as Error).message).not.toContain("boom interno");
      expect(await session.query("select 1")).toEqual({ rows: [{ ok: 1 }] });
    });
  }

  it("un error desconocido se relanza tal cual", async () => {
    const session = new AbortAwareFakeSession([{ match: /cobranza_gestion_resolver/i, respond: () => pgError("XX000", "interno") }]);
    await expect(new PostgresColaCobranzaRepository(session).resolverGestion(PROP, CUENTA, "cumplida", null)).rejects.toMatchObject({ code: "XX000" });
  });
});

describe("PostgresColaCobranzaRepository -- forma de las consultas", () => {
  it("mapea filas: centavos como numero, fechas YYYY-MM-DD y filtros nulos", async () => {
    let params: unknown[] | undefined;
    const session = {
      async query(sql: string, p?: unknown[]) {
        params = p;
        expect(sql).toMatch(/from despachos\.cobranza_gestion/);
        return { rows: [{ id: "g1", receivable_id: CUENTA, tipo: "promesa_pago", estado: "pendiente", monto_promesa_centavos: "150000", fecha_promesa: "2026-10-15", fecha_seguimiento: null, nota: null, creado_en: new Date("2026-10-01T10:00:00Z"), actualizado_en: "2026-10-01T10:00:00.000Z" }] };
      },
      async exec() {},
    };
    const r = await new PostgresColaCobranzaRepository(session as never).listarGestiones(PROP);
    expect(params).toEqual([PROP, null, null]);
    expect(r).toEqual({ disponible: true, valor: [{ id: "g1", receivableId: CUENTA, tipo: "promesa_pago", estado: "pendiente", montoPromesaCentavos: 150000, fechaPromesa: "2026-10-15", fechaSeguimiento: null, nota: null, creadoEn: "2026-10-01T10:00:00.000Z", actualizadoEn: "2026-10-01T10:00:00.000Z" }] });
  });

  it("el listado del outbox NO pide la columna telefono (PII)", async () => {
    const sqls: string[] = [];
    const session = { async query(sql: string) { sqls.push(sql); return { rows: [] }; }, async exec() {} };
    await new PostgresColaCobranzaRepository(session as never).listarOutbox(PROP);
    const select = sqls.find((s) => /cobranza_whatsapp_outbox/.test(s))!;
    expect(select).not.toMatch(/telefono/);
  });
});

describe("InMemoryColaCobranzaRepository", () => {
  const OTRA = "00000000-0000-0000-0000-0000000000b2";
  const CUENTAS = [
    { propertyId: PROP, receivableId: CUENTA, rfcReceptor: "RRR010101RR1" },
    { propertyId: PROP, receivableId: "c2", rfcReceptor: "RRS020202RS2" },
    { propertyId: PROP, receivableId: "pagada", rfcReceptor: "RRR010101RR1", pagada: true },
    { propertyId: OTRA, receivableId: "ajena", rfcReceptor: "RRR010101RR1" },
  ];
  const nueva = (over: Record<string, unknown> = {}) => ({ propertyId: PROP, receivableId: CUENTA, tipo: "nota" as const, nota: "ok", montoPromesaCentavos: null, fechaPromesa: null, fechaSeguimiento: null, ...over });

  it("ciclo de una promesa: se crea pendiente, se lista y se resuelve una sola vez", async () => {
    const repo = new InMemoryColaCobranzaRepository(CUENTAS);
    const c = await repo.crearGestion(nueva({ tipo: "promesa_pago", nota: null, montoPromesaCentavos: 150000, fechaPromesa: "2026-01-20" }));
    expect(c.disponible).toBe(true);
    const id = (c as { valor: { id: string } }).valor.id;
    expect(await repo.listarGestiones(PROP, { estado: "pendiente" })).toMatchObject({ valor: [{ id, estado: "pendiente", montoPromesaCentavos: 150000 }] });
    await repo.resolverGestion(PROP, id, "cumplida", "Pago recibido");
    expect(await repo.listarGestiones(PROP, { estado: "pendiente" })).toMatchObject({ valor: [] });
    await expect(repo.resolverGestion(PROP, id, "cancelada", null)).rejects.toBeInstanceOf(ColaEstadoInvalidoError);
  });

  it("aislamiento cross-tenant y cross-cliente: cuenta o gestion de otra property = no encontrada", async () => {
    const repo = new InMemoryColaCobranzaRepository(CUENTAS);
    await expect(repo.crearGestion(nueva({ receivableId: "ajena" }))).rejects.toBeInstanceOf(ColaNoEncontradaError);
    const c = (await repo.crearGestion({ ...nueva({ receivableId: "ajena", propertyId: OTRA }) })) as { valor: { id: string } };
    await expect(repo.resolverGestion(PROP, c.valor.id, "cancelada", null)).rejects.toBeInstanceOf(ColaNoEncontradaError);
    expect(await repo.listarGestiones(PROP)).toMatchObject({ valor: [] });
  });

  it("rechaza promesa sobre cuenta pagada, monto invalido y topes", async () => {
    const repo = new InMemoryColaCobranzaRepository(CUENTAS);
    await expect(repo.crearGestion(nueva({ receivableId: "pagada", tipo: "promesa_pago", nota: null, montoPromesaCentavos: 100, fechaPromesa: "2026-01-20" }))).rejects.toBeInstanceOf(ColaEntradaInvalidaError);
    await expect(repo.crearGestion(nueva({ tipo: "promesa_pago", nota: null, montoPromesaCentavos: 0, fechaPromesa: "2026-01-20" }))).rejects.toBeInstanceOf(ColaEntradaInvalidaError);
    for (let i = 0; i < 500; i++) await repo.crearGestion(nueva({ receivableId: "c2" }));
    await expect(repo.crearGestion(nueva({ receivableId: "c2" }))).rejects.toBeInstanceOf(ColaCuotaExcedidaError);
  });

  it("WhatsApp: sin opt-in no se encola; con opt-in es idempotente; opt-out cancela pendientes", async () => {
    const repo = new InMemoryColaCobranzaRepository(CUENTAS);
    const msg = { propertyId: PROP, receivableId: CUENTA, cuerpo: "Recordatorio", dedupeKey: "k1" };
    await expect(repo.encolarWhatsApp(msg)).rejects.toBeInstanceOf(ColaSinConsentimientoError);
    await expect(repo.fijarConsentimiento({ propertyId: PROP, rfcReceptor: "RRR010101RR1", telefono: "+529981234567", estado: "opt_in", evidencia: null })).rejects.toBeInstanceOf(ColaEntradaInvalidaError);
    await repo.fijarConsentimiento({ propertyId: PROP, rfcReceptor: "rrr010101rr1", telefono: "+529981234567", estado: "opt_in", evidencia: "Firmo el contrato" });
    const a = await repo.encolarWhatsApp(msg);
    const b = await repo.encolarWhatsApp(msg);
    expect(a).toMatchObject({ valor: { duplicado: false } });
    expect(b).toMatchObject({ valor: { duplicado: true } });
    expect((await repo.listarOutbox(PROP)) as { valor: unknown[] }).toMatchObject({ valor: [{ estado: "pendiente" }] });
    // El opt-in de un cliente no habilita a otro de la misma property.
    await expect(repo.encolarWhatsApp({ ...msg, receivableId: "c2", dedupeKey: "k2" })).rejects.toBeInstanceOf(ColaSinConsentimientoError);
    // Una cuenta pagada nunca recibe recordatorios.
    await expect(repo.encolarWhatsApp({ ...msg, receivableId: "pagada", dedupeKey: "k3" })).rejects.toBeInstanceOf(ColaEntradaInvalidaError);
    await repo.fijarConsentimiento({ propertyId: PROP, rfcReceptor: "RRR010101RR1", telefono: "+529981234567", estado: "opt_out", evidencia: null });
    expect((await repo.listarOutbox(PROP)) as { valor: unknown[] }).toMatchObject({ valor: [{ estado: "cancelado" }] });
    await expect(repo.encolarWhatsApp({ ...msg, dedupeKey: "k4" })).rejects.toBeInstanceOf(ColaSinConsentimientoError);
  });

  it("el consentimiento de un RFC que no es cliente de la property se rechaza; el outbox no expone telefono", async () => {
    const repo = new InMemoryColaCobranzaRepository(CUENTAS);
    await expect(repo.fijarConsentimiento({ propertyId: OTRA, rfcReceptor: "RRS020202RS2", telefono: "+529981234567", estado: "opt_out", evidencia: null })).rejects.toBeInstanceOf(ColaNoEncontradaError);
    await repo.fijarConsentimiento({ propertyId: PROP, rfcReceptor: "RRR010101RR1", telefono: "+529981234567", estado: "opt_in", evidencia: "ok" });
    await repo.encolarWhatsApp({ propertyId: PROP, receivableId: CUENTA, cuerpo: "x", dedupeKey: "k" });
    const lista = (await repo.listarOutbox(PROP)) as { valor: Record<string, unknown>[] };
    expect(Object.keys(lista.valor[0]!)).not.toContain("telefono");
  });

  it("disponible=false simula la base sin migrar en todas las operaciones", async () => {
    const repo = new InMemoryColaCobranzaRepository(CUENTAS, { disponible: false });
    expect(await repo.listarGestiones(PROP)).toEqual({ disponible: false });
    expect(await repo.listarOutbox(PROP)).toEqual({ disponible: false });
    expect(await repo.crearGestion(nueva())).toEqual({ disponible: false });
  });
});
