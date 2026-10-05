// D-P3-13: repositorio de la clasificación contable. Postgres: SQL y SQLSTATE traducidos, y la REGLA DURA de compatibilidad con la base sin migrar
// (SAVEPOINT; AbortAwareFakeSession reproduce el estado abortado de Postgres real). En memoria: reglas de la migración 026.
import { describe, expect, it } from "vitest";
import {
  ClasificacionDatosInvalidosError,
  ClasificacionNoDisponibleError,
  ClasificacionNoEncontradaError,
  ClasificacionSinPermisoError,
  ClasificacionTopeExcedidoError,
  InMemoryClasificacionRepository,
  PostgresClasificacionRepository,
} from "../src/clasificacion/index.ts";
import type { ResultadoClasificacionCfdi } from "../src/bookkeeping/clasificacion-cfdi.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000p1";
const I = "00000000-0000-0000-0000-0000000000i1";
const RESULTADO: ResultadoClasificacionCfdi = { categoria: "equipo_computo", confianza: 0.9, metodo: "claveprodserv", razon: "x", empate: false, rivales: 0, cuenta: null };

function pgError(code: string, message = "boom"): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

describe("PostgresClasificacionRepository", () => {
  it("registrar: llama a invoice_clasificar con los 8 argumentos", async () => {
    let params: unknown[] = [];
    const session = new AbortAwareFakeSession([{ match: /despachos\.invoice_clasificar/, respond: () => [{}] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      if (/invoice_clasificar/.test(sql)) params = p ?? [];
      return original(sql, p);
    }) as typeof session.query;
    expect(await new PostgresClasificacionRepository(session).registrar(P, I, RESULTADO)).toBe(true);
    expect(params).toEqual([P, I, "equipo_computo", 0.9, "claveprodserv", "x", null, false]);
  });

  it("REGLA DURA: registrar contra la base sin migrar (42883) devuelve false y el SAVEPOINT deja la sesión utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /despachos\.invoice_clasificar/, respond: () => pgError("42883", "function despachos.invoice_clasificar(unknown, unknown) does not exist") },
      { match: /select 1/, respond: () => [] },
    ]);
    expect(await new PostgresClasificacionRepository(session).registrar(P, I, RESULTADO)).toBe(false);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it.each([
    ["42501", ClasificacionSinPermisoError],
    ["22023", ClasificacionDatosInvalidosError],
    ["23514", ClasificacionDatosInvalidosError],
    ["P0002", ClasificacionNoEncontradaError],
    ["54000", ClasificacionTopeExcedidoError],
  ])("los SQLSTATE de las funciones definer (%s) se traducen a errores de dominio", async (code, Clase) => {
    const session = new AbortAwareFakeSession([{ match: /clasificacion_correccion_guardar/, respond: () => pgError(code, "clasificacion_correccion_guardar: detalle") }]);
    await expect(new PostgresClasificacionRepository(session).guardarCorreccion(P, { rfcEmisor: "AAA010101AAA", claveProdServ: null, categoria: "otros", cuenta: null })).rejects.toBeInstanceOf(Clase);
  });

  it("escrituras contra la base sin migrar (42P01): ClasificacionNoDisponibleError y sesión recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /invoice_categoria_corregir/, respond: () => pgError("42P01") },
      { match: /select 1/, respond: () => [] },
    ]);
    await expect(new PostgresClasificacionRepository(session).corregirCategoria(P, I, { categoria: "otros", cuenta: null, guardarRegla: false })).rejects.toBeInstanceOf(ClasificacionNoDisponibleError);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("lecturas contra la base sin migrar (42703): no_disponible con vacío honesto, sin abortar la transacción", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from despachos\.invoice_classification/, respond: () => pgError("42703") },
      { match: /from despachos\.clasificacion_correccion/, respond: () => pgError("42P01") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresClasificacionRepository(session);
    expect((await repo.vigentes(P, [I])).estado).toBe("no_disponible");
    expect((await repo.historial(P, I)).datos).toEqual([]);
    expect((await repo.listarCorrecciones(P)).estado).toBe("no_disponible");
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("vigentes: la última clasificación por CFDI (distinct on) mapeada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /distinct on \(c\.invoice_id\)/, respond: () => [{ id: "c1", invoice_id: I, categoria: "telefonia", confianza: "0.800", method: "reglas", razon: "r", cuenta: null, empate: false, classified_by: null, created_at: "2026-07-10T00:00:00Z" }] },
    ]);
    const r = await new PostgresClasificacionRepository(session).vigentes(P, [I]);
    expect(r.estado).toBe("ok");
    expect(r.datos.get(I)).toMatchObject({ categoria: "telefonia", confianza: 0.8, metodo: "reglas", clasificadaPor: null });
  });

  it("vigentes con lista vacía no consulta", async () => {
    const session = new AbortAwareFakeSession([]);
    expect((await new PostgresClasificacionRepository(session).vigentes(P, [])).datos.size).toBe(0);
    expect(session.calls).toEqual([]);
  });

  it("historialManual: las filas manuales con RFC y categoria fina; sin migrar (42703) vacio honesto", async () => {
    const ok = new AbortAwareFakeSession([{ match: /c\.method = 'manual'/, respond: () => [{ folio: "f1", rfc_emisor: "AAA010101AAA", categoria: "seguros" }] }]);
    expect((await new PostgresClasificacionRepository(ok).historialManual(P)).datos).toEqual([{ cfdiUuid: "f1", rfcEmisor: "AAA010101AAA", categoria: "seguros" }]);
    const vieja = new AbortAwareFakeSession([{ match: /c\.method = 'manual'/, respond: () => pgError("42703") }]);
    expect(await new PostgresClasificacionRepository(vieja).historialManual(P)).toEqual({ estado: "no_disponible", datos: [] });
  });

  it("leerConfig: sin fila = valores por omisión (0.7, autoaceptado encendido); sin migrar = disponible false", async () => {
    const vacia = new AbortAwareFakeSession([{ match: /from despachos\.property_config/, respond: () => [] }]);
    expect(await new PostgresClasificacionRepository(vacia).leerConfig(P)).toEqual({ umbral: 0.7, portalAutoaceptar: true, disponible: true });
    const vieja = new AbortAwareFakeSession([{ match: /from despachos\.property_config/, respond: () => pgError("42703") }]);
    expect(await new PostgresClasificacionRepository(vieja).leerConfig(P)).toEqual({ umbral: 0.7, portalAutoaceptar: true, disponible: false });
  });

  it("guardarConfig: upsert que conserva el campo no enviado; un 23514 (umbral bajo el piso) es un dato inválido", async () => {
    const ok = new AbortAwareFakeSession([{ match: /insert into despachos\.property_config/, respond: () => [{ umbral: "0.600", autoaceptar: false }] }]);
    expect(await new PostgresClasificacionRepository(ok).guardarConfig(P, "o1", { umbral: 0.6, portalAutoaceptar: false })).toEqual({ umbral: 0.6, portalAutoaceptar: false, disponible: true });
    const mal = new AbortAwareFakeSession([{ match: /insert into despachos\.property_config/, respond: () => pgError("23514") }]);
    await expect(new PostgresClasificacionRepository(mal).guardarConfig(P, "o1", { umbral: 0.4 })).rejects.toBeInstanceOf(ClasificacionDatosInvalidosError);
    const rls = new AbortAwareFakeSession([{ match: /insert into despachos\.property_config/, respond: () => pgError("42501") }]);
    await expect(new PostgresClasificacionRepository(rls).guardarConfig(P, "o1", { portalAutoaceptar: false })).rejects.toBeInstanceOf(ClasificacionSinPermisoError);
  });

  it("un 42883 de OTRA función (bug real, no migración pendiente) NO se enmascara", async () => {
    const session = new AbortAwareFakeSession([{ match: /invoice_clasificar/, respond: () => pgError("42883", "function despachos.otra_cosa(uuid) does not exist") }]);
    await expect(new PostgresClasificacionRepository(session).registrar(P, I, RESULTADO)).rejects.toMatchObject({ code: "42883" });
  });

  it("recalcularDireccion: devuelve el conteo; sin migrar devuelve null", async () => {
    const ok = new AbortAwareFakeSession([{ match: /invoice_direccion_recalcular/, respond: () => [{ n: 3 }] }]);
    expect(await new PostgresClasificacionRepository(ok).recalcularDireccion(P)).toBe(3);
    const vieja = new AbortAwareFakeSession([{ match: /invoice_direccion_recalcular/, respond: () => pgError("42883", "function despachos.invoice_direccion_recalcular(unknown) does not exist") }]);
    expect(await new PostgresClasificacionRepository(vieja).recalcularDireccion(P)).toBeNull();
  });
});

describe("InMemoryClasificacionRepository", () => {
  it("clasificar dos veces deja las dos filas y la vigente es la última (nunca update silencioso)", async () => {
    const repo = new InMemoryClasificacionRepository();
    await repo.registrar(P, I, RESULTADO);
    await repo.registrar(P, I, { ...RESULTADO, categoria: "seguros" });
    expect((await repo.historial(P, I)).datos).toHaveLength(2);
    expect((await repo.vigentes(P, [I])).datos.get(I)?.categoria).toBe("seguros");
  });

  it("corregirCategoria con regla: fila manual de confianza 1 y corrección por el RFC del emisor", async () => {
    const repo = new InMemoryClasificacionRepository({ rfcEmisorDe: () => "PPP010101PP1" });
    await repo.corregirCategoria(P, I, { categoria: "publicidad", cuenta: "6020500", guardarRegla: true });
    expect((await repo.vigentes(P, [I])).datos.get(I)).toMatchObject({ metodo: "manual", confianza: 1, cuenta: "6020500" });
    expect((await repo.listarCorrecciones(P)).datos).toMatchObject([{ rfcEmisor: "PPP010101PP1", categoria: "publicidad", claveProdServ: null }]);
  });

  it("corregirCategoria: CFDI inexistente y categoría inventada", async () => {
    const repo = new InMemoryClasificacionRepository({ rfcEmisorDe: () => null });
    await expect(repo.corregirCategoria(P, I, { categoria: "publicidad", cuenta: null, guardarRegla: false })).rejects.toBeInstanceOf(ClasificacionNoEncontradaError);
    await expect(new InMemoryClasificacionRepository().corregirCategoria(P, I, { categoria: "inventada", cuenta: null, guardarRegla: false })).rejects.toBeInstanceOf(ClasificacionDatosInvalidosError);
  });

  it("correcciones: upsert por (RFC, ClaveProdServ), aislamiento por property, validaciones, eliminar y tope de 1000", async () => {
    const repo = new InMemoryClasificacionRepository();
    const id1 = await repo.guardarCorreccion(P, { rfcEmisor: "aaa010101aaa", claveProdServ: null, categoria: "publicidad", cuenta: null });
    const id2 = await repo.guardarCorreccion(P, { rfcEmisor: "AAA010101AAA", claveProdServ: null, categoria: "seguros", cuenta: "6080100" });
    expect(id2).toBe(id1);
    await repo.guardarCorreccion(P, { rfcEmisor: "AAA010101AAA", claveProdServ: "43211503", categoria: "transporte", cuenta: null });
    expect((await repo.listarCorrecciones(P)).datos).toHaveLength(2);
    expect((await repo.listarCorrecciones("otra-property")).datos).toHaveLength(0);
    await expect(repo.guardarCorreccion(P, { rfcEmisor: "x", claveProdServ: null, categoria: "otros", cuenta: null })).rejects.toBeInstanceOf(ClasificacionDatosInvalidosError);
    await expect(repo.guardarCorreccion(P, { rfcEmisor: "AAA010101AAA", claveProdServ: "12", categoria: "otros", cuenta: null })).rejects.toBeInstanceOf(ClasificacionDatosInvalidosError);
    expect(await repo.eliminarCorreccion("otra-property", id1)).toBe(false);
    expect(await repo.eliminarCorreccion(P, id1)).toBe(true);
    for (let i = 0; i < 999; i += 1) await repo.guardarCorreccion(P, { rfcEmisor: `AAA${String(i).padStart(6, "0")}AA1`, claveProdServ: null, categoria: "otros", cuenta: null });
    await expect(repo.guardarCorreccion(P, { rfcEmisor: "ZZZ010101ZZ1", claveProdServ: null, categoria: "otros", cuenta: null })).rejects.toBeInstanceOf(ClasificacionTopeExcedidoError);
  });

  it("config: omisión, guardar y el umbral nunca baja del piso", async () => {
    const repo = new InMemoryClasificacionRepository();
    expect(await repo.leerConfig(P)).toEqual({ umbral: 0.7, portalAutoaceptar: true, disponible: true });
    expect(await repo.guardarConfig(P, "o1", { portalAutoaceptar: false })).toEqual({ umbral: 0.7, portalAutoaceptar: false, disponible: true });
    await expect(repo.guardarConfig(P, "o1", { umbral: 0.4 })).rejects.toBeInstanceOf(ClasificacionDatosInvalidosError);
  });

  it("base sin migrar: lecturas no_disponible, registrar false, escrituras 503", async () => {
    const repo = new InMemoryClasificacionRepository();
    repo.disponible = false;
    expect(await repo.registrar(P, I, RESULTADO)).toBe(false);
    expect((await repo.vigentes(P, [I])).estado).toBe("no_disponible");
    expect(await repo.recalcularDireccion(P)).toBeNull();
    expect((await repo.leerConfig(P)).disponible).toBe(false);
    await expect(repo.guardarCorreccion(P, { rfcEmisor: "AAA010101AAA", claveProdServ: null, categoria: "otros", cuenta: null })).rejects.toBeInstanceOf(ClasificacionNoDisponibleError);
  });
});
