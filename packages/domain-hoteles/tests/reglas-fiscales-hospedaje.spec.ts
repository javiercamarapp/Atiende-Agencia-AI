// Fase 5 (H5/REQ-BO-001/002) — pruebas unitarias del motor de reglas fiscales de
// CFDI de hospedaje: RFC genérico extranjero/global, propina excluida, DSA,
// desglose ISH residual, CfdiRelacionados tipo 07 (anticipo) y validación
// compuesta sobre las piezas reales de @atiende/billing (RFC/catálogos SAT).
import { describe, expect, it } from "vitest";
import {
  RFC_GENERICO_EXTRANJERO,
  RFC_PUBLICO_GENERAL,
  ReceptorHospedajeInvalidoError,
  computeCfdiHospedajeBreakdown,
  computeDsa,
  resolveReceptorHospedaje,
  summarizeFacturableCharges,
  validarCfdiHospedaje,
  validateAnticipoRelacion,
} from "../src/cfdi/reglas-fiscales-hospedaje.ts";

describe("resolveReceptorHospedaje", () => {
  it("esExtranjero -> RFC genérico extranjero + UsoCfdi S01", () => {
    expect(resolveReceptorHospedaje({ esExtranjero: true, esGlobal: false })).toEqual({ rfcReceptor: RFC_GENERICO_EXTRANJERO, usoCfdi: "S01" });
  });

  it("esGlobal -> RFC público en general + UsoCfdi S01", () => {
    expect(resolveReceptorHospedaje({ esExtranjero: false, esGlobal: true })).toEqual({ rfcReceptor: RFC_PUBLICO_GENERAL, usoCfdi: "S01" });
  });

  it("caso normal: exige rfcReceptor/usoCfdi explícitos", () => {
    expect(resolveReceptorHospedaje({ esExtranjero: false, esGlobal: false, rfcReceptor: "XAXX010101000", usoCfdi: "G03" })).toEqual({ rfcReceptor: "XAXX010101000", usoCfdi: "G03" });
    expect(() => resolveReceptorHospedaje({ esExtranjero: false, esGlobal: false })).toThrow(ReceptorHospedajeInvalidoError);
  });

  it("esExtranjero y esGlobal a la vez es inválido", () => {
    expect(() => resolveReceptorHospedaje({ esExtranjero: true, esGlobal: true })).toThrow(ReceptorHospedajeInvalidoError);
  });
});

describe("summarizeFacturableCharges", () => {
  it("EXCLUYE SIEMPRE la propina del subtotal facturable", () => {
    const resumen = summarizeFacturableCharges([
      { concept: "hospedaje", amount: 1000, taxAmount: 190, stayDate: "2026-12-01", reversesChargeId: null },
      { concept: "propina", amount: 150, taxAmount: 0, stayDate: null, reversesChargeId: null },
    ]);
    expect(resumen.subtotalBase).toBe(1000);
    expect(resumen.taxTotal).toBe(190);
  });

  it("cuenta solo noches de hospedaje REALES (excluye reversos y cargos sin stayDate)", () => {
    const resumen = summarizeFacturableCharges([
      { concept: "hospedaje", amount: 1000, taxAmount: 190, stayDate: "2026-12-01", reversesChargeId: null },
      { concept: "hospedaje", amount: 1000, taxAmount: 190, stayDate: "2026-12-02", reversesChargeId: null },
      { concept: "reverso", amount: -1000, taxAmount: -190, stayDate: null, reversesChargeId: "c1" },
      { concept: "ab", amount: 200, taxAmount: 32, stayDate: null, reversesChargeId: null },
    ]);
    expect(resumen.hospedajeNights).toBe(2);
    expect(resumen.subtotalBase).toBe(1000 + 1000 - 1000 + 200);
  });
});

describe("computeDsa", () => {
  it("es monto fijo por cuarto-noche, no porcentual", () => {
    expect(computeDsa(3, 20)).toBe(60);
    expect(computeDsa(0, 20)).toBe(0);
  });

  it("rechaza noches no enteras o negativas, y tasa negativa", () => {
    expect(() => computeDsa(1.5, 20)).toThrow(RangeError);
    expect(() => computeDsa(-1, 20)).toThrow(RangeError);
    expect(() => computeDsa(1, -1)).toThrow(RangeError);
  });
});

describe("computeCfdiHospedajeBreakdown", () => {
  it("ISH es el RESIDUO de taxTotal - ivaAmount, nunca recalculado desde cero sobre el subtotal agregado", () => {
    // 2 noches de hospedaje ($1000 c/u, IVA 16% + ISH 3% ya incluidos en tax_amount)
    // + A&B $200 (solo IVA, sin ISH).
    const resumen = { subtotalBase: 2200, taxTotal: 2 * (160 + 30) + 32, hospedajeNights: 2 };
    const breakdown = computeCfdiHospedajeBreakdown({ resumen, ivaRate: 0.16, dsaPerNight: 20 });
    expect(breakdown.ivaAmount).toBe(352); // 16% de 2200
    expect(breakdown.ishAmount).toBe(60); // taxTotal(412) - ivaAmount(352)
    expect(breakdown.dsaMonto).toBe(40); // 2 noches * 20
    expect(breakdown.total).toBe(2200 + 352 + 60 + 40);
  });

  it("ISH nunca es negativo (max(0, ...))", () => {
    const resumen = { subtotalBase: 1000, taxTotal: 100, hospedajeNights: 0 };
    // ivaAmount = 160 > taxTotal(100) -- un caso "raro" donde no debería producirse
    // un ISH negativo por construcción del cálculo.
    const breakdown = computeCfdiHospedajeBreakdown({ resumen, ivaRate: 0.16, dsaPerNight: 0 });
    expect(breakdown.ishAmount).toBe(0);
  });
});

describe("validateAnticipoRelacion", () => {
  it("null si no es aplicación de anticipo", () => {
    expect(validateAnticipoRelacion({ esAplicacionAnticipo: false })).toBeNull();
  });

  it("exige CfdiRelacionados no vacío", () => {
    const issue = validateAnticipoRelacion({ esAplicacionAnticipo: true, cfdiRelacionados: [] });
    expect(issue?.codigo).toBe("anticipo_sin_relacion");
  });

  it("exige TipoRelacion='07'", () => {
    const issue = validateAnticipoRelacion({ esAplicacionAnticipo: true, cfdiRelacionados: ["uuid-anticipo"], tipoRelacion: "01" });
    expect(issue?.codigo).toBe("tipo_relacion_invalido");
  });

  it("null cuando la relación es válida", () => {
    expect(validateAnticipoRelacion({ esAplicacionAnticipo: true, cfdiRelacionados: ["uuid-anticipo"], tipoRelacion: "07" })).toBeNull();
  });
});

function datosBase(overrides: Partial<Parameters<typeof validarCfdiHospedaje>[0]> = {}) {
  return {
    rfcEmisor: "HTP850101AB1",
    rfcReceptor: "XAXX010101000",
    usoCfdi: "S01",
    metodoPago: "PUE" as const,
    regimenFiscalEmisor: "601",
    subtotal: 1000,
    iva: 160,
    ishMonto: 30,
    dsaMonto: 20,
    descuento: 0,
    total: 1210,
    esExtranjero: false,
    esGlobal: false,
    esNoShow: false,
    esAplicacionAnticipo: false,
    ...overrides,
  };
}

describe("validarCfdiHospedaje", () => {
  it("un CFDI bien formado con ISH+DSA pasa todas las reglas", () => {
    const resultado = validarCfdiHospedaje(datosBase());
    expect(resultado.ok).toBe(true);
    expect(resultado.issues).toHaveLength(0);
  });

  it("total incoherente (no suma subtotal+iva+ish+dsa-descuento) se marca", () => {
    const resultado = validarCfdiHospedaje(datosBase({ total: 999 }));
    expect(resultado.ok).toBe(false);
    expect(resultado.issues.some((i) => i.codigo === "total_incoherente")).toBe(true);
  });

  it("RFC emisor/receptor mal formados se marcan (reutiliza @atiende/billing::esRfcValido)", () => {
    const resultado = validarCfdiHospedaje(datosBase({ rfcEmisor: "MAL", rfcReceptor: "XAXX010101000" }));
    expect(resultado.issues.some((i) => i.codigo === "rfc_emisor_invalido")).toBe(true);
  });

  it("catálogos SAT inválidos se marcan (reutiliza @atiende/billing::cfdiCatalogs)", () => {
    const resultado = validarCfdiHospedaje(datosBase({ usoCfdi: "NO_EXISTE" }));
    expect(resultado.issues.some((i) => i.codigo === "uso_cfdi_invalido")).toBe(true);
  });

  it("esExtranjero con un RFC receptor distinto del genérico se marca", () => {
    const resultado = validarCfdiHospedaje(datosBase({ esExtranjero: true, rfcReceptor: "XAXX010101000" }));
    expect(resultado.issues.some((i) => i.codigo === "rfc_extranjero_incorrecto")).toBe(true);
  });

  it("esExtranjero con el RFC genérico correcto pasa", () => {
    const resultado = validarCfdiHospedaje(datosBase({ esExtranjero: true, rfcReceptor: RFC_GENERICO_EXTRANJERO }));
    expect(resultado.issues.some((i) => i.codigo === "rfc_extranjero_incorrecto")).toBe(false);
  });

  it("esAplicacionAnticipo sin CfdiRelacionados tipo 07 se marca", () => {
    const resultado = validarCfdiHospedaje(datosBase({ esAplicacionAnticipo: true }));
    expect(resultado.issues.some((i) => i.codigo === "anticipo_sin_relacion")).toBe(true);
  });

  it("esAplicacionAnticipo con CfdiRelacionados tipo 07 correcto pasa", () => {
    const resultado = validarCfdiHospedaje(datosBase({ esAplicacionAnticipo: true, cfdiRelacionados: ["11111111-1111-1111-1111-111111111111"], tipoRelacion: "07" }));
    expect(resultado.issues.some((i) => i.codigo === "anticipo_sin_relacion" || i.codigo === "tipo_relacion_invalido")).toBe(false);
  });

  it("esNoShow agrega un warning, nunca un issue bloqueante", () => {
    const resultado = validarCfdiHospedaje(datosBase({ esNoShow: true }));
    expect(resultado.ok).toBe(true);
    expect(resultado.warnings.some((w) => w.includes("no-show"))).toBe(true);
  });
});
