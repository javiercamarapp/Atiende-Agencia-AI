// D-24: doble en memoria (mismas reglas que la migración 020) y adaptador Postgres con SAVEPOINT (REGLA DURA de la base sin migrar).
import { describe, expect, it } from "vitest";
import {
  InMemoryLibroRepository,
  LibroDatosInvalidosError,
  LibroNoDisponibleError,
  LibroNoEncontradoError,
  LibroSinPermisoError,
  PeriodoLibroCerradoError,
  PolizaDuplicadaError,
  PostgresLibroRepository,
  construirCatalogoBase,
} from "../src/libro/index.ts";
import type { PolizaInput } from "../src/libro/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P1 = "p1";
const INGRESO: PolizaInput = {
  tipo: "ingreso",
  fecha: "2026-07-20",
  concepto: "Honorarios",
  movimientos: [
    { cuenta: "1050000", concepto: "", debeCentavos: 116000, haberCentavos: 0 },
    { cuenta: "4080000", concepto: "", debeCentavos: 0, haberCentavos: 100000 },
    { cuenta: "2600400", concepto: "", debeCentavos: 0, haberCentavos: 16000 },
  ],
};
const COBRO: PolizaInput = {
  tipo: "ingreso",
  fecha: "2026-07-28",
  concepto: "Cobro",
  movimientos: [
    { cuenta: "1020000", concepto: "", debeCentavos: 116000, haberCentavos: 0 },
    { cuenta: "1050000", concepto: "", debeCentavos: 0, haberCentavos: 116000 },
  ],
};

async function repoConCatalogo(): Promise<InMemoryLibroRepository> {
  const repo = new InMemoryLibroRepository();
  await repo.sembrarCatalogo(P1, construirCatalogoBase());
  return repo;
}

describe("InMemoryLibroRepository", () => {
  it("siembra idempotente: la segunda vez no agrega nada", async () => {
    const repo = new InMemoryLibroRepository();
    const primera = await repo.sembrarCatalogo(P1, construirCatalogoBase());
    expect(primera).toBeGreaterThan(30);
    expect(await repo.sembrarCatalogo(P1, construirCatalogoBase())).toBe(0);
  });

  it("folio consecutivo por (cliente, mes, tipo) y total en centavos", async () => {
    const repo = await repoConCatalogo();
    expect((await repo.registrarPoliza(P1, INGRESO)).folio).toBe(1);
    expect((await repo.registrarPoliza(P1, COBRO)).folio).toBe(2);
    expect((await repo.registrarPoliza(P1, { ...INGRESO, tipo: "diario" })).folio).toBe(1);
    const lista = await repo.listarPolizas(P1, { ejercicio: 2026, mes: 7, limit: 50, offset: 0 });
    expect(lista.datos.map((p) => p.totalCentavos).sort()).toEqual([116000, 116000, 116000]);
  });

  it("rechaza descuadre, cuenta fuera del catálogo y periodo cerrado", async () => {
    const repo = await repoConCatalogo();
    await expect(repo.registrarPoliza(P1, { ...INGRESO, movimientos: INGRESO.movimientos.slice(0, 2) })).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    await expect(repo.registrarPoliza(P1, { ...COBRO, movimientos: [{ cuenta: "9999999", concepto: "", debeCentavos: 5, haberCentavos: 0 }, COBRO.movimientos[1]!] })).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    repo.periodosCerrados.add(`${P1}|2026-07`);
    await expect(repo.registrarPoliza(P1, INGRESO)).rejects.toBeInstanceOf(PeriodoLibroCerradoError);
  });

  it("un CFDI no tiene dos pólizas vigentes; tras la reversa se libera", async () => {
    const repo = await repoConCatalogo();
    const a = await repo.registrarPoliza(P1, INGRESO, "inv-1");
    await expect(repo.registrarPoliza(P1, INGRESO, "inv-1")).rejects.toBeInstanceOf(PolizaDuplicadaError);
    expect((await repo.polizasDeCfdi(P1, ["inv-1", "inv-2"])).get("inv-1")?.id).toBe(a.polizaId);
    await repo.reversarPoliza(P1, a.polizaId, "2026-07-25", "Corrección");
    expect((await repo.polizasDeCfdi(P1, ["inv-1"])).size).toBe(0);
    await expect(repo.registrarPoliza(P1, INGRESO, "inv-1")).resolves.toMatchObject({ folio: expect.any(Number) });
  });

  it("la reversa invierte las partidas, deja neto cero y no se repite ni se revierte a sí misma", async () => {
    const repo = await repoConCatalogo();
    const a = await repo.registrarPoliza(P1, INGRESO);
    const r = await repo.reversarPoliza(P1, a.polizaId, "2026-07-25", "Corrección");
    const balanza = await repo.balanza(P1, 2026, 7);
    expect(balanza.datos.every((l) => l.saldoFinalCentavos === 0)).toBe(true);
    await expect(repo.reversarPoliza(P1, a.polizaId, "2026-07-26", "Otra vez")).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    await expect(repo.reversarPoliza(P1, r.polizaId, "2026-07-26", "Reversa de reversa")).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    await expect(repo.reversarPoliza(P1, "no-existe", "2026-07-26", "x")).rejects.toBeInstanceOf(LibroNoEncontradoError);
  });

  it("balanza: cuadra, saldo inicial de balance entre meses y reinicio de resultados por ejercicio", async () => {
    const repo = await repoConCatalogo();
    await repo.registrarPoliza(P1, { ...INGRESO, fecha: "2025-12-20" });
    await repo.registrarPoliza(P1, INGRESO);
    await repo.registrarPoliza(P1, COBRO);
    const julio = (await repo.balanza(P1, 2026, 7)).datos;
    expect(julio.reduce((s, l) => s + l.debeCentavos, 0)).toBe(julio.reduce((s, l) => s + l.haberCentavos, 0));
    const clientes = julio.find((l) => l.cuenta === "1050000")!;
    expect(clientes).toMatchObject({ saldoInicialCentavos: 116000, debeCentavos: 116000, haberCentavos: 116000, saldoFinalCentavos: 116000 });
    // Los ingresos de 2025 NO entran al saldo inicial de 2026 (cuentas de resultados), los de julio sí son del mes.
    expect(julio.find((l) => l.cuenta === "4080000")).toMatchObject({ saldoInicialCentavos: 0, saldoFinalCentavos: 100000 });
    const enero = (await repo.balanza(P1, 2026, 1)).datos;
    expect(enero.find((l) => l.cuenta === "4080000")).toBeUndefined();
    expect(enero.find((l) => l.cuenta === "1050000")?.saldoInicialCentavos).toBe(116000);
  });

  it("una cuenta con partidas no cambia de naturaleza", async () => {
    const repo = await repoConCatalogo();
    await repo.registrarPoliza(P1, INGRESO);
    await expect(repo.guardarCuenta(P1, { codigo: "1050000", descripcion: "Clientes", naturaleza: "A" })).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    await expect(repo.guardarCuenta(P1, { codigo: "1050000", descripcion: "Clientes nacionales", naturaleza: "D" })).resolves.toBeUndefined();
  });

  it("clientes distintos no comparten catálogo ni pólizas", async () => {
    const repo = await repoConCatalogo();
    await repo.registrarPoliza(P1, INGRESO);
    expect((await repo.listarPolizas("p2", { ejercicio: 2026, limit: 50, offset: 0 })).datos).toHaveLength(0);
    await expect(repo.registrarPoliza("p2", INGRESO)).rejects.toBeInstanceOf(LibroDatosInvalidosError);
  });

  it("base sin migrar: lecturas con estado no_disponible y vacío; escrituras LibroNoDisponibleError", async () => {
    const repo = new InMemoryLibroRepository();
    repo.disponible = false;
    expect(await repo.listarCuentas(P1)).toEqual({ estado: "no_disponible", datos: [] });
    expect(await repo.balanza(P1, 2026, 7)).toEqual({ estado: "no_disponible", datos: [] });
    await expect(repo.registrarPoliza(P1, INGRESO)).rejects.toBeInstanceOf(LibroNoDisponibleError);
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
const tablaInexistente = () => pgError("42P01", 'relation "despachos.libro_poliza" does not exist');
const funcionInexistente = (n: string) => pgError("42883", `function despachos.${n}(uuid, text, date, text, jsonb, uuid) does not exist`);

const FILA_POLIZA = { id: "pol-1", property_id: P1, ejercicio: 2026, mes: 7, tipo: "ingreso", folio: 3, fecha: "2026-07-20", concepto: "Honorarios", origen: "manual", invoice_id: null, reversa_de: null, reversada: false, total_centavos: "116000", created_at: "2026-07-20T10:00:00Z" };

describe("PostgresLibroRepository (SAVEPOINT, base sin migrar)", () => {
  it("lee pólizas y convierte los bigint de Postgres (texto) a centavos enteros", async () => {
    const repo = new PostgresLibroRepository(new AbortAwareFakeSession([{ match: /from despachos\.libro_poliza/i, respond: () => [FILA_POLIZA] }]));
    const r = await repo.listarPolizas(P1, { ejercicio: 2026, mes: 7, limit: 50, offset: 0 });
    expect(r.estado).toBe("disponible");
    expect(r.datos[0]).toMatchObject({ folio: 3, totalCentavos: 116000, fecha: "2026-07-20", tipo: "ingreso" });
  });

  it("REGLA DURA (42P01): la lista cae a vacío + no_disponible y la sesión NO queda abortada", async () => {
    const session = new AbortAwareFakeSession([{ match: /from despachos\.libro_poliza/i, respond: tablaInexistente }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    const r = await new PostgresLibroRepository(session).listarPolizas(P1, { ejercicio: 2026, limit: 50, offset: 0 });
    expect(r).toEqual({ estado: "no_disponible", datos: [] });
    await expect(session.query("select 1")).resolves.toBeDefined();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("REGLA DURA (42883 de la función de la migración): registrar -> LibroNoDisponibleError y la sesión sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /libro_poliza_registrar/i, respond: () => funcionInexistente("libro_poliza_registrar") }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    await expect(new PostgresLibroRepository(session).registrarPoliza(P1, INGRESO)).rejects.toBeInstanceOf(LibroNoDisponibleError);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("un 42883 de OTRA función (no despachos.libro_*) no se disfraza de 'no disponible'", async () => {
    const session = new AbortAwareFakeSession([{ match: /libro_poliza_registrar/i, respond: () => pgError("42883", "function core.has_property_access(uuid) does not exist") }]);
    await expect(new PostgresLibroRepository(session).registrarPoliza(P1, INGRESO)).rejects.toMatchObject({ code: "42883" });
  });

  it("la balanza cae a vacío en la base sin migrar y obtenerPoliza devuelve null", async () => {
    const session = new AbortAwareFakeSession([{ match: /libro_balanza/i, respond: () => funcionInexistente("libro_balanza") }, { match: /from despachos\.libro_poliza/i, respond: tablaInexistente }]);
    const repo = new PostgresLibroRepository(session);
    expect(await repo.balanza(P1, 2026, 7)).toEqual({ estado: "no_disponible", datos: [] });
    expect(await repo.obtenerPoliza(P1, "pol-1")).toBeNull();
  });

  it.each([
    ["42501", "libro_poliza_registrar: sin permiso sobre el cliente", LibroSinPermisoError],
    ["22023", "libro_poliza: póliza descuadrada (debe 1 y haber 2 centavos)", LibroDatosInvalidosError],
    ["55000", "libro_poliza: el periodo 2026-07 está cerrado", PeriodoLibroCerradoError],
    ["23505", "duplicate key", PolizaDuplicadaError],
    ["P0002", "libro_poliza_registrar: CFDI no encontrado", LibroNoEncontradoError],
  ])("SQLSTATE %s -> error de dominio tipado", async (code, mensaje, clase) => {
    const repo = new PostgresLibroRepository(new AbortAwareFakeSession([{ match: /libro_poliza_registrar/i, respond: () => pgError(code, mensaje) }]));
    await expect(repo.registrarPoliza(P1, INGRESO)).rejects.toBeInstanceOf(clase);
  });

  it("el mensaje de datos inválidos no arrastra el prefijo interno de la función", async () => {
    const repo = new PostgresLibroRepository(new AbortAwareFakeSession([{ match: /libro_poliza_registrar/i, respond: () => pgError("22023", "libro_poliza: póliza descuadrada (debe 1 y haber 2 centavos)") }]));
    await expect(repo.registrarPoliza(P1, INGRESO)).rejects.toThrow(/^póliza descuadrada/);
  });

  it("serializa las partidas en centavos enteros (jsonb) y la liga al CFDI", async () => {
    const llamadas: unknown[][] = [];
    const session = new AbortAwareFakeSession([{ match: /libro_poliza_registrar/i, respond: () => [{ out_poliza_id: "pol-9", out_folio: 4 }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      llamadas.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    const r = await new PostgresLibroRepository(session).registrarPoliza(P1, INGRESO, "inv-1");
    expect(r).toEqual({ polizaId: "pol-9", folio: 4 });
    const params = llamadas[0]!;
    expect(params[0]).toBe(P1);
    expect(JSON.parse(params[4] as string)[0]).toEqual({ cuenta: "1050000", concepto: "", debe: 116000, haber: 0 });
    expect(params[5]).toBe("inv-1");
  });
});
