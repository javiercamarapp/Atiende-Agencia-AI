// Golden-set numérico (Fase 1 despachos §8, OBLIGATORIO) — compara, campo por campo,
// el output del motor Python REAL (`validate_cfdi`, capturado en
// tests/fixtures/golden-python-output.json vía tests/fixtures/golden_gen.py, corrido
// contra el intérprete real del repo `despachos`) contra el motor TS nuevo
// (`validarCfdiDespachos`) para los 6 checks base identificados en el diseño
// (retenciones, fechas >72h, IEPS, DIOT, nómina, notas de crédito) más 3 casos de
// esquina deliberados (retención con desviación de $0.01 dentro de tolerancia,
// retención fuera de tolerancia, timbrado exactamente en la frontera de
// truncamiento a días completos).
//
// NO es "¿pasan los tests?" — es "¿produce el mismo código de hallazgo, el mismo
// texto de warning, los mismos montos DIOT, el mismo booleano de revisión humana?".
// Si algún caso no coincidiera, el criterio (ver diseño §8) es corregir el TS, nunca
// ajustar el golden para que pase — a la fecha de este commit los 15 casos coinciden.
//
// Fuera de alcance de esta comparación: el warning "IVA global ... difiere de 16%"
// que emite packages/billing/src/cfdi/validator.ts (una de las 6 reglas BASE
// preexistentes, no una de las 6 avanzadas de esta fase) interpola el número
// esperado sin forzar 2 decimales (`${esperado}` da "160" en vez de "160.00" cuando
// el valor es entero) — es una discrepancia de FORMATO cosmético frente al Python
// (que usa Decimal, preserva 2 decimales), preexistente en billing y fuera de
// alcance de esta fase (no se modifica packages/billing — ver diseño §2). No afecta
// ninguno de los 6 checks avanzados que este archivo valida.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-python-output.json" with { type: "json" };
import { validarCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";
import type { DatosCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";

type GoldenCase = (typeof golden)[keyof typeof golden];

function baseDatos(overrides: Partial<DatosCfdiDespachos> = {}): DatosCfdiDespachos {
  return {
    tipo: "I",
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
    emisorNombre: "PROVEEDOR DE PRUEBA SA DE CV",
    rfcReceptor: "XAXX010101000",
    tieneSello: true,
    noCertificado: "00001000000504465028",
    folioFiscal: "11111111-2222-3333-4444-555555555555",
    fecha: "2026-07-01T10:00:00",
    fechaTimbrado: "2026-07-01T10:05:00",
    ...overrides,
  };
}

const CASES: Record<string, DatosCfdiDespachos> = {
  "01_base_ingreso_diot": baseDatos(),

  "02_retencion_isr_exacta_10pct": baseDatos({ subtotal: 1000, total: 890, iva: 0, retencionIsr: 100 }),

  "03_retencion_isr_desviacion_0_01": baseDatos({ subtotal: 1000, total: 899.99, iva: 0, retencionIsr: 100.01 }),

  "04_retencion_isr_desviacion_1_01_fuera_tolerancia": baseDatos({ subtotal: 1000, total: 898.99, iva: 0, retencionIsr: 101.01 }),

  "05_retencion_iva_exacta_2_3": baseDatos({ subtotal: 1000, total: 1053.35, iva: 160, retencionIva: 106.65 }),

  "06_timbrado_71h59m": baseDatos({ fecha: "2026-07-01T00:00:00", fechaTimbrado: "2026-07-03T23:59:00" }),

  "07_timbrado_72h01m_no_dispara_por_truncamiento_dias": baseDatos({ fecha: "2026-07-01T00:00:00", fechaTimbrado: "2026-07-04T00:01:00" }),

  "08_timbrado_96h01m_dispara_warning": baseDatos({ fecha: "2026-07-01T00:00:00", fechaTimbrado: "2026-07-05T00:01:00" }),

  "09_ieps_presente": baseDatos({ ieps: 50 }),

  "10_nomina_metodo_pago_no_pue": baseDatos({ metodoPago: "PPD", nomina: { totalPercepciones: 5000 } }),

  "11_nomina_sin_total_percepciones": baseDatos({ nomina: {} }),

  "12_nota_credito_sin_relacionados": baseDatos({
    tipo: "E",
    subtotal: 500,
    total: 0,
    iva: 80,
    descuento: 580,
    conceptos: [{ cantidad: 1, valorUnitario: 500, importe: 500 }],
  }),

  "13_nota_credito_tiporelacion_01": baseDatos({
    tipo: "E",
    subtotal: 500,
    total: 0,
    iva: 80,
    descuento: 580,
    conceptos: [{ cantidad: 1, valorUnitario: 500, importe: 500 }],
    cfdiRelacionados: ["11111111-2222-3333-4444-555555555556"],
    tipoRelacion: "01",
  }),

  "14_nota_credito_tiporelacion_04_otro_codigo": baseDatos({
    tipo: "E",
    subtotal: 500,
    total: 0,
    iva: 80,
    descuento: 580,
    conceptos: [{ cantidad: 1, valorUnitario: 500, importe: 500 }],
    cfdiRelacionados: ["11111111-2222-3333-4444-555555555556"],
    tipoRelacion: "04",
  }),

  "15_nota_credito_sin_tiporelacion": baseDatos({
    tipo: "E",
    subtotal: 500,
    total: 0,
    iva: 80,
    descuento: 580,
    conceptos: [{ cantidad: 1, valorUnitario: 500, importe: 500 }],
    cfdiRelacionados: ["11111111-2222-3333-4444-555555555556"],
    tipoRelacion: "",
  }),
};

function issueCodes(issues: readonly { codigo?: string; code?: string }[]): string[] {
  return issues.map((i) => i.codigo ?? i.code ?? "").sort();
}

describe("golden-set numérico: validarCfdiDespachos (TS) vs validate_cfdi (Python real)", () => {
  for (const [name, datos] of Object.entries(CASES)) {
    const py = golden[name as keyof typeof golden] as GoldenCase & {
      issues: readonly { code: string; mensaje: string; ref?: string }[];
      warnings: readonly string[];
      diot: { proveedores_reportables: readonly { rfc_proveedor: string; nombre_proveedor: string; total_operacion: string; iva_acreditable: string; periodo: string }[]; reportable: boolean };
      requires_human_review: boolean;
    };

    it(`${name}: mismos códigos de hallazgo`, () => {
      const ts = validarCfdiDespachos(datos);
      expect(issueCodes(ts.issues)).toEqual(issueCodes(py.issues));
    });

    it(`${name}: requires_human_review idéntico`, () => {
      const ts = validarCfdiDespachos(datos);
      expect(ts.requiresHumanReview).toBe(py.requires_human_review);
    });

    // CORRECCIÓN FISCAL (auditoría, hallazgo ALTO "DIOT ... devengado incorrecto"):
    // el caso "10_nomina_metodo_pago_no_pue" tiene `metodoPago: "PPD"` -- desde la
    // corrección, un CFDI tipo "I" con PPD se EXCLUYE de `proveedoresReportables`
    // (el pago real, y por tanto el IVA acreditable en DIOT, se reporta cuando
    // llegue el Complemento de Pago correspondiente, no en el periodo de esta
    // factura — ver reglas-fiscales-avanzadas.ts). El golden Python capturó el
    // comportamiento ANTERIOR a esta corrección; ese caso se compara aparte, abajo.
    if (name === "10_nomina_metodo_pago_no_pue") continue;

    it(`${name}: DIOT (reportable + proveedores reportables) idéntico`, () => {
      const ts = validarCfdiDespachos(datos);
      expect(ts.diot.reportable).toBe(py.diot.reportable);
      expect(ts.diot.proveedoresReportables.length).toBe(py.diot.proveedores_reportables.length);
      py.diot.proveedores_reportables.forEach((pyProv, idx) => {
        const tsProv = ts.diot.proveedoresReportables[idx]!;
        expect(tsProv.rfcProveedor).toBe(pyProv.rfc_proveedor);
        expect(tsProv.nombreProveedor).toBe(pyProv.nombre_proveedor);
        expect(tsProv.totalOperacion).toBe(pyProv.total_operacion);
        expect(tsProv.ivaAcreditable).toBe(pyProv.iva_acreditable);
        expect(tsProv.periodo).toBe(pyProv.periodo);
      });
    });
  }

  it("10_nomina_metodo_pago_no_pue: CFDI PPD se excluye de DIOT (reportable=false) y deja una referenceNote explicando por qué", () => {
    const ts = validarCfdiDespachos(CASES["10_nomina_metodo_pago_no_pue"]!);
    expect(ts.diot.reportable).toBe(false);
    expect(ts.diot.proveedoresReportables).toEqual([]);
    expect(ts.referenceNotes.some((n) => n.includes("PPD"))).toBe(true);
    // La regla de nómina (MetodoPago debe ser PUE) sigue disparando, sin relación
    // con el cambio de DIOT -- mismo comportamiento que antes de esta corrección.
    expect(ts.issues.some((i) => i.codigo === "nomina_metodo_pago")).toBe(true);
  });

  // ---- Aserciones de texto exacto para cada uno de los 6 checks avanzados ----

  it("02: mensaje de total_incoherente con retenciones idéntico al Python", () => {
    const ts = validarCfdiDespachos(CASES["02_retencion_isr_exacta_10pct"]!);
    const py = golden["02_retencion_isr_exacta_10pct"] as { issues: readonly { code: string; mensaje: string }[] };
    const tsIssue = ts.issues.find((i) => i.codigo === "total_incoherente");
    const pyIssue = py.issues.find((i) => i.code === "total_incoherente");
    expect(tsIssue?.mensaje).toBe(pyIssue?.mensaje);
  });

  it("04: warning de retención ISR fuera de tolerancia idéntico al Python", () => {
    const ts = validarCfdiDespachos(CASES["04_retencion_isr_desviacion_1_01_fuera_tolerancia"]!);
    const py = golden["04_retencion_isr_desviacion_1_01_fuera_tolerancia"] as { warnings: readonly string[] };
    const tsWarning = ts.warnings.find((w) => w.startsWith("Retención ISR"));
    const pyWarning = py.warnings.find((w) => w.startsWith("Retención ISR"));
    expect(tsWarning).toBe(pyWarning);
  });

  it("03: retención con desviación de $0.01 NO dispara warning (dentro de tolerancia $1.00), igual que Python", () => {
    const ts = validarCfdiDespachos(CASES["03_retencion_isr_desviacion_0_01"]!);
    expect(ts.warnings.some((w) => w.startsWith("Retención ISR"))).toBe(false);
    expect(ts.ok).toBe(true);
  });

  it("06: timbrado a 71h59m no dispara warning de fecha, igual que Python", () => {
    const ts = validarCfdiDespachos(CASES["06_timbrado_71h59m"]!);
    expect(ts.warnings.some((w) => w.includes("timbrado"))).toBe(false);
  });

  it("07: timbrado a 72h01m NO dispara warning por el truncamiento a días completos de Python (defecto heredado replicado a propósito)", () => {
    const ts = validarCfdiDespachos(CASES["07_timbrado_72h01m_no_dispara_por_truncamiento_dias"]!);
    expect(ts.warnings.some((w) => w.includes("timbrado"))).toBe(false);
  });

  it("08: warning de timbrado tardío (4 días) idéntico al Python", () => {
    const ts = validarCfdiDespachos(CASES["08_timbrado_96h01m_dispara_warning"]!);
    const py = golden["08_timbrado_96h01m_dispara_warning"] as { warnings: readonly string[] };
    expect(ts.warnings).toContain(py.warnings[0]);
  });

  it("09: warning de IEPS idéntico al Python", () => {
    const ts = validarCfdiDespachos(CASES["09_ieps_presente"]!);
    const py = golden["09_ieps_presente"] as { warnings: readonly string[] };
    expect(ts.warnings).toContain(py.warnings[0]);
  });

  it("10: fail nomina_metodo_pago idéntico al Python (mensaje + ref)", () => {
    const ts = validarCfdiDespachos(CASES["10_nomina_metodo_pago_no_pue"]!);
    const py = golden["10_nomina_metodo_pago_no_pue"] as { issues: readonly { code: string; mensaje: string; ref?: string }[] };
    const tsIssue = ts.issues.find((i) => i.codigo === "nomina_metodo_pago");
    const pyIssue = py.issues.find((i) => i.code === "nomina_metodo_pago");
    expect(tsIssue?.mensaje).toBe(pyIssue?.mensaje);
    expect(tsIssue?.ref).toBe(pyIssue?.ref);
  });

  it("11: nómina con dict vacío ({}) es FALSY en Python (no dispara ni fail ni warning) — replicado exacto en TS", () => {
    const ts = validarCfdiDespachos(CASES["11_nomina_sin_total_percepciones"]!);
    expect(ts.issues.some((i) => i.codigo === "nomina_metodo_pago")).toBe(false);
    expect(ts.warnings.some((w) => w.includes("TotalPercepciones"))).toBe(false);
    // Pero SÍ cuenta para `requires_human_review` (Python: `nomina is not None`, no
    // la misma verdad-dad que `if nomina:`) — ver golden case 11.
    expect(ts.requiresHumanReview).toBe(true);
  });

  it("12/13/14/15: issues de nota de crédito idénticos al Python", () => {
    for (const name of [
      "12_nota_credito_sin_relacionados",
      "13_nota_credito_tiporelacion_01",
      "14_nota_credito_tiporelacion_04_otro_codigo",
      "15_nota_credito_sin_tiporelacion",
    ]) {
      const ts = validarCfdiDespachos(CASES[name]!);
      const py = golden[name as keyof typeof golden] as { issues: readonly { code: string; mensaje: string }[]; warnings: readonly string[] };
      expect(issueCodes(ts.issues)).toEqual(issueCodes(py.issues));
      for (const pyIssue of py.issues) {
        const tsIssue = ts.issues.find((i) => i.codigo === pyIssue.code);
        expect(tsIssue?.mensaje).toBe(pyIssue.mensaje);
      }
      if (py.warnings.length > 0) {
        expect(ts.warnings).toContain(py.warnings[0]);
      }
    }
  });
});
