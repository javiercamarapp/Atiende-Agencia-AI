// D-P3-17: repositorio de pólizas de cobro/pago de REP -- doble en memoria (mismas reglas que libro_poliza_registrar_rep, migración 028) y adaptador
// Postgres (SAVEPOINT, base sin migrar, traducción de SQLSTATE).
import { describe, expect, it } from "vitest";
import {
  InMemoryLibroRepository,
  LibroDatosInvalidosError,
  LibroNoDisponibleError,
  LibroNoEncontradoError,
  PeriodoLibroCerradoError,
  PolizaDuplicadaError,
  PostgresLibroRepository,
  construirCatalogoBase,
  construirPolizaDesdeRep,
} from "../src/libro/index.ts";
import type { PagoRepContable, PolizaInput } from "../src/libro/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P1 = "p1";
const PAGO: PagoRepContable = {
  pagoId: "pg1", folioFiscalRep: "22222222-2222-2222-2222-222222222222", pagoIndex: 0, fechaPago: "2026-07-28", flujo: "trasladado", numParcialidad: 1, importePagadoCentavos: 58000,
  baseCentavos: 50000, ivaCentavos: 8000, ivaRetenidoCentavos: 0, folioFiscalCfdi: "11111111-1111-1111-1111-111111111111", direccionCfdi: "emitido", metodoPagoCfdi: "PPD", monedaCfdi: "MXN", estadoSatCfdi: "vigente",
};
function poliza(p: PagoRepContable = PAGO): PolizaInput {
  const r = construirPolizaDesdeRep(p);
  if (!r.ok) throw new Error(r.motivo);
  return r.poliza;
}
async function repoConPago(): Promise<InMemoryLibroRepository> {
  const repo = new InMemoryLibroRepository();
  await repo.sembrarCatalogo(P1, construirCatalogoBase());
  repo.agregarPagoRep(P1, PAGO);
  return repo;
}
function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

describe("InMemoryLibroRepository: pólizas de REP", () => {
  it("registra la póliza, la liga al pago y la lista como vigente", async () => {
    const repo = await repoConPago();
    expect((await repo.listarPagosRep(P1, { folioFiscalRep: PAGO.folioFiscalRep })).datos[0]?.polizaVigente).toBeNull();
    const r = await repo.registrarPolizaRep(P1, "pg1", poliza());
    expect(r.folio).toBe(1);
    const lista = (await repo.listarPagosRep(P1, { ejercicio: 2026, mes: 7 })).datos;
    expect(lista[0]?.polizaVigente).toMatchObject({ id: r.polizaId, folio: 1, tipo: "ingreso" });
    expect((await repo.listarPagosRep(P1, { ejercicio: 2026, mes: 8 })).datos).toHaveLength(0);
  });

  it("una sola póliza vigente por pago; al reversarla el pago queda libre", async () => {
    const repo = await repoConPago();
    const a = await repo.registrarPolizaRep(P1, "pg1", poliza());
    await expect(repo.registrarPolizaRep(P1, "pg1", poliza())).rejects.toBeInstanceOf(PolizaDuplicadaError);
    await repo.reversarPoliza(P1, a.polizaId, "2026-07-30", "Corrección");
    expect((await repo.listarPagosRep(P1, {})).datos[0]?.polizaVigente).toBeNull();
    await expect(repo.registrarPolizaRep(P1, "pg1", poliza())).resolves.toMatchObject({ folio: 2 });
  });

  it("la póliza queda amarrada al pago: tipo según el flujo, fecha de pago y total", async () => {
    const repo = await repoConPago();
    const p = poliza();
    await expect(repo.registrarPolizaRep(P1, "pg1", { ...p, tipo: "egreso" })).rejects.toBeInstanceOf(LibroDatosInvalidosError);
    await expect(repo.registrarPolizaRep(P1, "pg1", { ...p, fecha: "2026-07-27" })).rejects.toThrow(/fecha de pago/);
    const inflada = { ...p, movimientos: p.movimientos.map((m, i) => (i === 0 ? { ...m, debeCentavos: m.debeCentavos + 1 } : i === 1 ? { ...m, haberCentavos: m.haberCentavos + 1 } : m)) };
    await expect(repo.registrarPolizaRep(P1, "pg1", inflada)).rejects.toThrow(/importe pagado más el IVA/);
  });

  it("pago inexistente o de otra property, periodo cerrado y base sin migrar", async () => {
    const repo = await repoConPago();
    await expect(repo.registrarPolizaRep(P1, "no-existe", poliza())).rejects.toBeInstanceOf(LibroNoEncontradoError);
    await expect(repo.registrarPolizaRep("p2", "pg1", poliza())).rejects.toBeInstanceOf(LibroNoEncontradoError);
    repo.periodosCerrados.add(`${P1}|2026-07`);
    await expect(repo.registrarPolizaRep(P1, "pg1", poliza())).rejects.toBeInstanceOf(PeriodoLibroCerradoError);
    repo.disponible = false;
    await expect(repo.registrarPolizaRep(P1, "pg1", poliza())).rejects.toBeInstanceOf(LibroNoDisponibleError);
    expect(await repo.listarPagosRep(P1, {})).toEqual({ estado: "no_disponible", datos: [] });
  });
});

describe("PostgresLibroRepository: pólizas de REP (SAVEPOINT, base sin migrar 028)", () => {
  const FILA = {
    id: "pg1", folio_fiscal_rep: PAGO.folioFiscalRep, pago_index: 0, fecha_pago: "2026-07-28", flujo: "trasladado", num_parcialidad: 1, importe_pagado_centavos: "58000", base_centavos: "50000", iva_centavos: "8000",
    iva_retenido_centavos: "0", folio_fiscal: PAGO.folioFiscalCfdi, direccion: "emitido", metodo_pago: "PPD", moneda: "MXN", estado_sat: "vigente", poliza_id: null, poliza_folio: null, poliza_tipo: null,
  };

  it("lee los pagos con su póliza vigente y convierte bigint a centavos enteros", async () => {
    const repo = new PostgresLibroRepository(new AbortAwareFakeSession([{ match: /from despachos\.pago_cfdi/i, respond: () => [FILA, { ...FILA, id: "pg2", poliza_id: "pol-1", poliza_folio: 4, poliza_tipo: "ingreso" }] }]));
    const r = await repo.listarPagosRep(P1, { folioFiscalRep: PAGO.folioFiscalRep });
    expect(r.estado).toBe("disponible");
    expect(r.datos[0]).toMatchObject({ pagoId: "pg1", importePagadoCentavos: 58000, ivaCentavos: 8000, fechaPago: "2026-07-28", polizaVigente: null });
    expect(r.datos[1]?.polizaVigente).toEqual({ id: "pol-1", folio: 4, tipo: "ingreso" });
  });

  it("REGLA DURA (42P01: sin la tabla de ligas de la 028): vacío honesto + no_disponible y sesión utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from despachos\.pago_cfdi/i, respond: () => pgError("42P01", 'relation "despachos.libro_poliza_rep" does not exist') }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    expect(await new PostgresLibroRepository(session).listarPagosRep(P1, {})).toEqual({ estado: "no_disponible", datos: [] });
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("REGLA DURA (42883): registrar contra la base sin la función -> LibroNoDisponibleError y sesión utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /libro_poliza_registrar_rep/i, respond: () => pgError("42883", "function despachos.libro_poliza_registrar_rep(uuid, uuid, text, date, text, jsonb) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresLibroRepository(session).registrarPolizaRep(P1, "pg1", poliza())).rejects.toBeInstanceOf(LibroNoDisponibleError);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it.each([
    ["23505", "libro_poliza_registrar_rep: el pago ya tiene una póliza vigente", PolizaDuplicadaError],
    ["P0002", "libro_poliza_registrar_rep: pago no encontrado", LibroNoEncontradoError],
    ["22023", "libro_poliza_registrar_rep: el tipo de póliza no corresponde al flujo del pago", LibroDatosInvalidosError],
    ["55000", "libro_poliza: el periodo 2026-07 está cerrado", PeriodoLibroCerradoError],
  ])("SQLSTATE %s -> error de dominio tipado", async (code, mensaje, clase) => {
    const repo = new PostgresLibroRepository(new AbortAwareFakeSession([{ match: /libro_poliza_registrar_rep/i, respond: () => pgError(code, mensaje) }]));
    await expect(repo.registrarPolizaRep(P1, "pg1", poliza())).rejects.toBeInstanceOf(clase);
  });

  it("serializa las partidas en centavos enteros", async () => {
    const llamadas: unknown[][] = [];
    const session = new AbortAwareFakeSession([{ match: /libro_poliza_registrar_rep/i, respond: () => [{ out_poliza_id: "pol-9", out_folio: 4 }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      llamadas.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    expect(await new PostgresLibroRepository(session).registrarPolizaRep(P1, "pg1", poliza())).toEqual({ polizaId: "pol-9", folio: 4 });
    expect(llamadas[0]![1]).toBe("pg1");
    expect(JSON.parse(llamadas[0]![5] as string)[0]).toEqual({ cuenta: "1020000", concepto: expect.any(String), debe: 58000, haber: 0 });
  });
});
