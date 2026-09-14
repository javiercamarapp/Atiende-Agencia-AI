// Golden-set numérico (Fase 6 despachos, OBLIGATORIO) — compara byte a byte el
// output del motor Python REAL (`b2b_ai/features/bookkeeping/`, capturado en
// tests/fixtures/golden-bookkeeping-output.json vía
// tests/fixtures/golden_gen_bookkeeping.py, corrido contra
// `despachos/.venv/bin/python3`) contra el motor TS nuevo
// (`src/bookkeeping/*`). El nivel ML (TF-IDF + GradientBoosting) NO se porta
// (ver clasificador.ts) — este golden-set cubre el mapeo de cuentas, la
// generación/validación de pólizas, el fallback determinista de reglas, y la
// agregación de overrides humanos: el 100% de la lógica determinista y
// verificable byte-exacto del módulo.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-bookkeeping-output.json" with { type: "json" };
import { getMapping, generatePoliza, validatePoliza, generateAdjustment, generateDepreciationEntry } from "../src/bookkeeping/rules-engine.ts";
import { clasificarPorReglas } from "../src/bookkeeping/clasificador.ts";
import { getRfcCategoryFeedback, getSuggestionsForRetraining } from "../src/bookkeeping/overrides.ts";
import type { CfdiClassification, OverrideRecord } from "../src/bookkeeping/types.ts";

function toSnake(poliza: ReturnType<typeof generatePoliza>) {
  if (!poliza) return null;
  return {
    tipo: poliza.tipo,
    total_debe: poliza.totalDebe,
    total_haber: poliza.totalHaber,
    cuadrada: poliza.cuadrada,
    lineas: poliza.lineas.map((l) => ({ cuenta: l.cuenta, concepto: l.concepto, debe: l.debe, haber: l.haber, tipo: l.tipo })),
  };
}

describe("golden: getMapping", () => {
  it("servicios_profesionales", () => {
    const m = getMapping("I", "servicios_profesionales");
    expect(m).toEqual({ cargo: golden.get_mapping_servicios_profesionales.cargo, abono: golden.get_mapping_servicios_profesionales.abono, ivaCargo: golden.get_mapping_servicios_profesionales.iva_cargo, ivaAbono: golden.get_mapping_servicios_profesionales.iva_abono, polizaType: golden.get_mapping_servicios_profesionales.poliza_type });
  });
  it("venta_servicios", () => {
    const m = getMapping("E", "venta_servicios");
    expect(m).toEqual({ cargo: golden.get_mapping_venta_servicios.cargo, abono: golden.get_mapping_venta_servicios.abono, ivaCargo: golden.get_mapping_venta_servicios.iva_cargo, ivaAbono: golden.get_mapping_venta_servicios.iva_abono, polizaType: golden.get_mapping_venta_servicios.poliza_type });
  });
  it("categoría desconocida -> null", () => {
    expect(getMapping("I", "categoria_inexistente")).toBeNull();
  });
});

describe("golden: generatePoliza", () => {
  it("servicios_profesionales — 4 líneas con IVA acreditable", () => {
    const c: CfdiClassification = { cfdiUuid: "u1", rfcEmisor: "", rfcReceptor: "", descripcion: "Honorarios enero", subtotal: 10000, iva: 1600, total: 11600, tasaIva: 0.16, tipoCfdi: "I", categoria: "servicios_profesionales", confidence: 1, needsHumanReview: false };
    expect(toSnake(generatePoliza(c))).toEqual(golden.generate_poliza_servicios_profesionales);
  });
  it("sin IVA — 2 líneas", () => {
    const c: CfdiClassification = { cfdiUuid: "u2", rfcEmisor: "", rfcReceptor: "", descripcion: "Interes", subtotal: 5000, iva: 0, total: 5000, tasaIva: 0, tipoCfdi: "I", categoria: "intereses_bancarios", confidence: 1, needsHumanReview: false };
    expect(toSnake(generatePoliza(c))).toEqual(golden.generate_poliza_sin_iva);
  });
  it("venta_servicios — IVA abono (lado ventas)", () => {
    const c: CfdiClassification = { cfdiUuid: "u3", rfcEmisor: "", rfcReceptor: "", descripcion: "Proyecto X", subtotal: 20000, iva: 3200, total: 23200, tasaIva: 0.16, tipoCfdi: "E", categoria: "venta_servicios", confidence: 1, needsHumanReview: false };
    expect(toSnake(generatePoliza(c))).toEqual(golden.generate_poliza_venta_servicios);
  });
  it("sin mapeo -> null", () => {
    const c: CfdiClassification = { cfdiUuid: "u4", rfcEmisor: "", rfcReceptor: "", descripcion: "x", subtotal: 100, iva: 16, total: 116, tasaIva: 0.16, tipoCfdi: "I", categoria: "categoria_sin_mapeo", confidence: 1, needsHumanReview: false };
    expect(generatePoliza(c)).toBeNull();
  });
});

describe("golden: validatePoliza", () => {
  it("póliza balanceada -> sin errores", () => {
    const c: CfdiClassification = { cfdiUuid: "u1", rfcEmisor: "", rfcReceptor: "", descripcion: "Honorarios enero", subtotal: 10000, iva: 1600, total: 11600, tasaIva: 0.16, tipoCfdi: "I", categoria: "servicios_profesionales", confidence: 1, needsHumanReview: false };
    const poliza = { ...generatePoliza(c)!, fecha: "2026-01-31" };
    expect(validatePoliza(poliza)).toEqual(golden.validate_poliza_balanceada);
  });
  it("póliza desbalanceada", () => {
    const poliza = { tipo: "diario" as const, fecha: "2026-01-31", concepto: "test", referencia: "", lineas: [{ cuenta: "1020000", concepto: "", debe: 10000, haber: 0, tipo: "cargo" as const }, { cuenta: "2010000", concepto: "", debe: 0, haber: 8000, tipo: "abono" as const }], totalDebe: 10000, totalHaber: 8000, cuadrada: false, tenantId: "" };
    expect(validatePoliza(poliza)).toEqual(golden.validate_poliza_desbalanceada);
  });
  it("cuentas inexistentes en catálogo SAT", () => {
    const poliza = { tipo: "diario" as const, fecha: "2026-01-31", concepto: "test", referencia: "", lineas: [{ cuenta: "9999999", concepto: "", debe: 100, haber: 0, tipo: "cargo" as const }, { cuenta: "9999998", concepto: "", debe: 0, haber: 100, tipo: "abono" as const }], totalDebe: 100, totalHaber: 100, cuadrada: true, tenantId: "" };
    expect(validatePoliza(poliza)).toEqual(golden.validate_poliza_cuenta_inexistente);
  });
});

describe("golden: generateAdjustment / generateDepreciationEntry", () => {
  it("ajuste manual", () => {
    const poliza = generateAdjustment("2026-01-31", "Ajuste manual", [
      { cuenta: "6020300", debe: 5000, haber: 0, concepto: "gasto" },
      { cuenta: "1020000", debe: 0, haber: 5000, concepto: "banco" },
    ]);
    expect(toSnake(poliza)).toEqual(golden.generate_adjustment);
  });
  it("depreciación mensual (convención 1540100)", () => {
    const poliza = generateDepreciationEntry("2026-01-31", [{ cuentaActivo: "1540000", cuentaDepreciacion: "1540100", cuentaGasto: "6020300", monto: 833.33 }]);
    expect(toSnake(poliza)).toEqual(golden.generate_depreciation_entry);
  });
});

describe("golden: clasificarPorReglas (fallback determinista, sin ML)", () => {
  it.each([
    ["servicios_profesionales_claro", "honorarios de consultoría profesional", "I"],
    ["renta_oficina", "renta de oficina mensual, alquiler local comercial", "I"],
    ["sin_match", "xyz sin ninguna palabra clave reconocible", "I"],
    ["venta_servicios_egreso", "servicio de consultoría y desarrollo de proyecto", "E"],
    ["empate_primer_patron_gana", "renta arrendamiento", "I"],
  ] as const)("%s", (nombre, descripcion, tipo) => {
    const esperado = (golden as unknown as Record<string, { categoria: string; confidence: number }>)[`rule_based_predict_${nombre}`];
    if (!esperado) throw new Error(`Falta el caso golden rule_based_predict_${nombre}`);
    const resultado = clasificarPorReglas(descripcion, tipo);
    expect(resultado.categoria).toBe(esperado.categoria);
    expect(resultado.confidence).toBeCloseTo(esperado.confidence, 10);
  });
});

describe("golden: overrides humanos por RFC", () => {
  it("mayoría simple (2 nomina, 1 publicidad -> nomina)", () => {
    const overrides: OverrideRecord[] = [
      { cfdiUuid: "a1", rfcEmisor: "RFC_A", newCategoria: "nomina", tenantId: "" },
      { cfdiUuid: "a2", rfcEmisor: "RFC_A", newCategoria: "nomina", tenantId: "" },
      { cfdiUuid: "a3", rfcEmisor: "RFC_A", newCategoria: "publicidad", tenantId: "" },
    ];
    expect(getRfcCategoryFeedback(overrides, "RFC_A")).toBe(golden.rfc_category_feedback_mayoria);
  });

  it("señal fuerte (5/5 nomina) -> sugiere retraining", () => {
    const overrides: OverrideRecord[] = Array.from({ length: 5 }, (_, i) => ({ cfdiUuid: `b${i}`, rfcEmisor: "RFC_STRONG", newCategoria: "nomina", tenantId: "" }));
    const sugerencias = getSuggestionsForRetraining(overrides);
    expect(sugerencias.map((s) => ({ rfc: s.rfc, suggested_categoria: s.suggestedCategoria, override_count: s.overrideCount, total_corrections: s.totalCorrections, confidence: s.confidence }))).toEqual(golden.suggestions_for_retraining);
  });

  it("empate 50/50 -> NO sugiere (regla es > 0.5, no >=)", () => {
    const overrides: OverrideRecord[] = [
      { cfdiUuid: "c1", rfcEmisor: "RFC_WEAK", newCategoria: "nomina", tenantId: "" },
      { cfdiUuid: "c2", rfcEmisor: "RFC_WEAK", newCategoria: "publicidad", tenantId: "" },
    ];
    expect(getSuggestionsForRetraining(overrides)).toEqual(golden.suggestions_for_retraining_empate_no_sugiere);
  });
});
