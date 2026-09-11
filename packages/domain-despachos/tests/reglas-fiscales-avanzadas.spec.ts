import { describe, expect, it } from "vitest";
import { validarCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";
import type { DatosCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";

function baseDatos(overrides: Partial<DatosCfdiDespachos> = {}): DatosCfdiDespachos {
  return {
    tipo: "T",
    subtotal: 1000,
    total: 1160,
    descuento: 0,
    iva: 160,
    conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }],
    usoCfdi: "G03",
    formaPago: "03",
    metodoPago: "PUE",
    regimenFiscalEmisor: "601",
    rfcEmisor: "CON950820K12",
    rfcReceptor: "XAXX010101000",
    tieneSello: true,
    noCertificado: "00001000000504465028",
    folioFiscal: "11111111-2222-3333-4444-555555555555",
    ...overrides,
  };
}

describe("validarCfdiDespachos — comportamiento fuera del golden-set", () => {
  it("un traslado (tipo T) limpio, sin DIOT/nómina, NO exige revisión humana", () => {
    const result = validarCfdiDespachos(baseDatos());
    expect(result.ok).toBe(true);
    expect(result.diot.reportable).toBe(false);
    expect(result.requiresHumanReview).toBe(false);
  });

  it("cualquier CFDI de tipo P (pago) siempre exige revisión humana, incluso sin issues", () => {
    const result = validarCfdiDespachos(baseDatos({ tipo: "P", subtotal: 0, total: 0, iva: 0, conceptos: [] }));
    expect(result.requiresHumanReview).toBe(true);
  });

  it("un ingreso (tipo I) con subtotal > 0 siempre es reportable en DIOT y exige revisión humana", () => {
    const result = validarCfdiDespachos(baseDatos({ tipo: "I" }));
    expect(result.diot.reportable).toBe(true);
    expect(result.requiresHumanReview).toBe(true);
  });

  it("un RFC de emisor inválido sigue siendo detectado (reutiliza la regla base de billing sin duplicarla)", () => {
    const result = validarCfdiDespachos(baseDatos({ rfcEmisor: "NO-VALIDO" }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.codigo === "rfc_emisor_invalido")).toBe(true);
  });

  it("sin campos de fecha, no revienta y no agrega hallazgos de fecha", () => {
    const result = validarCfdiDespachos(baseDatos());
    expect(result.issues.some((i) => i.codigo.startsWith("fecha"))).toBe(false);
  });
});
