// D-22 -- dirección emitido/recibido, centavos enteros exactos y desglose de impuestos (funciones puras).
import { describe, expect, it } from "vitest";
import { aCentavos, clasificarDireccionCfdi, impuestosDesdeXml, MontoInvalidoError, montosCfdiACentavos, normalizarCamposPagoCfdi } from "../src/cfdi/modelo-cfdi.ts";

describe("clasificarDireccionCfdi", () => {
  const CLIENTE = "CLI010101CL1";
  it("emisor = cliente -> emitido; receptor = cliente -> recibido", () => {
    expect(clasificarDireccionCfdi(CLIENTE, CLIENTE, "PUB010101PB1")).toBe("emitido");
    expect(clasificarDireccionCfdi(CLIENTE, "PRO010101PR1", CLIENTE)).toBe("recibido");
  });
  it("compara sin importar mayúsculas ni espacios", () => {
    expect(clasificarDireccionCfdi(" cli010101cl1 ", "CLI010101CL1", "X")).toBe("emitido");
  });
  it("un comprobante del cliente consigo mismo (nómina propia) cuenta como emitido", () => {
    expect(clasificarDireccionCfdi(CLIENTE, CLIENTE, CLIENTE)).toBe("emitido");
  });
  it("sin ficha (RFC desconocido) o sin relación con el cliente -> indeterminado, nunca se adivina", () => {
    expect(clasificarDireccionCfdi(null, CLIENTE, "X")).toBe("indeterminado");
    expect(clasificarDireccionCfdi("", CLIENTE, "X")).toBe("indeterminado");
    expect(clasificarDireccionCfdi(CLIENTE, "AAA010101AA1", "BBB010101BB1")).toBe("indeterminado");
  });
});

describe("aCentavos", () => {
  it("convierte pesos a centavos enteros sin error binario", () => {
    expect(aCentavos(1234.56)).toBe(123456);
    expect(aCentavos(1.005)).toBe(101); // 1.005 * 100 = 100.49999999999999 en binario: mitad hacia arriba
    expect(aCentavos(0.1 + 0.2)).toBe(30);
    expect(aCentavos(19.99)).toBe(1999);
    expect(aCentavos(0)).toBe(0);
    expect(aCentavos(-0)).toBe(0);
  });
  it("redondea mitad hacia arriba y conserva el signo", () => {
    expect(aCentavos(-12.345)).toBe(-1235);
    expect(aCentavos(2.675)).toBe(268);
  });
  it("cadenas decimales EXACTAS (sin flotantes), hasta 6 decimales", () => {
    expect(aCentavos("160.000000")).toBe(16000);
    expect(aCentavos("0.048000")).toBe(5);
    expect(aCentavos("0.004999")).toBe(0);
    expect(aCentavos("0.005")).toBe(1);
    expect(aCentavos("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => aCentavos("90071992547409.92")).toThrow(MontoInvalidoError);
  });
  it("null/undefined -> null (desconocido, jamás 0)", () => {
    expect(aCentavos(null)).toBeNull();
    expect(aCentavos(undefined)).toBeNull();
  });
  it("rechaza NaN, Infinity, ruido y montos fuera del rango entero seguro", () => {
    expect(() => aCentavos(Number.NaN)).toThrow(MontoInvalidoError);
    expect(() => aCentavos(Number.POSITIVE_INFINITY)).toThrow(MontoInvalidoError);
    expect(() => aCentavos("12,5")).toThrow(MontoInvalidoError);
    expect(() => aCentavos("1e3")).toThrow(MontoInvalidoError);
    expect(() => aCentavos("abc")).toThrow(MontoInvalidoError);
    expect(() => aCentavos(1e17)).toThrow(MontoInvalidoError);
    expect(() => aCentavos("9999999999999999")).toThrow(MontoInvalidoError);
  });
});

describe("montosCfdiACentavos", () => {
  it("separa lo conocido de lo desconocido: retenciones/IEPS ausentes quedan null, no 0", () => {
    expect(montosCfdiACentavos({ subtotal: 1000, total: 1160, iva: 160 })).toEqual({
      subtotalCentavos: 100000,
      descuentoCentavos: 0,
      totalCentavos: 116000,
      ivaTrasladadoCentavos: 16000,
      isrRetenidoCentavos: null,
      ivaRetenidoCentavos: null,
      iepsCentavos: null,
    });
  });
  it("incluye retenciones de honorarios", () => {
    expect(montosCfdiACentavos({ subtotal: 10000, descuento: 0.5, total: 10100.5, iva: 1600, retencionIsr: 1000, retencionIva: 1066.67, ieps: 0 })).toMatchObject({
      descuentoCentavos: 50,
      isrRetenidoCentavos: 100000,
      ivaRetenidoCentavos: 106667,
      iepsCentavos: 0,
    });
  });
});

describe("impuestosDesdeXml", () => {
  it("convierte base e importe (cadenas exactas) a centavos y conserva tasa/factor", () => {
    expect(
      impuestosDesdeXml([
        { naturaleza: "traslado", impuesto: "002", tipoFactor: "Tasa", tasaOCuota: "0.160000", base: "1000.000000", importe: "160.000000" },
        { naturaleza: "traslado", impuesto: "002", tipoFactor: "Exento", tasaOCuota: null, base: "5.000000", importe: null },
      ]),
    ).toEqual([
      { naturaleza: "traslado", impuesto: "002", tipoFactor: "Tasa", tasaOCuota: "0.160000", baseCentavos: 100000, importeCentavos: 16000 },
      { naturaleza: "traslado", impuesto: "002", tipoFactor: "Exento", tasaOCuota: null, baseCentavos: 500, importeCentavos: null },
    ]);
  });
});

describe("montosCfdiACentavos -- valores que la base no admite", () => {
  it("IVA/retenciones/IEPS/descuento negativos se guardan como desconocidos (null/0), no rompen el insert", () => {
    expect(montosCfdiACentavos({ subtotal: 100, total: 90, descuento: -5, iva: -16, retencionIsr: -1, retencionIva: -2, ieps: -3 })).toMatchObject({
      descuentoCentavos: 0,
      ivaTrasladadoCentavos: null,
      isrRetenidoCentavos: null,
      ivaRetenidoCentavos: null,
      iepsCentavos: null,
    });
  });
  it("un total negativo SI se conserva (la base no lo restringe)", () => {
    expect(montosCfdiACentavos({ subtotal: 0, total: -10 }).totalCentavos).toBe(-1000);
  });
});

describe("normalizarCamposPagoCfdi", () => {
  it("normaliza a mayúsculas y conserva lo válido", () => {
    expect(normalizarCamposPagoCfdi({ metodoPago: " ppd ", formaPago: "99", usoCfdi: "g03", moneda: "usd", tipoCambio: 17.5123456789 })).toEqual({ metodoPago: "PPD", formaPago: "99", usoCfdi: "G03", moneda: "USD", tipoCambio: 17.512346 });
  });
  it("lo que viola la forma de la base se guarda null (el CFDI se ingiere igual, con su hallazgo)", () => {
    expect(normalizarCamposPagoCfdi({ metodoPago: "XYZ", formaPago: "3", usoCfdi: "demasiado-largo", moneda: "PESOS", tipoCambio: 0 })).toEqual({ metodoPago: null, formaPago: null, usoCfdi: null, moneda: null, tipoCambio: null });
    expect(normalizarCamposPagoCfdi({ tipoCambio: 1e12 }).tipoCambio).toBeNull();
    expect(normalizarCamposPagoCfdi({ tipoCambio: Number.NaN }).tipoCambio).toBeNull();
    expect(normalizarCamposPagoCfdi({})).toEqual({ metodoPago: null, formaPago: null, usoCfdi: null, moneda: null, tipoCambio: null });
  });
});
