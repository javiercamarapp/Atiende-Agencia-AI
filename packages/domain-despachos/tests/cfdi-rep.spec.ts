import { describe, expect, it } from "vitest";
import type { RepDocumentoRelacionado, RepParseResult } from "@atiende/billing";
import { RepRfcAjenoError, analizarComplementoPago, proporcionCentavos } from "../src/cfdi/rep.ts";
import type { FacturaLigable } from "../src/cfdi/rep.ts";

const EMISOR = "EKU9003173C9";
const RECEPTOR = "XAXX010101000";
const U1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function docto(o: Partial<RepDocumentoRelacionado> = {}): RepDocumentoRelacionado {
  return {
    idDocumento: U1,
    serie: "A",
    folio: "10",
    monedaDR: "MXN",
    equivalenciaDR: "1",
    numParcialidad: 1,
    impSaldoAntCentavos: 116000,
    impPagadoCentavos: 58000,
    impSaldoInsolutoCentavos: 58000,
    objetoImpDR: "02",
    traslados: [{ impuesto: "002", tipoFactor: "Tasa", tasaOCuota: "0.160000", baseCentavos: 50000, importeCentavos: 8000 }],
    retenciones: [],
    ...o,
  };
}

function rep(doctos: RepDocumentoRelacionado[], extra: { fechaPago?: string; monto?: number } = {}): RepParseResult {
  return {
    folioFiscal: "cccccccc-3333-4333-8333-cccccccccccc",
    fecha: "2026-09-20T12:00:00",
    rfcEmisor: EMISOR,
    rfcReceptor: RECEPTOR,
    emisorNombre: null,
    pagos: [
      {
        fechaPago: extra.fechaPago ?? "2026-09-18T12:00:00",
        formaDePagoP: "03",
        monedaP: "MXN",
        montoCentavos: extra.monto ?? doctos.reduce((s, d) => s + d.impPagadoCentavos, 0),
        documentos: doctos,
      },
    ],
  };
}

const FACTURA: FacturaLigable = { folioFiscal: U1, rfcEmisor: EMISOR, rfcReceptor: RECEPTOR, totalCentavos: 116000, ivaCentavos: 16000, metodoPago: "PPD" };
const facturas = (...f: FacturaLigable[]) => new Map(f.map((x) => [x.folioFiscal, x]));

describe("proporcionCentavos", () => {
  it("half-up exacto con enteros", () => {
    expect(proporcionCentavos(16000, 58000, 116000)).toBe(8000);
    expect(proporcionCentavos(100, 1, 3)).toBe(33);
    expect(proporcionCentavos(100, 2, 3)).toBe(67);
    expect(proporcionCentavos(1, 1, 2)).toBe(1);
    expect(() => proporcionCentavos(1, 1, 0)).toThrow();
  });
});

describe("analizarComplementoPago", () => {
  it("emisor del REP = contribuyente: IVA TRASLADADO cobrado, por mes de pago, con la factura ligada", () => {
    const a = analizarComplementoPago(rep([docto()]), EMISOR, facturas(FACTURA));
    expect(a.flujo).toBe("trasladado");
    const d = a.documentos[0]!;
    expect(d).toMatchObject({ ligado: true, saldoCoherente: true, liquidaFactura: false, ivaCentavos: 8000, fuenteIva: "rep", periodoFlujo: "2026-09", saldoInsolutoCalculadoCentavos: 58000 });
    expect(d.hallazgos).toEqual([]);
    expect(d.facturaEsPpd).toBe(true);
    expect(a.totales).toEqual({ pagadoCentavos: 58000, ivaCentavos: 8000, ivaRetenidoCentavos: 0 });
    expect(a.porPeriodo).toEqual({ "2026-09": { pagadoCentavos: 58000, ivaCentavos: 8000 } });
    expect(a.documentosSinLigar).toBe(0);
  });

  it("receptor del REP = contribuyente: IVA ACREDITABLE; RFC ajeno lanza", () => {
    expect(analizarComplementoPago(rep([docto()]), RECEPTOR.toLowerCase(), facturas(FACTURA)).flujo).toBe("acreditable");
    expect(() => analizarComplementoPago(rep([docto()]), "AAA010101AAA", facturas(FACTURA))).toThrow(RepRfcAjenoError);
  });

  it("segunda parcialidad que liquida: saldo insoluto 0 y suma exacta del IVA (centavos, sin deriva)", () => {
    const segunda = docto({ numParcialidad: 2, impSaldoAntCentavos: 58000, impPagadoCentavos: 58000, impSaldoInsolutoCentavos: 0 });
    const a = analizarComplementoPago(rep([segunda]), EMISOR, facturas(FACTURA));
    expect(a.documentos[0]).toMatchObject({ liquidaFactura: true, saldoCoherente: true, ivaCentavos: 8000 });
  });

  it("detecta saldo incoherente y exceso de pago", () => {
    const mal = docto({ impSaldoInsolutoCentavos: 60000 });
    expect(analizarComplementoPago(rep([mal]), EMISOR, facturas(FACTURA)).documentos[0]!.hallazgos.join(" ")).toMatch(/ImpSaldoInsoluto no es/);
    const exceso = docto({ impPagadoCentavos: 120000, impSaldoInsolutoCentavos: -4000 });
    expect(analizarComplementoPago(rep([exceso]), EMISOR, facturas(FACTURA)).documentos[0]!.hallazgos.join(" ")).toMatch(/negativo/);
  });

  it("parcialidad 1 con saldo anterior distinto del total de la factura se señala", () => {
    const d = docto({ impSaldoAntCentavos: 100000, impSaldoInsolutoCentavos: 42000 });
    expect(analizarComplementoPago(rep([d]), EMISOR, facturas(FACTURA)).documentos[0]!.hallazgos.join(" ")).toMatch(/parcialidad 1/);
  });

  it("CFDI pagado ausente: no ligado, el IVA sale del REP y se avisa; con emisor distinto también no liga", () => {
    const a = analizarComplementoPago(rep([docto()]), EMISOR, new Map());
    expect(a.documentosSinLigar).toBe(1);
    expect(a.documentos[0]).toMatchObject({ ligado: false, ivaCentavos: 8000, fuenteIva: "rep" });
    const ajena = analizarComplementoPago(rep([docto()]), EMISOR, facturas({ ...FACTURA, rfcEmisor: "AAA010101AAA" }));
    expect(ajena.documentos[0]!.ligado).toBe(false);
    expect(ajena.documentos[0]!.hallazgos.join(" ")).toMatch(/emisor\/receptor distintos/);
  });

  it("sin ImpuestosDR en el REP: prorrateo de la factura ligada; sin factura ni REP: sin_dato y total parcial", () => {
    const sinImp = docto({ traslados: [], objetoImpDR: "03" });
    const a = analizarComplementoPago(rep([sinImp]), EMISOR, facturas(FACTURA));
    expect(a.documentos[0]).toMatchObject({ ivaCentavos: 8000, fuenteIva: "prorrateo_factura" });
    const b = analizarComplementoPago(rep([sinImp]), EMISOR, new Map());
    expect(b.documentos[0]).toMatchObject({ ivaCentavos: null, fuenteIva: "sin_dato" });
    expect(b.advertencias.join(" ")).toMatch(/sin IVA calculable/);
  });

  it("ObjetoImpDR 01 (no objeto): IVA 0 por el REP", () => {
    const a = analizarComplementoPago(rep([docto({ objetoImpDR: "01", traslados: [] })]), EMISOR, facturas(FACTURA));
    expect(a.documentos[0]).toMatchObject({ ivaCentavos: 0, fuenteIva: "rep" });
  });

  it("IVA del REP que discrepa del proporcional de la factura se señala (más de 1 centavo)", () => {
    const raro = docto({ traslados: [{ impuesto: "002", tipoFactor: "Tasa", tasaOCuota: "0.160000", baseCentavos: 50000, importeCentavos: 9000 }] });
    expect(analizarComplementoPago(rep([raro]), EMISOR, facturas(FACTURA)).documentos[0]!.hallazgos.join(" ")).toMatch(/difiere del proporcional/);
    const casi = docto({ traslados: [{ impuesto: "002", tipoFactor: "Tasa", tasaOCuota: "0.160000", baseCentavos: 50000, importeCentavos: 8001 }] });
    expect(analizarComplementoPago(rep([casi]), EMISOR, facturas(FACTURA)).documentos[0]!.hallazgos).toEqual([]);
  });

  it("moneda extranjera: se reporta pero NO se suma ni se convierte", () => {
    const usd = docto({ monedaDR: "USD", equivalenciaDR: "17.5", idDocumento: U2 });
    const a = analizarComplementoPago(rep([docto(), usd]), EMISOR, facturas(FACTURA));
    expect(a.documentos[1]).toMatchObject({ incluidoEnTotales: false });
    expect(a.documentos[1]!.hallazgos.join(" ")).toMatch(/USD/);
    expect(a.totales.pagadoCentavos).toBe(58000);
    expect(a.totales.ivaCentavos).toBe(8000);
  });

  it("IVA retenido (retenciones DR) se acumula por separado", () => {
    const conRet = docto({ retenciones: [{ impuesto: "002", tipoFactor: "Tasa", tasaOCuota: "0.106667", baseCentavos: 50000, importeCentavos: 5333 }] });
    expect(analizarComplementoPago(rep([conRet]), EMISOR, facturas(FACTURA)).totales.ivaRetenidoCentavos).toBe(5333);
  });

  it("Monto del pago que no cuadra con la suma de ImpPagado se advierte", () => {
    const a = analizarComplementoPago(rep([docto()], { monto: 60000 }), EMISOR, facturas(FACTURA));
    expect(a.advertencias.join(" ")).toMatch(/no coincide con la suma/);
  });

  it("el IVA se asigna al MES DEL PAGO, no al de la factura (flujo de efectivo)", () => {
    const a = analizarComplementoPago(rep([docto()], { fechaPago: "2026-11-02T10:00:00" }), EMISOR, facturas(FACTURA));
    expect(Object.keys(a.porPeriodo)).toEqual(["2026-11"]);
  });

  it("verifica que la factura ligada sea PPD: PPD ok, PUE se señala, método desconocido no se asume", () => {
    expect(analizarComplementoPago(rep([docto()]), EMISOR, facturas(FACTURA)).documentos[0]).toMatchObject({ facturaEsPpd: true, hallazgos: [] });
    const pue = analizarComplementoPago(rep([docto()]), EMISOR, facturas({ ...FACTURA, metodoPago: "PUE" })).documentos[0]!;
    expect(pue.facturaEsPpd).toBe(false);
    expect(pue.hallazgos.join(" ")).toMatch(/PUE no debería/);
    const nulo = analizarComplementoPago(rep([docto()]), EMISOR, facturas({ ...FACTURA, metodoPago: null })).documentos[0]!;
    expect(nulo.facturaEsPpd).toBeNull();
    expect(nulo.hallazgos.join(" ")).toMatch(/No se pudo verificar/);
  });
});
