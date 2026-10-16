// D-P3-16/17/44: catálogo del libro con nivel, cuenta padre y código agrupador (migración 028) -- doble en memoria y adaptador Postgres
// (SAVEPOINT / REGLA DURA de la base sin migrar con AbortAwareFakeSession, que reproduce el estado abortado de una transacción real).
import { describe, expect, it } from "vitest";
import {
  InMemoryLibroRepository,
  LibroDatosInvalidosError,
  LibroNoDisponibleError,
  LibroTopeExcedidoError,
  PostgresLibroRepository,
  construirCatalogoBase,
} from "../src/libro/index.ts";
import type { CuentaLibro, PolizaInput } from "../src/libro/index.ts";
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

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

describe("catálogo base del libro con jerarquía y código agrupador", () => {
  const base = construirCatalogoBase();
  it("las subcuentas cuelgan de su cuenta de mayor en el nivel inmediato", () => {
    const porCodigo = new Map(base.map((c) => [c.codigo, c] as const));
    expect(porCodigo.get("1020100")).toMatchObject({ nivel: 2, cuentaPadre: "1020000", codigoAgrupador: "102.01" });
    expect(porCodigo.get("2600400")).toMatchObject({ nivel: 2, cuentaPadre: "2600000" });
    expect(porCodigo.get("1020000")).toMatchObject({ nivel: 1, cuentaPadre: null });
    for (const c of base) {
      if (c.cuentaPadre) expect(porCodigo.get(c.cuentaPadre)?.nivel, c.codigo).toBe((c.nivel ?? 1) - 1);
    }
  });
});

describe("InMemoryLibroRepository: catálogo con código agrupador", () => {
  it("la siembra trae jerarquía y código, y es idempotente", async () => {
    const repo = new InMemoryLibroRepository();
    const total = construirCatalogoBase().length;
    expect(await repo.sembrarCatalogo(P1, construirCatalogoBase())).toBe(total);
    expect(await repo.sembrarCatalogo(P1, construirCatalogoBase())).toBe(0);
    const cuentas = (await repo.listarCuentas(P1)).datos;
    expect(cuentas.find((c) => c.codigo === "1020100")).toMatchObject({ nivel: 2, cuentaPadre: "1020000", codigoAgrupador: "102.01" });
  });

  it("la siembra completa lo vacío de una cuenta existente pero NO pisa un código ya capturado", async () => {
    const repo = new InMemoryLibroRepository();
    await repo.sembrarCatalogo(P1, [{ codigo: "1020000", descripcion: "Bancos", naturaleza: "D" }, { codigo: "1050000", descripcion: "Clientes", naturaleza: "D", codigoAgrupador: "105" }]);
    await repo.sembrarCatalogo(P1, [
      { codigo: "1020000", descripcion: "OTRA", naturaleza: "D", nivel: 1, codigoAgrupador: "102" },
      { codigo: "1050000", descripcion: "OTRA", naturaleza: "D", nivel: 1, codigoAgrupador: "106" },
    ]);
    const cuentas = new Map((await repo.listarCuentas(P1)).datos.map((c) => [c.codigo, c] as const));
    expect(cuentas.get("1020000")).toMatchObject({ descripcion: "Bancos", codigoAgrupador: "102" });
    expect(cuentas.get("1050000")).toMatchObject({ descripcion: "Clientes", codigoAgrupador: "105" });
  });

  it("guardar valida formato, rubro y nivel del padre; editar la descripción no borra el código", async () => {
    const repo = new InMemoryLibroRepository();
    await repo.sembrarCatalogo(P1, construirCatalogoBase());
    const hija = { codigo: "1020900", descripcion: "Banco X", naturaleza: "D" as const };
    await expect(repo.guardarCuenta(P1, { ...hija, nivel: 2, cuentaPadre: "1020000", codigoAgrupador: "10.5" })).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    await expect(repo.guardarCuenta(P1, { ...hija, nivel: 2, cuentaPadre: "4080000" })).rejects.toThrow(/mismo rubro/);
    await expect(repo.guardarCuenta(P1, { ...hija, nivel: 2, cuentaPadre: "1999999" })).rejects.toThrow(/cuenta padre/);
    await expect(repo.guardarCuenta(P1, { ...hija, nivel: 3, cuentaPadre: "1020000" })).rejects.toThrow(/nivel 2/);
    await expect(repo.guardarCuenta(P1, { ...hija, nivel: 2 })).rejects.toThrow(/nivel 1 no lleva/);
    await expect(repo.guardarCuenta(P1, { ...hija, cuentaPadre: "1020000" })).rejects.toThrow(/indica el nivel/);
    await repo.guardarCuenta(P1, { ...hija, nivel: 2, cuentaPadre: "1020000", codigoAgrupador: "102.02" });
    await repo.guardarCuenta(P1, { codigo: "1020900", descripcion: "Banco X (editada)", naturaleza: "D" });
    const c = (await repo.listarCuentas(P1)).datos.find((x) => x.codigo === "1020900");
    expect(c).toMatchObject({ descripcion: "Banco X (editada)", nivel: 2, cuentaPadre: "1020000", codigoAgrupador: "102.02" });
  });

  it("una cuenta con subcuentas no cambia de nivel, y una con partidas no cambia de naturaleza (regresión)", async () => {
    const repo = new InMemoryLibroRepository();
    await repo.sembrarCatalogo(P1, construirCatalogoBase());
    await expect(repo.guardarCuenta(P1, { codigo: "1020000", descripcion: "Bancos", naturaleza: "D", nivel: 2, cuentaPadre: "1050000" })).rejects.toThrow(/subcuentas/);
    await repo.registrarPoliza(P1, INGRESO);
    await expect(repo.guardarCuenta(P1, { codigo: "1050000", descripcion: "Clientes", naturaleza: "A" })).rejects.toBeInstanceOf(LibroDatosInvalidosError);
  });

  it("asignarCodigosAgrupadores es todo o nada y exige formato", async () => {
    const repo = new InMemoryLibroRepository();
    await repo.sembrarCatalogo(P1, construirCatalogoBase().map((c) => ({ codigo: c.codigo, descripcion: c.descripcion, naturaleza: c.naturaleza })));
    expect(await repo.asignarCodigosAgrupadores(P1, [{ codigo: "1050000", codigoAgrupador: "105" }, { codigo: "4080000", codigoAgrupador: "401.01" }])).toBe(2);
    await expect(repo.asignarCodigosAgrupadores(P1, [{ codigo: "1020000", codigoAgrupador: "102" }, { codigo: "9999999", codigoAgrupador: "102" }])).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    await expect(repo.asignarCodigosAgrupadores(P1, [{ codigo: "1020000", codigoAgrupador: "1" }])).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    await expect(repo.asignarCodigosAgrupadores(P1, [])).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    const cuentas = new Map((await repo.listarCuentas(P1)).datos.map((c) => [c.codigo, c] as const));
    expect(cuentas.get("1020000")?.codigoAgrupador ?? null).toBeNull(); // el lote fallido no dejó nada a medias
    expect(cuentas.get("1050000")?.codigoAgrupador).toBe("105");
  });

  it("importarCatalogo agrega, actualiza y NUNCA borra (REQ-MIG-017); la última aparición gana", async () => {
    const repo = new InMemoryLibroRepository();
    await repo.sembrarCatalogo(P1, construirCatalogoBase());
    const antes = (await repo.listarCuentas(P1)).datos.length;
    const importadas: CuentaLibro[] = [
      { codigo: "1050000", descripcion: "Clientes (otro proveedor)", naturaleza: "D", nivel: 1, codigoAgrupador: "105" },
      { codigo: "7770000", descripcion: "Primera", naturaleza: "A", nivel: 1 },
      { codigo: "7770000", descripcion: "Ultima", naturaleza: "A", nivel: 1 },
    ];
    expect(await repo.importarCatalogo(P1, importadas)).toEqual({ agregadas: 1, actualizadas: 1 });
    const cuentas = (await repo.listarCuentas(P1)).datos;
    expect(cuentas).toHaveLength(antes + 1);
    expect(cuentas.find((c) => c.codigo === "7770000")?.descripcion).toBe("Ultima");
    expect(cuentas.find((c) => c.codigo === "1050000")?.descripcion).toBe("Clientes (otro proveedor)");
    expect(cuentas.find((c) => c.codigo === "1020000")).toBeDefined();
  });

  it("importarCatalogo no cambia la naturaleza de una cuenta con partidas y respeta el tope de 2000", async () => {
    const repo = new InMemoryLibroRepository();
    await repo.sembrarCatalogo(P1, construirCatalogoBase());
    await repo.registrarPoliza(P1, INGRESO);
    await expect(repo.importarCatalogo(P1, [{ codigo: "1050000", descripcion: "Clientes", naturaleza: "A" }])).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    const relleno = Array.from({ length: 450 }, (_, i) => ({ codigo: String(3000000 + i), descripcion: `R${i}`, naturaleza: "D" as const }));
    for (let k = 0; k < 4; k += 1) await repo.importarCatalogo(P1, relleno.map((c) => ({ ...c, codigo: String(Number(c.codigo) + k * 1000) })));
    await expect(repo.importarCatalogo(P1, relleno.map((c) => ({ ...c, codigo: String(Number(c.codigo) + 9000) })))).rejects.toBeInstanceOf(LibroTopeExcedidoError);
  });

  it("polizasDelPeriodo devuelve las pólizas del mes con partidas y respeta el tope", async () => {
    const repo = new InMemoryLibroRepository();
    await repo.sembrarCatalogo(P1, construirCatalogoBase());
    await repo.registrarPoliza(P1, INGRESO);
    await repo.registrarPoliza(P1, { ...INGRESO, fecha: "2026-08-02" });
    const julio = await repo.polizasDelPeriodo(P1, 2026, 7, 10);
    expect(julio.datos).toHaveLength(1);
    expect(julio.datos[0]!.movimientos).toHaveLength(3);
    await expect(repo.polizasDelPeriodo(P1, 2026, 7, 0)).rejects.toBeInstanceOf(LibroTopeExcedidoError);
  });

  it("base sin migrar: las operaciones nuevas lanzan LibroNoDisponibleError", async () => {
    const repo = new InMemoryLibroRepository();
    repo.disponible = false;
    await expect(repo.asignarCodigosAgrupadores(P1, [{ codigo: "1050000", codigoAgrupador: "105" }])).rejects.toBeInstanceOf(LibroNoDisponibleError);
    await expect(repo.importarCatalogo(P1, [{ codigo: "1050000", descripcion: "x", naturaleza: "D" }])).rejects.toBeInstanceOf(LibroNoDisponibleError);
    expect(await repo.polizasDelPeriodo(P1, 2026, 7, 10)).toEqual({ estado: "no_disponible", datos: [] });
  });
});

describe("PostgresLibroRepository: catálogo (SAVEPOINT, base sin la migración 028)", () => {
  const FILA_NUEVA = { codigo: "1020100", descripcion: "Bancos nacionales", naturaleza: "D", nivel: 2, cuenta_padre: "1020000", codigo_agrupador: "102.01" };

  it("lee nivel, cuenta padre y código agrupador", async () => {
    const repo = new PostgresLibroRepository(new AbortAwareFakeSession([{ match: /cuenta_padre, codigo_agrupador from/i, respond: () => [FILA_NUEVA] }]));
    const r = await repo.listarCuentas(P1);
    expect(r).toEqual({ estado: "disponible", datos: [{ codigo: "1020100", descripcion: "Bancos nacionales", naturaleza: "D", nivel: 2, cuentaPadre: "1020000", codigoAgrupador: "102.01" }] });
  });

  it("REGLA DURA (42703: columnas de la 028 inexistentes): cae al SELECT de la 020, las cuentas salen sin código y la sesión NO queda abortada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /cuenta_padre, codigo_agrupador from/i, respond: () => pgError("42703", 'column "nivel" does not exist') },
      { match: /select codigo, descripcion, naturaleza from/i, respond: () => [{ codigo: "1020100", descripcion: "Bancos nacionales", naturaleza: "D" }] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const r = await new PostgresLibroRepository(session).listarCuentas(P1);
    expect(r.estado).toBe("disponible");
    expect(r.datos).toEqual([{ codigo: "1020100", descripcion: "Bancos nacionales", naturaleza: "D" }]);
    await expect(session.query("select 1")).resolves.toBeDefined();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("REGLA DURA (42P01: ni la migración 020): vacío honesto + no_disponible, sesión utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /cuenta_padre, codigo_agrupador from/i, respond: () => pgError("42703", 'column "nivel" does not exist') },
      { match: /select codigo, descripcion, naturaleza from/i, respond: () => pgError("42P01", 'relation "despachos.libro_cuenta" does not exist') },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await new PostgresLibroRepository(session).listarCuentas(P1)).toEqual({ estado: "no_disponible", datos: [] });
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("un error distinto de columna inexistente NO se disfraza", async () => {
    const session = new AbortAwareFakeSession([{ match: /cuenta_padre, codigo_agrupador from/i, respond: () => pgError("57014", "canceling statement due to statement timeout") }]);
    await expect(new PostgresLibroRepository(session).listarCuentas(P1)).rejects.toMatchObject({ code: "57014" });
  });

  it("guardar sin jerarquía ni código llama a la función de 4 argumentos (existe también en la base sin migrar); con ellos, a la de 7", async () => {
    const sqls: string[] = [];
    const session = new AbortAwareFakeSession([{ match: /libro_cuenta_guardar/i, respond: () => [] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      sqls.push(sql);
      return original(sql, params);
    }) as typeof session.query;
    const repo = new PostgresLibroRepository(session);
    await repo.guardarCuenta(P1, { codigo: "1050000", descripcion: "Clientes", naturaleza: "D" });
    await repo.guardarCuenta(P1, { codigo: "1050100", descripcion: "Clientes nac", naturaleza: "D", nivel: 2, cuentaPadre: "1050000", codigoAgrupador: "105.01" });
    expect(sqls[0]).toMatch(/libro_cuenta_guardar\(\$1, \$2, \$3, \$4\)/);
    expect(sqls[1]).toMatch(/\$5::int, \$6, \$7/);
  });

  it("REGLA DURA (42883): asignar e importar contra la base sin migrar -> LibroNoDisponibleError y la sesión sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /libro_cuenta_agrupador_asignar/i, respond: () => pgError("42883", "function despachos.libro_cuenta_agrupador_asignar(uuid, jsonb) does not exist") },
      { match: /libro_catalogo_importar/i, respond: () => pgError("42883", "function despachos.libro_catalogo_importar(uuid, jsonb) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresLibroRepository(session);
    await expect(repo.asignarCodigosAgrupadores(P1, [{ codigo: "1050000", codigoAgrupador: "105" }])).rejects.toBeInstanceOf(LibroNoDisponibleError);
    await expect(repo.importarCatalogo(P1, [{ codigo: "1050000", descripcion: "x", naturaleza: "D" }])).rejects.toBeInstanceOf(LibroNoDisponibleError);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("asignar e importar serializan el JSON y devuelven los conteos", async () => {
    const params: unknown[][] = [];
    const session = new AbortAwareFakeSession([
      { match: /libro_cuenta_agrupador_asignar/i, respond: () => [{ libro_cuenta_agrupador_asignar: 2 }] },
      { match: /libro_catalogo_importar/i, respond: () => [{ out_agregadas: 3, out_actualizadas: 1 }] },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      params.push(p ?? []);
      return original(sql, p);
    }) as typeof session.query;
    const repo = new PostgresLibroRepository(session);
    expect(await repo.asignarCodigosAgrupadores(P1, [{ codigo: "1050000", codigoAgrupador: "105" }])).toBe(2);
    expect(JSON.parse(params[0]![1] as string)).toEqual([{ codigo: "1050000", codigo_agrupador: "105" }]);
    expect(await repo.importarCatalogo(P1, [{ codigo: "1050100", descripcion: "Clientes nac", naturaleza: "D", nivel: 2, cuentaPadre: "1050000", codigoAgrupador: "105.01" }])).toEqual({ agregadas: 3, actualizadas: 1 });
    expect(JSON.parse(params[1]![1] as string)).toEqual([{ codigo: "1050100", descripcion: "Clientes nac", naturaleza: "D", nivel: 2, cuenta_padre: "1050000", codigo_agrupador: "105.01" }]);
  });

  it("polizasDelPeriodo agrupa las partidas por póliza y respeta el tope", async () => {
    const cab = (id: string, folio: number) => ({ id, property_id: P1, ejercicio: 2026, mes: 7, tipo: "ingreso", folio, fecha: "2026-07-20", concepto: "H", origen: "manual", invoice_id: null, reversa_de: null, reversada: false, total_centavos: "100", created_at: "2026-07-20T10:00:00Z" });
    const movs = [
      { poliza_id: "a", linea: 1, cuenta: "1050000", concepto: "", debe_centavos: "100", haber_centavos: "0" },
      { poliza_id: "a", linea: 2, cuenta: "4080000", concepto: "", debe_centavos: "0", haber_centavos: "100" },
      { poliza_id: "b", linea: 1, cuenta: "1050000", concepto: "", debe_centavos: "100", haber_centavos: "0" },
    ];
    const session = new AbortAwareFakeSession([
      { match: /from despachos\.libro_movimiento/i, respond: () => movs },
      { match: /from despachos\.libro_poliza/i, respond: () => [cab("a", 1), cab("b", 2)] },
    ]);
    const repo = new PostgresLibroRepository(session);
    const r = await repo.polizasDelPeriodo(P1, 2026, 7, 10);
    expect(r.datos.map((p) => p.movimientos.length)).toEqual([2, 1]);
    expect(r.datos[0]!.movimientos[0]).toMatchObject({ debeCentavos: 100, haberCentavos: 0 });
    await expect(repo.polizasDelPeriodo(P1, 2026, 7, 1)).rejects.toBeInstanceOf(LibroTopeExcedidoError);
  });
});
