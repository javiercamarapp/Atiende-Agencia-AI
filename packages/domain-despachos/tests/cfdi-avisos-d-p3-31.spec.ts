// D-P3-31: validaciones faltantes de CFDI y REP. Todas son AVISOS (warnings), nunca errores: ver avisos-cfdi.ts para el porque.
import { describe, expect, it } from "vitest";
import { validarCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";
import type { DatosCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";
import { avisosCfdi } from "../src/cfdi/avisos-cfdi.ts";
import { avisosPagoRep } from "../src/cfdi/rep.ts";
import type { RepPago } from "@atiende/billing";

function datos(o: Partial<DatosCfdiDespachos> = {}): DatosCfdiDespachos {
  return {
    tipo: "I", subtotal: 1000, total: 1160, descuento: 0, iva: 160,
    conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }],
    usoCfdi: "G03", formaPago: "03", metodoPago: "PUE", regimenFiscalEmisor: "601",
    rfcEmisor: "CON950820K12", rfcReceptor: "CLI010101CL1", tieneSello: true, noCertificado: "00001000000504465028",
    folioFiscal: "11111111-2222-3333-4444-555555555555", fecha: "2026-07-01T10:00:00", fechaTimbrado: "2026-07-01T10:05:00",
    ...o,
  };
}

describe("IVA por concepto (aviso)", () => {
  const trasl = (base: number, tasa: number, importe: number) => [{ impuesto: "002", tipoFactor: "Tasa", tasaOCuota: tasa, base, importe }];
  it("un concepto con Importe != Base x Tasa avisa, y el CFDI sigue valido", () => {
    const r = validarCfdiDespachos(datos({ conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000, traslados: trasl(1000, 0.16, 150) }] }));
    expect(r.warnings.some((w) => w.startsWith("Concepto 1: IVA 150.00"))).toBe(true);
    expect(r.ok).toBe(true);
  });
  it("un concepto coherente no avisa", () => {
    const r = validarCfdiDespachos(datos({ conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000, traslados: trasl(1000, 0.16, 160) }] }));
    expect(r.warnings.filter((w) => w.includes("Concepto 1") || w.includes("suma del IVA"))).toEqual([]);
  });
  it("la suma por concepto distinta del IVA del comprobante avisa", () => {
    const w = avisosCfdi({ ...datos({ iva: 160 }), conceptos: [{ cantidad: 1, valorUnitario: 500, importe: 500, traslados: trasl(500, 0.16, 80) }] });
    expect(w.some((x) => x.includes("suma del IVA por concepto (80.00)"))).toBe(true);
  });
  it("sin traslados por concepto (JSON o XML sin desglose) no se valida nada", () => {
    expect(avisosCfdi(datos())).toEqual([]);
  });
});

describe("MetodoPago vs FormaPago (aviso)", () => {
  it("PPD con FormaPago distinta de 99 avisa; PPD con 99 no", () => {
    expect(avisosCfdi(datos({ metodoPago: "PPD", formaPago: "03" })).some((w) => w.includes("PPD exige FormaPago 99"))).toBe(true);
    expect(avisosCfdi(datos({ metodoPago: "PPD", formaPago: "99" }))).toEqual([]);
  });
  it("PUE con 99 avisa en ingreso, pero no en nomina (donde 99 es lo normal)", () => {
    expect(avisosCfdi(datos({ metodoPago: "PUE", formaPago: "99" })).some((w) => w.includes("PUE no admite FormaPago 99"))).toBe(true);
    expect(avisosCfdi(datos({ tipo: "N", metodoPago: "PUE", formaPago: "99" }))).toEqual([]);
  });
  it("nunca es un error: el CFDI sigue ok", () => {
    expect(validarCfdiDespachos(datos({ metodoPago: "PUE", formaPago: "99" })).ok).toBe(true);
  });
});

describe("UsoCFDI vs RegimenFiscalReceptor (aviso)", () => {
  it("G03 con receptor 605 (sueldos) avisa; con 601 no", () => {
    expect(avisosCfdi(datos({ usoCfdi: "G03", regimenFiscalReceptor: "605" })).some((w) => w.includes("no es compatible con el regimen fiscal del receptor 605"))).toBe(true);
    expect(avisosCfdi(datos({ usoCfdi: "G03", regimenFiscalReceptor: "601" }))).toEqual([]);
  });
  it("CN01 (nomina) solo con 605; D10 con 605 es compatible", () => {
    expect(avisosCfdi(datos({ usoCfdi: "CN01", regimenFiscalReceptor: "601" })).length).toBe(1);
    expect(avisosCfdi(datos({ usoCfdi: "D10", regimenFiscalReceptor: "605" }))).toEqual([]);
  });
  it("sin regimen del receptor (JSON antiguo) no se valida", () => {
    expect(avisosCfdi(datos({ usoCfdi: "G03" }))).toEqual([]);
  });
});

describe("retencion de ISR 1.25 % RESICO PF (sin aviso falso)", () => {
  const conRet = (regimen: string, ret: number) => datos({ regimenFiscalEmisor: regimen, subtotal: 1000, iva: 160, retencionIsr: ret, total: 1160 - ret });
  it("emisor 626 con retencion 12.50 (1.25 %): sin aviso de retencion", () => {
    expect(validarCfdiDespachos(conRet("626", 12.5)).warnings.some((w) => w.startsWith("Retención ISR"))).toBe(false);
  });
  it("emisor 626 con 100.00 (la del 10 %): avisa contra el 1.25 %", () => {
    const w = validarCfdiDespachos(conRet("626", 100)).warnings.find((x) => x.startsWith("Retención ISR"));
    expect(w).toContain("1.25% de RESICO");
  });
  it("emisor 612 (honorarios) sigue comparando contra el 10 %, igual que antes", () => {
    expect(validarCfdiDespachos(conRet("612", 100)).warnings.some((w) => w.startsWith("Retención ISR"))).toBe(false);
    expect(validarCfdiDespachos(conRet("612", 12.5)).warnings.find((w) => w.startsWith("Retención ISR"))).toContain("10% referencial");
  });
});

describe("REP: avisos de FormaDePagoP / MonedaP / TipoCambioP / TipoCadPago", () => {
  const pago = (o: Partial<RepPago> = {}): RepPago => ({ fechaPago: "2026-09-18T12:00:00", formaDePagoP: "03", monedaP: "MXN", montoCentavos: 100, documentos: [], ...o });
  it("un pago sano en MXN no avisa", () => {
    expect(avisosPagoRep(pago(), 0)).toEqual([]);
  });
  it("FormaDePagoP fuera de catalogo o 99 avisa", () => {
    expect(avisosPagoRep(pago({ formaDePagoP: "77" }), 0)[0]).toContain("no esta en el catalogo c_FormaPago");
    expect(avisosPagoRep(pago({ formaDePagoP: "99" }), 0)[0]).toContain("no es valida en un complemento de pago");
  });
  it("MonedaP que no es ISO avisa", () => {
    expect(avisosPagoRep(pago({ monedaP: "peso" }), 0).some((w) => w.includes("ISO 4217"))).toBe(true);
  });
  it("moneda extranjera sin TipoCambioP avisa; con TipoCambioP positivo no", () => {
    expect(avisosPagoRep(pago({ monedaP: "USD" }), 0)[0]).toContain("TipoCambioP es obligatorio");
    expect(avisosPagoRep(pago({ monedaP: "USD", tipoCambioP: "17.2500" }), 0)).toEqual([]);
    expect(avisosPagoRep(pago({ monedaP: "USD", tipoCambioP: "0" }), 0)[0]).toContain("mayor que cero");
  });
  it("MXN con TipoCambioP distinto de 1 avisa", () => {
    expect(avisosPagoRep(pago({ tipoCambioP: "2" }), 0)[0]).toContain("debe ser 1");
  });
  it("TipoCadPago 01 (SPEI) es valido; otro valor avisa", () => {
    expect(avisosPagoRep(pago({ tipoCadPago: "01" }), 0)).toEqual([]);
    expect(avisosPagoRep(pago({ tipoCadPago: "02" }), 0)[0]).toContain("c_TipoCadenaPago");
  });
});
