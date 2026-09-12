// Golden-set numérico (Fase 2 despachos, OBLIGATORIO — ver diseño §4) — compara,
// campo por campo, el output del motor Python REAL (`calculate_isr_pf`,
// `calculate_isr_pm`, `calculate_isr_pm_resico`, `aggregate_diot` de
// b2b_ai/features/declaraciones/engine.py, capturado en
// tests/fixtures/golden-declaraciones-output.json vía
// tests/fixtures/golden_gen_declaraciones.py, corrido contra el intérprete real del
// repo `despachos`) contra el motor TS nuevo (`calcularIsrPf`/`calcularIsrPm`/
// `calcularIsrPmResico`/`agregarDiot`).
//
// 63 casos: 20 (ISR PF mensual, límites de los 10 tramos) + 20 (ISR PF anual) +
// 12 (ISR PM RESICO, límites de los 6 tramos) + 3 (ISR PF: cero/negativo/pagos
// provisionales) + 5 (ISR PM: básico/cero/negativo/pagos provisionales/redondeo) +
// 3 (DIOT: multi-factura+genérico, mismo RFC dos tasas, moneda extranjera+frontera
// 8%). Cada caso de límite de tramo se generó PROGRAMÁTICAMENTE desde la tabla real
// (ver el script), no transcrito a mano.
//
// Si algún caso no coincidiera, el criterio (diseño §4, tarea) es corregir el TS,
// nunca ajustar el golden para que pase.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-declaraciones-output.json" with { type: "json" };
import { calcularIsrPf, calcularIsrPm, calcularIsrPmResico } from "../src/declaraciones/isr-engine.ts";
import { agregarDiot } from "../src/declaraciones/diot-aggregate.ts";
import type { RegistroDiotCandidato } from "../src/declaraciones/types.ts";

type GoldenIsr = {
  entrada: { baseGravable?: number; utilidadFiscal?: number; pagosProvisionales?: number };
  resultado: {
    base_gravable: number;
    isr_bruto: number;
    tasa_efectiva: number;
    tipo_contribuyente: string;
    tabla_aplicada: string;
    isr_neto: number;
    pagos_provisionales: number;
  };
};

type GoldenDiotInvoice = {
  rfc_emisor: string;
  nombre_emisor: string;
  subtotal: number;
  iva_trasladado: number;
  iva_acreditable: number;
  tasa_iva: number;
  tipo_cambio: number;
  moneda: string;
  fecha: string;
};

type GoldenDiot = {
  entrada: { invoices: GoldenDiotInvoice[]; rfcContribuyente: string; periodo: string };
  resultado: {
    records: readonly {
      rfc_tercero: string;
      nombre: string;
      tipo_operacion: string;
      moneda: string;
      tipo_cambio: number;
      fecha: string;
      monto_neto: number;
      iva_trasladado_16: number;
      iva_trasladado_0: number;
      iva_acreditable_16: number;
      iva_acreditable_0: number;
      iva_exento: number;
      count: number;
    }[];
    total_records: number;
    total_monto_neto: number;
    total_iva_trasladado: number;
    total_iva_acreditable: number;
    periodo: string;
    rfc_contribuyente: string;
  };
};

const goldenEntries = Object.entries(golden) as [string, unknown][];

function isrPfMensualCases() {
  return goldenEntries.filter(([name]) => name.startsWith("isr_pf_mensual_tramo") || name === "isr_pf_mensual_cero" || name === "isr_pf_mensual_negativo");
}
function isrPfAnualCases() {
  return goldenEntries.filter(([name]) => name.startsWith("isr_pf_anual_tramo"));
}
function isrPmResicoCases() {
  return goldenEntries.filter(([name]) => name.startsWith("isr_pm_resico_tramo"));
}
function isrPmCases() {
  return goldenEntries.filter(([name]) => name.startsWith("isr_pm_") && !name.startsWith("isr_pm_resico"));
}
function diotCases() {
  return goldenEntries.filter(([name]) => name.startsWith("diot_"));
}

describe("golden-set numérico: ISR PF mensual (TS) vs calculate_isr_pf (Python real)", () => {
  for (const [name, raw] of isrPfMensualCases()) {
    const { entrada, resultado } = raw as GoldenIsr;
    it(`${name}: base=${entrada.baseGravable} -> isrBruto=${resultado.isr_bruto}`, () => {
      const ts = calcularIsrPf(entrada.baseGravable!, { annual: false });
      expect(ts.baseGravable).toBe(resultado.base_gravable);
      expect(ts.isrBruto).toBe(resultado.isr_bruto);
      expect(ts.tasaEfectiva).toBe(resultado.tasa_efectiva);
      expect(ts.isrNeto).toBe(resultado.isr_neto);
      expect(ts.tablaAplicada).toBe("monthly");
    });
  }

  it("isr_pf_mensual_con_pagos_provisionales: mismo isrNeto que Python", () => {
    const { entrada, resultado } = golden.isr_pf_mensual_con_pagos_provisionales as unknown as GoldenIsr;
    const ts = calcularIsrPf(entrada.baseGravable!, { annual: false, pagosProvisionales: entrada.pagosProvisionales });
    expect(ts.isrBruto).toBe(resultado.isr_bruto);
    expect(ts.isrNeto).toBe(resultado.isr_neto);
  });
});

describe("golden-set numérico: ISR PF anual (TS) vs calculate_isr_pf(annual=True) (Python real)", () => {
  for (const [name, raw] of isrPfAnualCases()) {
    const { entrada, resultado } = raw as GoldenIsr;
    it(`${name}: base=${entrada.baseGravable} -> isrBruto=${resultado.isr_bruto}`, () => {
      const ts = calcularIsrPf(entrada.baseGravable!, { annual: true });
      expect(ts.baseGravable).toBe(resultado.base_gravable);
      expect(ts.isrBruto).toBe(resultado.isr_bruto);
      expect(ts.tasaEfectiva).toBe(resultado.tasa_efectiva);
      expect(ts.isrNeto).toBe(resultado.isr_neto);
      expect(ts.tablaAplicada).toBe("annual");
    });
  }
});

describe("golden-set numérico: ISR PM RESICO mensual (TS) vs calculate_isr_pm_resico (Python real)", () => {
  for (const [name, raw] of isrPmResicoCases()) {
    const { entrada, resultado } = raw as GoldenIsr;
    it(`${name}: ingreso=${entrada.baseGravable} -> isrBruto=${resultado.isr_bruto}`, () => {
      const ts = calcularIsrPmResico(entrada.baseGravable!);
      expect(ts.baseGravable).toBe(resultado.base_gravable);
      expect(ts.isrBruto).toBe(resultado.isr_bruto);
      expect(ts.tasaEfectiva).toBe(resultado.tasa_efectiva);
      expect(ts.isrNeto).toBe(resultado.isr_neto);
      expect(ts.tablaAplicada).toBe("pm_resico");
    });
  }

  it("isr_pm_resico_tramo5_lower: preserva la cuota fija de 4 decimales (86799.1675) del último tramo", () => {
    const { resultado } = golden.isr_pm_resico_tramo5_lower as unknown as GoldenIsr;
    const ts = calcularIsrPmResico(3500000.01);
    expect(ts.isrBruto).toBe(resultado.isr_bruto);
    expect(ts.isrBruto).toBe(86799.17);
  });
});

describe("golden-set numérico: ISR PM tasa fija 30% (TS) vs calculate_isr_pm (Python real)", () => {
  for (const [name, raw] of isrPmCases()) {
    const { entrada, resultado } = raw as GoldenIsr;
    it(`${name}: utilidad=${entrada.utilidadFiscal} -> isrBruto=${resultado.isr_bruto}`, () => {
      const ts = calcularIsrPm(entrada.utilidadFiscal!, entrada.pagosProvisionales ?? 0);
      expect(ts.baseGravable).toBe(resultado.base_gravable);
      expect(ts.isrBruto).toBe(resultado.isr_bruto);
      expect(ts.tasaEfectiva).toBe(resultado.tasa_efectiva);
      expect(ts.isrNeto).toBe(resultado.isr_neto);
      expect(ts.tablaAplicada).toBe("pm_30%");
    });
  }
});

function toCandidato(inv: GoldenDiotInvoice): RegistroDiotCandidato {
  return {
    rfcEmisor: inv.rfc_emisor,
    nombreEmisor: inv.nombre_emisor,
    subtotal: inv.subtotal,
    ivaTrasladado: inv.iva_trasladado,
    ivaAcreditable: inv.iva_acreditable,
    tasaIva: inv.tasa_iva,
    tipoCambio: inv.tipo_cambio,
    moneda: inv.moneda,
    fecha: inv.fecha,
  };
}

describe("golden-set numérico: DIOT (TS) vs aggregate_diot (Python real)", () => {
  for (const [name, raw] of diotCases()) {
    const { entrada, resultado } = raw as GoldenDiot;
    it(`${name}: mismos registros agregados (orden, montos, tipoOperacion)`, () => {
      const candidatos = entrada.invoices.map(toCandidato);
      const ts = agregarDiot(candidatos, entrada.rfcContribuyente, entrada.periodo);

      expect(ts.registros.length).toBe(resultado.total_records);
      resultado.records.forEach((pyRec, idx) => {
        const tsRec = ts.registros[idx]!;
        expect(tsRec.rfcTercero).toBe(pyRec.rfc_tercero);
        expect(tsRec.nombre).toBe(pyRec.nombre);
        expect(tsRec.tipoOperacion).toBe(pyRec.tipo_operacion);
        expect(tsRec.moneda).toBe(pyRec.moneda);
        expect(tsRec.tipoCambio).toBe(pyRec.tipo_cambio);
        expect(tsRec.fecha).toBe(pyRec.fecha);
        expect(tsRec.montoNeto).toBe(pyRec.monto_neto);
        expect(tsRec.ivaTrasladado16).toBe(pyRec.iva_trasladado_16);
        expect(tsRec.ivaTrasladado0).toBe(pyRec.iva_trasladado_0);
        expect(tsRec.ivaAcreditable16).toBe(pyRec.iva_acreditable_16);
        expect(tsRec.ivaAcreditable0).toBe(pyRec.iva_acreditable_0);
        expect(tsRec.ivaExento).toBe(pyRec.iva_exento);
        expect(tsRec.count).toBe(pyRec.count);
      });

      expect(ts.totalMontoNeto).toBe(resultado.total_monto_neto);
      expect(ts.totalIvaTrasladado).toBe(resultado.total_iva_trasladado);
      expect(ts.totalIvaAcreditable).toBe(resultado.total_iva_acreditable);
      expect(ts.periodo).toBe(resultado.periodo);
      expect(ts.rfcContribuyente).toBe(resultado.rfc_contribuyente);
    });
  }

  it("caso A: RFC genérico se filtra sin importar el monto ($999,999 desaparece)", () => {
    const { resultado } = golden.diot_caso_a_multi_factura_generico_filtrado as unknown as GoldenDiot;
    expect(resultado.total_records).toBe(1);
    expect(resultado.records[0]!.count).toBe(2);
    expect(resultado.records[0]!.monto_neto).toBe(8000);
  });

  it("caso B: mismo RFC con dos tasas de IVA produce DOS registros (llave rfc+tipoOperacion)", () => {
    const { resultado } = golden.diot_caso_b_mismo_rfc_dos_tasas as unknown as GoldenDiot;
    expect(resultado.total_records).toBe(2);
  });

  it("caso C: IVA de frontera 8% cae en ivaExento, no en un campo de 8% (no existe)", () => {
    const { resultado } = golden.diot_caso_c_moneda_extranjera_y_frontera_8pct as unknown as GoldenDiot;
    const frontera = resultado.records.find((r) => r.tipo_operacion === "85")!;
    expect(frontera.iva_exento).toBe(320);
  });
});
