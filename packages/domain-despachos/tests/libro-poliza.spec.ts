// D-24: validación de pólizas, póliza de un CFDI persistido y puente de la balanza del libro al paquete de contabilidad electrónica.
import { describe, expect, it } from "vitest";
import {
  catalogoLibroAAnexo24,
  centavosATexto,
  construirCatalogoBase,
  construirPolizaDesdeCfdi,
  esFechaValida,
  generarPaqueteDesdeLibro,
  naturalezaPorDefecto,
  totalesBalanza,
  validarPolizaEntrada,
} from "../src/libro/index.ts";
import type { InvoiceRecord } from "../src/types.ts";

const BASE = {
  tipo: "ingreso",
  fecha: "2026-07-20",
  concepto: "Honorarios de julio",
  movimientos: [
    { cuenta: "1050000", debe: 116000, haber: 0 },
    { cuenta: "4080000", debe: 0, haber: 100000 },
    { cuenta: "2600400", debe: 0, haber: 16000 },
  ],
};

describe("validarPolizaEntrada", () => {
  it("acepta una póliza cuadrada y normaliza espacios", () => {
    const r = validarPolizaEntrada({ ...BASE, concepto: "  Honorarios  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.valor.concepto).toBe("Honorarios");
      expect(r.valor.movimientos).toHaveLength(3);
      expect(r.valor.movimientos[0]).toEqual({ cuenta: "1050000", concepto: "", debeCentavos: 116000, haberCentavos: 0 });
    }
  });

  it.each([
    ["descuadrada", { ...BASE, movimientos: [{ cuenta: "1050000", debe: 100, haber: 0 }, { cuenta: "4080000", debe: 0, haber: 99 }] }, /descuadrada/],
    ["una sola partida", { ...BASE, movimientos: [{ cuenta: "1050000", debe: 100, haber: 0 }] }, /2 a 200/],
    ["debe y haber a la vez", { ...BASE, movimientos: [{ cuenta: "1050000", debe: 5, haber: 5 }, { cuenta: "4080000", debe: 0, haber: 0 }] }, /uno solo/],
    ["monto con decimales (no son centavos)", { ...BASE, movimientos: [{ cuenta: "1050000", debe: 10.5, haber: 0 }, { cuenta: "4080000", debe: 0, haber: 10.5 }] }, /centavos enteros/],
    ["monto en texto", { ...BASE, movimientos: [{ cuenta: "1050000", debe: "100", haber: 0 }, { cuenta: "4080000", debe: 0, haber: 100 }] }, /centavos enteros/],
    ["monto negativo", { ...BASE, movimientos: [{ cuenta: "1050000", debe: -5, haber: 0 }, { cuenta: "4080000", debe: 0, haber: -5 }] }, /centavos enteros/],
    ["cuenta corta", { ...BASE, movimientos: [{ cuenta: "12", debe: 5, haber: 0 }, { cuenta: "4080000", debe: 0, haber: 5 }] }, /4 a 10 dígitos/],
    ["tipo desconocido", { ...BASE, tipo: "cobro" }, /Tipo de póliza/],
    ["fecha imposible", { ...BASE, fecha: "2026-02-30" }, /Fecha/],
    ["concepto vacío", { ...BASE, concepto: "  " }, /Concepto/],
  ])("rechaza: %s", (_n, body, patron) => {
    const r = validarPolizaEntrada(body as Record<string, unknown>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.map((e) => e.mensaje).join(" ")).toMatch(patron);
  });

  it("más de 200 partidas se rechaza", () => {
    const movimientos = Array.from({ length: 201 }, (_, i) => ({ cuenta: "1050000", debe: i % 2 === 0 ? 1 : 0, haber: i % 2 === 0 ? 0 : 1 }));
    expect(validarPolizaEntrada({ ...BASE, movimientos }).ok).toBe(false);
  });
});

describe("esFechaValida", () => {
  it("calendario real y rango del ejercicio", () => {
    expect(esFechaValida("2028-02-29")).toBe(true);
    expect(esFechaValida("2027-02-29")).toBe(false);
    expect(esFechaValida("2013-12-31")).toBe(false);
    expect(esFechaValida("2026-7-1")).toBe(false);
    expect(esFechaValida(20260701)).toBe(false);
  });
});

function cfdi(parcial: Partial<InvoiceRecord>): InvoiceRecord {
  return {
    id: "i1", organizationId: "o1", propertyId: "p1", folioFiscal: "11111111-1111-1111-1111-111111111111", tipo: "I", rfcEmisor: "AAA010101AAA", rfcReceptor: "BBB010101BBB",
    emisorNombre: null, subtotal: 1000, total: 1160, iva: 160, descuento: 0, categoria: "honorarios", confianza: null, valido: true, issues: [], warnings: [], requiresHumanReview: false,
    diot: { reportable: false } as InvoiceRecord["diot"], fecha: "2026-07-10", createdAt: "2026-07-10T00:00:00Z", direccion: "emitido", metodoPago: "PUE", moneda: "MXN",
    subtotalCentavos: 100000, descuentoCentavos: 0, totalCentavos: 116000, ivaTrasladadoCentavos: 16000, isrRetenidoCentavos: 0, ivaRetenidoCentavos: 0, iepsCentavos: 0, estadoSat: "vigente",
    ...parcial,
  } as InvoiceRecord;
}

describe("construirPolizaDesdeCfdi", () => {
  it("emitido tipo I: cargo Clientes por el total, abono Ingresos por la base e IVA trasladado; cuadra", () => {
    const r = construirPolizaDesdeCfdi(cfdi({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.poliza.tipo).toBe("ingreso");
    expect(r.poliza.fecha).toBe("2026-07-10");
    expect(r.poliza.movimientos.map((m) => [m.cuenta, m.debeCentavos, m.haberCentavos])).toEqual([["1050000", 116000, 0], ["4080000", 0, 100000], ["2600400", 0, 16000]]);
    const reValidada = validarPolizaEntrada({ ...r.poliza, movimientos: r.poliza.movimientos.map((m) => ({ cuenta: m.cuenta, concepto: m.concepto, debe: m.debeCentavos, haber: m.haberCentavos })) });
    expect(reValidada.ok).toBe(true);
  });

  it("el descuento reduce la base (centavos exactos)", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ subtotalCentavos: 100000, descuentoCentavos: 10000, ivaTrasladadoCentavos: 14400, totalCentavos: 104400 }));
    expect(r.ok && r.poliza.movimientos.find((m) => m.cuenta === "4080000")?.haberCentavos).toBe(90000);
  });

  it("emitido tipo E (nota de crédito): invierte el sentido con Devoluciones sobre ventas", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ tipo: "E" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.poliza.tipo).toBe("diario");
      expect(r.poliza.movimientos.map((m) => [m.cuenta, m.debeCentavos, m.haberCentavos])).toEqual([["4020000", 100000, 0], ["2600400", 16000, 0], ["1050000", 0, 116000]]);
    }
  });

  it("recibido tipo I: cuenta de gasto de la categoría, IVA acreditable y proveedores; egreso", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ direccion: "recibido" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.poliza.tipo).toBe("egreso");
      expect(r.poliza.movimientos.map((m) => [m.cuenta, m.debeCentavos, m.haberCentavos])).toEqual([["6020100", 100000, 0], ["2600300", 16000, 0], ["2010000", 0, 116000]]);
    }
  });

  it("recibido de gasto operativo: Servicios administrativos con IVA acreditable", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ direccion: "recibido", categoria: "gasto_operativo" }));
    expect(r.ok && r.poliza.movimientos[0]?.cuenta).toBe("6020200");
  });

  it.each([
    ["cancelado ante el SAT", { estadoSat: "cancelado" as const }, /cancelado/],
    ["sentido indeterminado", { direccion: "indeterminado" as const }, /emitido o recibido/],
    ["sin centavos (ingerido antes de D-22)", { totalCentavos: null, subtotalCentavos: null }, /D-22/],
    ["moneda extranjera", { moneda: "USD" }, /extranjera/],
    ["con retenciones", { isrRetenidoCentavos: 1000 }, /retenciones/],
    ["total distinto de base más IVA", { totalCentavos: 116001 }, /no es igual/],
    ["recibido con categoría sin cuenta automática (activo fijo)", { direccion: "recibido" as const, categoria: "activo_fijo" as InvoiceRecord["categoria"] }, /regístrala a mano/],
    ["recibido sin clasificar", { direccion: "recibido" as const, categoria: "sin_clasificar" as InvoiceRecord["categoria"] }, /regístrala a mano/],
    ["nómina emitida", { tipo: "N" as const }, /no genera póliza automática/],
  ])("no arma la póliza: %s", (_n, parcial, motivo) => {
    const r = construirPolizaDesdeCfdi(cfdi(parcial as Partial<InvoiceRecord>));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(motivo);
  });
});

describe("catálogo base", () => {
  it("la naturaleza sale del rubro, con las excepciones declaradas", () => {
    expect(naturalezaPorDefecto("1020000")).toBe("D");
    expect(naturalezaPorDefecto("2010000")).toBe("A");
    expect(naturalezaPorDefecto("4080000")).toBe("A");
    expect(naturalezaPorDefecto("6020100")).toBe("D");
    expect(naturalezaPorDefecto("4020000")).toBe("D");
    expect(naturalezaPorDefecto("2600300")).toBe("D");
  });
  it("incluye las cuentas que usa la póliza automática", () => {
    const codigos = new Set(construirCatalogoBase().map((c) => c.codigo));
    for (const c of ["1050000", "4080000", "4020000", "2600400", "2600300", "2010000", "6020100"]) expect(codigos.has(c)).toBe(true);
  });
});

describe("balanza del libro -> paquete de contabilidad electrónica", () => {
  // El catálogo completo: una subcuenta (2600400) necesita a su cuenta de mayor (2600000) en el XML.
  const cuentas = construirCatalogoBase();
  const balanza = [
    { cuenta: "1050000", descripcion: "Clientes", naturaleza: "D" as const, saldoInicialCentavos: 0, debeCentavos: 116000, haberCentavos: 0, saldoFinalCentavos: 116000 },
    { cuenta: "2600400", descripcion: "IVA trasladado", naturaleza: "A" as const, saldoInicialCentavos: 0, debeCentavos: 0, haberCentavos: 16000, saldoFinalCentavos: 16000 },
    { cuenta: "4080000", descripcion: "Ingresos", naturaleza: "A" as const, saldoInicialCentavos: 0, debeCentavos: 0, haberCentavos: 100000, saldoFinalCentavos: 100000 },
  ];
  it("centavos a texto exacto", () => {
    expect(centavosATexto(116000)).toBe("1160.00");
    expect(centavosATexto(5)).toBe("0.05");
    expect(centavosATexto(-1234)).toBe("-12.34");
  });
  it("totales cuadran y el paquete trae la balanza con los mismos montos", () => {
    expect(totalesBalanza(balanza)).toEqual({ debeCentavos: 116000, haberCentavos: 116000, cuadrada: true });
    const p = generarPaqueteDesdeLibro({ cuentas, balanza, ejercicio: 2026, mes: 7, rfc: "AAA010101AAA", razonSocial: "Cliente SA", generadoEn: "2026-08-01T10:00:00Z" });
    expect(p.balanza.cuadrada).toBe(true);
    expect(p.resumenBalanza.totalDebe).toBe("1160.00");
    expect(p.balanza.xml).toContain('NumCta="1050000"');
    expect(p.catalogo.xml).toContain('SubCtaDe="2600000"');
    expect(p.balanza.xml).toContain('Debe="1160.00"');
    expect(catalogoLibroAAnexo24(cuentas)[0]).toMatchObject({ grupo: expect.any(String) });
  });
  it("una balanza descuadrada se reporta, no se esconde", () => {
    expect(totalesBalanza([{ ...balanza[0]!, debeCentavos: 1 }]).cuadrada).toBe(false);
  });
});
