// D-25: preparación de pagos desde un REP analizado, doble en memoria y adaptador Postgres con SAVEPOINT (base sin migrar).
import { describe, expect, it } from "vitest";
import type { AnalisisRep } from "../src/cfdi/rep.ts";
import {
  InMemoryPagosProvisionalesRepository,
  PagosDatosInvalidosError,
  PagosNoDisponiblesError,
  PagosNoEncontradoError,
  PagosSinPermisoError,
  PapelYaPresentadoError,
  PostgresPagosProvisionalesRepository,
  prepararPagosDesdeRep,
} from "../src/pagos-provisionales/index.ts";
import type { FacturaProvisional, PagoRepNuevo, PapelAGuardar } from "../src/pagos-provisionales/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P1 = "p1";
const FOLIO_REP = "99999999-9999-9999-9999-999999999999";

function doc(parcial: Record<string, unknown> = {}): AnalisisRep["documentos"][number] {
  return {
    idDocumento: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", pagoIndex: 0, fechaPago: "2026-07-15T12:00:00", periodoFlujo: "2026-07", numParcialidad: 1, monedaDR: "MXN", ligado: true,
    impSaldoAntCentavos: 5_800_000, impPagadoCentavos: 2_900_000, saldoInsolutoDeclaradoCentavos: 2_900_000, saldoInsolutoCalculadoCentavos: 2_900_000, saldoCoherente: true, liquidaFactura: false,
    facturaEsPpd: true, ivaCentavos: 400_000, fuenteIva: "rep", ivaRetenidoCentavos: 0, incluidoEnTotales: true, hallazgos: [], ...parcial,
  } as AnalisisRep["documentos"][number];
}
const analisis = (documentos: AnalisisRep["documentos"][number][]): AnalisisRep =>
  ({ folioFiscalRep: FOLIO_REP, flujo: "trasladado", documentos, totales: { pagadoCentavos: 0, ivaCentavos: 0, ivaRetenidoCentavos: 0 }, porPeriodo: {}, documentosSinLigar: 0, advertencias: [] }) as AnalisisRep;
const FACTURAS = new Map([["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { id: "inv-1", subtotalCentavos: 5_000_000, descuentoCentavos: 0, totalCentavos: 5_800_000 }]]);

describe("prepararPagosDesdeRep", () => {
  it("la base se prorratea de la FACTURA persistida (no del cliente): 5,000,000 x 2,900,000 / 5,800,000 = 2,500,000", () => {
    const r = prepararPagosDesdeRep(analisis([doc()]), FACTURAS);
    expect(r.omitidos).toEqual([]);
    expect(r.aRegistrar).toEqual([{ invoiceId: "inv-1", folioFiscalRep: FOLIO_REP, pagoIndex: 0, fechaPago: "2026-07-15", flujo: "trasladado", numParcialidad: 1, importePagadoCentavos: 2_900_000, baseCentavos: 2_500_000, ivaCentavos: 400_000, ivaRetenidoCentavos: 0 }]);
  });
  it("el descuento del CFDI reduce la base prorrateada", () => {
    const r = prepararPagosDesdeRep(analisis([doc()]), new Map([["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { id: "inv-1", subtotalCentavos: 5_000_000, descuentoCentavos: 500_000, totalCentavos: 5_800_000 }]]));
    expect(r.aRegistrar[0]!.baseCentavos).toBe(2_250_000);
  });
  it.each([
    ["no ligado", { ligado: false }, /no está en este cliente/],
    ["moneda extranjera", { incluidoEnTotales: false }, /moneda distinta/],
    ["no es PPD", { facturaEsPpd: false }, /no es PPD/],
    ["método de pago desconocido", { facturaEsPpd: null }, /no es PPD/],
    ["saldo incoherente", { saldoCoherente: false }, /saldo insoluto/],
    ["sin IVA", { ivaCentavos: null, fuenteIva: "sin_dato" }, /No hay IVA/],
    ["pagado en cero", { impPagadoCentavos: 0 }, /mayor a cero/],
  ])("omite con motivo: %s", (_n, parcial, motivo) => {
    const r = prepararPagosDesdeRep(analisis([doc(parcial)]), FACTURAS);
    expect(r.aRegistrar).toHaveLength(0);
    expect(r.omitidos[0]!.motivo).toMatch(motivo);
  });
});

function factura(p: Partial<FacturaProvisional>): FacturaProvisional {
  return { id: "inv-1", folioFiscal: "f", tipo: "I", valido: true, fecha: "2026-06-20", direccion: "emitido", metodoPago: "PPD", formaPago: "99", usoCfdi: "G03", moneda: "MXN", subtotalCentavos: 5_000_000, descuentoCentavos: 0, totalCentavos: 5_800_000, ivaTrasladadoCentavos: 800_000, isrRetenidoCentavos: 0, ivaRetenidoCentavos: 0, estadoSat: "vigente", ...p };
}
function pago(p: Partial<PagoRepNuevo> = {}): PagoRepNuevo {
  return { invoiceId: "inv-1", folioFiscalRep: FOLIO_REP, pagoIndex: 0, fechaPago: "2026-07-15", flujo: "trasladado", numParcialidad: 1, importePagadoCentavos: 2_900_000, baseCentavos: 2_500_000, ivaCentavos: 400_000, ivaRetenidoCentavos: 0, ...p };
}
const PAPEL: PapelAGuardar = { ejercicio: 2026, mes: 7, impuesto: "ISR", regimen: "601", baseCentavos: 2_000_000, determinadoCentavos: 600_000, acreditableCentavos: 200_000, aCargoCentavos: 400_000, aFavorCentavos: 0, parametros: { coeficienteUtilidad: "0.2" }, advertencias: 0 };

describe("InMemoryPagosProvisionalesRepository", () => {
  it("el pago es idempotente y la base incluye el CFDI de un mes anterior pagado en el rango", async () => {
    const repo = new InMemoryPagosProvisionalesRepository();
    repo.sembrarFacturas(factura({}), factura({ id: "otra", fecha: "2025-12-01" }));
    expect(await repo.registrarPago(P1, pago())).toBe(true);
    expect(await repo.registrarPago(P1, pago())).toBe(false);
    const base = await repo.leerBase(P1, 2026, 7);
    expect(base.pagos).toHaveLength(1);
    expect(base.facturas.map((f) => f.id)).toEqual(["inv-1"]);
  });
  it("rechaza sobrepago, CFDI no PPD y flujo contrario al sentido", async () => {
    const repo = new InMemoryPagosProvisionalesRepository();
    repo.sembrarFacturas(factura({}), factura({ id: "pue", metodoPago: "PUE" }));
    await repo.registrarPago(P1, pago({ importePagadoCentavos: 5_000_000 }));
    await expect(repo.registrarPago(P1, pago({ pagoIndex: 1, importePagadoCentavos: 900_000 }))).rejects.toBeInstanceOf(PagosDatosInvalidosError);
    await expect(repo.registrarPago(P1, pago({ invoiceId: "pue" }))).rejects.toBeInstanceOf(PagosDatosInvalidosError);
    await expect(repo.registrarPago(P1, pago({ invoiceId: "no-existe" }))).rejects.toBeInstanceOf(PagosNoEncontradoError);
    await expect(repo.registrarPago(P1, pago({ pagoIndex: 2, flujo: "acreditable" }))).rejects.toBeInstanceOf(PagosDatosInvalidosError);
  });
  it("el papel se guarda, se actualiza, se presenta y ya no se recalcula", async () => {
    const repo = new InMemoryPagosProvisionalesRepository();
    await repo.guardarPapel(P1, PAPEL);
    await repo.guardarPapel(P1, { ...PAPEL, aCargoCentavos: 555 });
    const antes = await repo.listarPapeles(P1, 2026);
    expect(antes.papeles).toHaveLength(1);
    expect(antes.papeles[0]).toMatchObject({ estado: "borrador", aCargoCentavos: 555 });
    await repo.presentarPapel(P1, 2026, 7, "ISR", 555, "2026-08-14");
    expect((await repo.listarPapeles(P1, 2026)).papeles[0]).toMatchObject({ estado: "presentado", montoPagadoCentavos: 555, fechaPresentacion: "2026-08-14" });
    await expect(repo.guardarPapel(P1, PAPEL)).rejects.toBeInstanceOf(PapelYaPresentadoError);
    await expect(repo.presentarPapel(P1, 2026, 7, "ISR", 1, "2026-08-14")).rejects.toBeInstanceOf(PapelYaPresentadoError);
    await expect(repo.presentarPapel(P1, 2026, 8, "ISR", 1, "2026-09-14")).rejects.toBeInstanceOf(PagosNoEncontradoError);
  });
  it("base sin migrar: lecturas vacías con estado, escrituras PagosNoDisponiblesError", async () => {
    const repo = new InMemoryPagosProvisionalesRepository();
    repo.disponible = false;
    expect(await repo.listarPapeles(P1, 2026)).toEqual({ estado: "no_disponible", papeles: [] });
    expect((await repo.leerBase(P1, 2026, 7)).pagosDisponibles).toBe(false);
    await expect(repo.guardarPapel(P1, PAPEL)).rejects.toBeInstanceOf(PagosNoDisponiblesError);
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
const tablaPagoInexistente = () => pgError("42P01", 'relation "despachos.pago_cfdi" does not exist');
const columnaInexistente = () => pgError("42703", 'column i.direccion does not exist');
const funcionInexistente = (n: string) => pgError("42883", `function despachos.${n}(uuid, integer) does not exist`);
const FILA_FACTURA = { id: "inv-1", folio_fiscal: "f", tipo: "I", valido: true, fecha: "2026-06-20", direccion: "emitido", metodo_pago: "PPD", forma_pago: "99", uso_cfdi: "G03", moneda: "MXN", subtotal_centavos: "5000000", descuento_centavos: "0", total_centavos: "5800000", iva_trasladado_centavos: "800000", isr_retenido_centavos: null, iva_retenido_centavos: null, estado_sat: "vigente" };

describe("PostgresPagosProvisionalesRepository (SAVEPOINT, base sin migrar)", () => {
  it("lee la base: convierte bigint (texto) a centavos y deja null lo desconocido", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from despachos\.pago_cfdi/i, respond: () => [{ invoice_id: "inv-1", fecha_pago: "2026-07-15", flujo: "trasladado", importe_pagado_centavos: "2900000", base_centavos: "2500000", iva_centavos: "400000", iva_retenido_centavos: "0" }] },
      { match: /from despachos\.invoice/i, respond: () => [FILA_FACTURA] },
    ]);
    const base = await new PostgresPagosProvisionalesRepository(session).leerBase(P1, 2026, 7);
    expect(base).toMatchObject({ facturasDisponibles: true, pagosDisponibles: true, truncado: false });
    expect(base.pagos[0]).toMatchObject({ importePagadoCentavos: 2_900_000, baseCentavos: 2_500_000 });
    expect(base.facturas[0]).toMatchObject({ totalCentavos: 5_800_000, isrRetenidoCentavos: null, metodoPago: "PPD" });
  });

  it("REGLA DURA: sin la tabla pago_cfdi (42P01) sigue con los CFDI en la MISMA transacción (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from despachos\.pago_cfdi/i, respond: tablaPagoInexistente },
      { match: /from despachos\.invoice/i, respond: () => [FILA_FACTURA] },
    ]);
    const base = await new PostgresPagosProvisionalesRepository(session).leerBase(P1, 2026, 7);
    expect(base.pagosDisponibles).toBe(false);
    expect(base.pagos).toEqual([]);
    expect(base.facturas).toHaveLength(1);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("REGLA DURA: sin el modelo CFDI completo (42703) la base queda no disponible y la sesión sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from despachos\.pago_cfdi/i, respond: () => [] },
      { match: /from despachos\.invoice/i, respond: columnaInexistente },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const base = await new PostgresPagosProvisionalesRepository(session).leerBase(P1, 2026, 7);
    expect(base).toMatchObject({ facturasDisponibles: false, facturas: [] });
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("D-P3-23: el papel excluye los CFDI con revisión rechazada (not i.excluido_por_revision)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from despachos\.pago_cfdi/i, respond: () => [] },
      { match: /not i\.excluido_por_revision/i, respond: () => [FILA_FACTURA] },
      { match: /from despachos\.invoice/i, respond: () => [FILA_FACTURA, { ...FILA_FACTURA, id: "inv-rechazado" }] },
    ]);
    const base = await new PostgresPagosProvisionalesRepository(session).leerBase(P1, 2026, 7);
    expect(base.facturas.map((f) => f.id)).toEqual(["inv-1"]);
  });

  it("REGLA DURA (42703 en excluido_por_revision, base sin migrar): cae a la consulta anterior en la MISMA transacción, sin 25P02 y SIN marcar la base no disponible", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from despachos\.pago_cfdi/i, respond: () => [] },
      { match: /not i\.excluido_por_revision/i, respond: () => pgError("42703", 'column i.excluido_por_revision does not exist') },
      { match: /from despachos\.invoice/i, respond: () => [FILA_FACTURA] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const base = await new PostgresPagosProvisionalesRepository(session).leerBase(P1, 2026, 7);
    expect(base).toMatchObject({ facturasDisponibles: true });
    expect(base.facturas).toHaveLength(1);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("más CFDI que el tope: marca truncado (el papel NO se calcula incompleto)", async () => {
    const filas = Array.from({ length: 20_001 }, () => FILA_FACTURA);
    const session = new AbortAwareFakeSession([{ match: /from despachos\.pago_cfdi/i, respond: () => [] }, { match: /from despachos\.invoice/i, respond: () => filas }]);
    const base = await new PostgresPagosProvisionalesRepository(session).leerBase(P1, 2026, 7);
    expect(base.truncado).toBe(true);
    expect(base.facturas).toHaveLength(20_000);
  });

  it("papeles: lectura mapea y la base sin migrar devuelve no_disponible", async () => {
    const fila = { id: "x", ejercicio: 2026, mes: 7, impuesto: "ISR", regimen: "601", base_centavos: "2000000", determinado_centavos: "600000", acreditable_centavos: "200000", a_cargo_centavos: "400000", a_favor_centavos: "0", parametros: { a: 1 }, advertencias: 1, estado: "borrador", monto_pagado_centavos: null, fecha_presentacion: null, updated_at: "2026-08-01T00:00:00Z" };
    expect((await new PostgresPagosProvisionalesRepository(new AbortAwareFakeSession([{ match: /from despachos\.pago_provisional/i, respond: () => [fila] }])).listarPapeles(P1, 2026)).papeles[0]).toMatchObject({ aCargoCentavos: 400_000, estado: "borrador", montoPagadoCentavos: null });
    const session = new AbortAwareFakeSession([{ match: /from despachos\.pago_provisional/i, respond: tablaPagoInexistente }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    expect(await new PostgresPagosProvisionalesRepository(session).listarPapeles(P1, 2026)).toEqual({ estado: "no_disponible", papeles: [] });
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("escrituras: 42883 de la función de la migración -> PagosNoDisponiblesError sin abortar la transacción", async () => {
    const session = new AbortAwareFakeSession([{ match: /pago_provisional_guardar/i, respond: () => funcionInexistente("pago_provisional_guardar") }, { match: /pago_cfdi_registrar/i, respond: () => funcionInexistente("pago_cfdi_registrar") }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    const repo = new PostgresPagosProvisionalesRepository(session);
    await expect(repo.guardarPapel(P1, PAPEL)).rejects.toBeInstanceOf(PagosNoDisponiblesError);
    await expect(repo.registrarPago(P1, pago())).rejects.toBeInstanceOf(PagosNoDisponiblesError);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("un 42883 de OTRA función no se disfraza de 'no disponible'", async () => {
    const session = new AbortAwareFakeSession([{ match: /pago_provisional_guardar/i, respond: () => pgError("42883", "function core.has_property_access(uuid) does not exist") }]);
    await expect(new PostgresPagosProvisionalesRepository(session).guardarPapel(P1, PAPEL)).rejects.toMatchObject({ code: "42883" });
  });

  it.each([
    ["42501", "pago_cfdi_registrar: sin permiso sobre el cliente", PagosSinPermisoError],
    ["22023", "pago_cfdi_registrar: los pagos suman más que el total del CFDI", PagosDatosInvalidosError],
    ["P0002", "pago_cfdi_registrar: CFDI no encontrado", PagosNoEncontradoError],
    ["55000", "pago_provisional_guardar: el pago provisional ya fue presentado; no se recalcula", PapelYaPresentadoError],
  ])("SQLSTATE %s -> error de dominio", async (code, mensaje, clase) => {
    const session = new AbortAwareFakeSession([{ match: /pago_cfdi_registrar|pago_provisional/i, respond: () => pgError(code, mensaje) }]);
    const repo = new PostgresPagosProvisionalesRepository(session);
    await expect(code === "55000" ? repo.guardarPapel(P1, PAPEL) : repo.registrarPago(P1, pago())).rejects.toBeInstanceOf(clase);
  });

  it("registrarPago devuelve true/false según la función (idempotencia)", async () => {
    const nuevo = new PostgresPagosProvisionalesRepository(new AbortAwareFakeSession([{ match: /pago_cfdi_registrar/i, respond: () => [{ pago_cfdi_registrar: true }] }]));
    const repetido = new PostgresPagosProvisionalesRepository(new AbortAwareFakeSession([{ match: /pago_cfdi_registrar/i, respond: () => [{ pago_cfdi_registrar: false }] }]));
    expect(await nuevo.registrarPago(P1, pago())).toBe(true);
    expect(await repetido.registrarPago(P1, pago())).toBe(false);
  });
});
