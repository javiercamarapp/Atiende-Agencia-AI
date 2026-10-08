// D-01 — reportes de cliente (DIOT, impuestos, nómina, balanza) calculados solo desde datos
// reales del modelo; lo que no existe se declara "sin datos".
import { describe, expect, it } from "vitest";
import { construirReporteBalanza, construirReporteCliente, construirReporteDiot, construirReporteImpuestos, construirReporteNomina } from "../src/reportes/builders.ts";
import type { EntradaReporte, PapelesReporte } from "../src/reportes/builders.ts";
import type { PapelGuardado } from "../src/pagos-provisionales/repository.ts";
import type { FiscalDeadlineRecord, InvoiceRecord } from "../src/types.ts";

const ENTRADA: EntradaReporte = { periodo: "2026-08", generadoEn: "2026-09-30", contribuyente: { nombre: "Cliente Uno SA de CV" }, rfcContribuyente: "CLI010101CL1" };

function invoice(id: string, extra: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id,
    organizationId: "org",
    propertyId: "p1",
    folioFiscal: `UUID-${id}`,
    tipo: "I",
    rfcEmisor: "AAA010101AAA",
    rfcReceptor: "CLI010101CL1",
    emisorNombre: "Proveedor Uno",
    subtotal: 1000,
    total: 1160,
    iva: 160,
    descuento: 0,
    categoria: "gasto_operativo",
    confianza: null,
    valido: true,
    issues: [],
    warnings: [],
    requiresHumanReview: false,
    diot: {
      reportable: true,
      proveedoresReportables: [{ rfcProveedor: "AAA010101AAA", nombreProveedor: "Proveedor Uno", totalOperacion: "1000", ivaAcreditable: "160", periodo: "2026-08", tasaIva: 0.16 }],
    },
    fecha: "2026-08-10",
    createdAt: "2026-08-11T00:00:00Z",
    ...extra,
  };
}

function vencimiento(id: string, extra: Partial<FiscalDeadlineRecord> = {}): FiscalDeadlineRecord {
  return { id, organizationId: "org", propertyId: "p1", tipo: "IVA", periodo: "2026-08", fechaLimite: "2026-09-17", prioridad: "alta", estado: "pendiente", fechaPresentacion: null, comprobanteUrl: null, createdAt: "2026-08-01T00:00:00Z", ...extra };
}

describe("reporte DIOT", () => {
  it("agrega por proveedor con IVA acreditable 16% y totales, RFC del contribuyente de la ficha", () => {
    const r = construirReporteDiot(ENTRADA, [invoice("1"), invoice("2", { subtotal: 500, total: 580, iva: 80 })]);
    expect(r.sinDatos).toBe(false);
    expect(r.contribuyente).toEqual({ nombre: "Cliente Uno SA de CV", rfc: "CLI010101CL1" });
    const s = r.secciones[0]!;
    expect(s.filas).toHaveLength(1);
    expect(s.filas[0]).toMatchObject({ rfc: "AAA010101AAA", tipoOperacion: "85 - Otros", operaciones: 2, montoNeto: 1500, iva16: 240 });
    expect(s.totales).toMatchObject({ operaciones: 2, montoNeto: 1500, iva16: 240 });
  });

  it("sin CFDI reportables: sin datos con motivo, sin filas y sin RFC inventado", () => {
    const r = construirReporteDiot(ENTRADA, [invoice("1", { tipo: "N", diot: { reportable: false, proveedoresReportables: [] } })]);
    expect(r.sinDatos).toBe(true);
    expect(r.contribuyente.rfc).toBe("CLI010101CL1");
    expect(r.secciones[0]).toMatchObject({ filas: [], totales: null });
    expect(r.secciones[0]!.sinDatosMotivo).toContain("No hay CFDI");
  });

  it("D-P3-01: excluye emitidos, cancelados, no encontrados e inválidos; el RFC sale de la ficha, no del CFDI", () => {
    const r = construirReporteDiot(ENTRADA, [
      invoice("ok", { direccion: "recibido", estadoSat: "vigente" }),
      invoice("venta", { direccion: "emitido", rfcEmisor: "CLI010101CL1", rfcReceptor: "CLIENTE0001X9" }),
      invoice("cancelado", { direccion: "recibido", estadoSat: "cancelado" }),
      invoice("noenc", { direccion: "recibido", estadoSat: "no_encontrado" }),
      invoice("invalido", { direccion: "recibido", valido: false }),
    ]);
    expect(r.secciones[0]!.filas).toHaveLength(1);
    expect(r.secciones[0]!.filas[0]).toMatchObject({ operaciones: 1, montoNeto: 1000 });
    expect(r.contribuyente.rfc).toBe("CLI010101CL1");
  });

  it("D-P3-01: sin ficha (sin RFC) la DIOT queda sin datos con motivo verdadero, aunque haya CFDI", () => {
    const r = construirReporteDiot({ ...ENTRADA, rfcContribuyente: null }, [invoice("1", { direccion: "recibido" })]);
    expect(r.sinDatos).toBe(true);
    expect(r.contribuyente.rfc).toBeNull();
    expect(r.secciones[0]!.sinDatosMotivo).toContain("ficha");
  });

  it("D-P3-01: todo emitido -> sin datos y el motivo cuenta lo excluido", () => {
    const r = construirReporteDiot(ENTRADA, [invoice("v", { direccion: "emitido" })]);
    expect(r.sinDatos).toBe(true);
    expect(r.secciones[0]!.sinDatosMotivo).toContain("1 CFDI quedaron fuera");
  });

  it("excluye RFC genérico del público en general", () => {
    const r = construirReporteDiot(ENTRADA, [invoice("1", { rfcEmisor: "XAXX010101000" })]);
    expect(r.secciones[0]!.filas).toHaveLength(0);
  });
});

function papel(extra: Partial<PapelGuardado> = {}): PapelGuardado {
  return { id: "p1", ejercicio: 2026, mes: 8, impuesto: "IVA", regimen: "601", baseCentavos: 1_000_000, determinadoCentavos: 160_000, acreditableCentavos: 64_000, aCargoCentavos: 96_000, aFavorCentavos: 0, parametros: {}, advertencias: 1, estado: "borrador", montoPagadoCentavos: null, fechaPresentacion: null, updatedAt: "2026-09-01T00:00:00Z", ...extra };
}
const DISPONIBLE = (papeles: PapelGuardado[]): PapelesReporte => ({ estado: "disponible", papeles });

describe("reporte de impuestos (D-P3-05: lee el papel de pagos provisionales persistido)", () => {
  it("muestra IVA e ISR del papel guardado del periodo, en pesos, y las obligaciones del periodo", () => {
    const r = construirReporteImpuestos(
      ENTRADA,
      [vencimiento("v2", { tipo: "ISR" }), vencimiento("v1")],
      DISPONIBLE([papel(), papel({ id: "p2", impuesto: "ISR", baseCentavos: 2_000_000, determinadoCentavos: 600_000, acreditableCentavos: 200_000, aCargoCentavos: 400_000, estado: "presentado", fechaPresentacion: "2026-09-12" }), papel({ id: "p3", mes: 7 })]),
    );
    const [papeles, obligaciones] = r.secciones;
    expect(papeles!.sinDatosMotivo).toBeNull();
    expect(papeles!.filas).toHaveLength(2); // el papel de julio (mes 7) no entra
    expect(papeles!.filas[0]).toMatchObject({ impuesto: "ISR", estado: "Presentado", base: 20000, determinado: 6000, aCargo: 4000, presentado: "2026-09-12" });
    expect(papeles!.filas[1]).toMatchObject({ impuesto: "IVA", estado: "Borrador", base: 10000, determinado: 1600, acreditable: 640, aCargo: 960, aFavor: 0 });
    expect(obligaciones!.filas.map((f) => f.obligacion)).toEqual(["ISR", "IVA"]); // misma fecha límite: orden alfabético
    expect(r.sinDatos).toBe(false);
    expect(r.contribuyente.rfc).toBe("CLI010101CL1");
    expect(r.notas.join(" ")).not.toContain("no persiste");
  });

  it("sin papel guardado del periodo: sin datos con el motivo verdadero (no dice que el modelo no persiste emitidos)", () => {
    const r = construirReporteImpuestos(ENTRADA, [], DISPONIBLE([papel({ mes: 7 })]));
    expect(r.secciones[0]!.filas).toEqual([]);
    expect(r.secciones[0]!.sinDatosMotivo).toBe("No se ha generado el papel de pagos provisionales de 2026-08: genéralo y guárdalo en Pagos provisionales para ver aquí el IVA y el ISR del periodo.");
    expect(r.sinDatos).toBe(true);
  });

  it("base sin la migracion 020: sin datos con motivo honesto de no disponible", () => {
    const r = construirReporteImpuestos(ENTRADA, [], { estado: "no_disponible", papeles: [] });
    expect(r.secciones[0]!.sinDatosMotivo).toContain("migración 020");
  });

  it("sin nada en el período: todo el reporte es sin datos y sin RFC si no hay ficha", () => {
    const r = construirReporteImpuestos({ ...ENTRADA, rfcContribuyente: null }, [], DISPONIBLE([]));
    expect(r.sinDatos).toBe(true);
    expect(r.contribuyente.rfc).toBeNull();
  });
});

describe("reporte de nómina", () => {
  it("lista los recibos CFDI tipo N y declara sin datos el desglose por empleado", () => {
    const r = construirReporteNomina(ENTRADA, [invoice("1", { tipo: "N", total: 8000, fecha: "2026-08-15" }), invoice("2", { tipo: "N", total: 9000, fecha: "2026-08-01" }), invoice("3")]);
    const [recibos, desglose] = r.secciones;
    expect(recibos!.filas.map((f) => f.total)).toEqual([9000, 8000]); // ordenados por fecha
    expect(recibos!.totales).toMatchObject({ total: 17000, folioFiscal: "2 recibo(s)" });
    expect(desglose!.filas).toEqual([]);
    expect(desglose!.sinDatosMotivo).toContain("no se persiste");
  });

  it("sin CFDI de nómina: sin datos", () => {
    expect(construirReporteNomina(ENTRADA, [invoice("1")]).sinDatos).toBe(true);
  });
});

describe("reporte de balanza", () => {
  it("la balanza queda sin datos (no hay asientos) y el insumo por categoría es dato real rotulado como tal", () => {
    const r = construirReporteBalanza(ENTRADA, [invoice("1"), invoice("2", { categoria: "honorarios", subtotal: 3000, total: 3480, iva: 480 }), invoice("3")]);
    const [balanza, resumen] = r.secciones;
    expect(balanza!.filas).toEqual([]);
    expect(balanza!.sinDatosMotivo).toContain("no tiene pólizas");
    expect(resumen!.titulo).toContain("no es la balanza");
    expect(resumen!.filas[0]).toMatchObject({ categoria: "Honorarios", total: 3480 });
    expect(resumen!.totales).toMatchObject({ cfdi: 3, subtotal: 5000, iva: 800, total: 5800 });
    expect(r.sinDatos).toBe(false);
  });

  it("sin CFDI en el período todo es sin datos", () => {
    expect(construirReporteBalanza(ENTRADA, []).sinDatos).toBe(true);
  });

  it("con la balanza del libro (D-24) la sección se llena con las cuentas del libro, en pesos, con totales; los centavos no se pierden", () => {
    const r = construirReporteBalanza(ENTRADA, [], [
      { cuenta: "1050000", descripcion: "Clientes", naturaleza: "D", saldoInicialCentavos: 0, debeCentavos: 116005, haberCentavos: 0, saldoFinalCentavos: 116005 },
      { cuenta: "4080000", descripcion: "Ingresos por servicios", naturaleza: "A", saldoInicialCentavos: 0, debeCentavos: 0, haberCentavos: 116005, saldoFinalCentavos: 116005 },
    ]);
    const balanza = r.secciones[0]!;
    expect(balanza.sinDatosMotivo).toBeNull();
    expect(balanza.filas[0]).toMatchObject({ cuenta: "1050000 Clientes", debe: 1160.05, haber: 0 });
    expect(balanza.totales).toMatchObject({ debe: 1160.05, haber: 1160.05 });
    expect(r.sinDatos).toBe(false);
  });

  it("una balanza del libro vacía conserva el 'sin datos' honesto", () => {
    expect(construirReporteBalanza(ENTRADA, [], []).secciones[0]!.sinDatosMotivo).toContain("no tiene pólizas");
  });
});

describe("construirReporteCliente", () => {
  it("despacha al constructor del tipo pedido", () => {
    const fuentes = { invoicesDelPeriodo: [invoice("1")], vencimientosDelPeriodo: [] };
    expect(construirReporteCliente("diot", ENTRADA, fuentes).tipo).toBe("diot");
    expect(construirReporteCliente("impuestos", ENTRADA, fuentes).tipo).toBe("impuestos");
    expect(construirReporteCliente("nomina", ENTRADA, fuentes).tipo).toBe("nomina");
    expect(construirReporteCliente("balanza", ENTRADA, fuentes).tipo).toBe("balanza");
  });
});
