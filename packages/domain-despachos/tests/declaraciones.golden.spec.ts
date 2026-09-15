// Golden-set numérico (Fase 2 despachos) — DIOT únicamente.
//
// CORRECCIÓN FISCAL (auditoría, hallazgos CRÍTICOS #1/#2 y ALTO "DIOT con tasa mal
// codificada"): este archivo comparaba antes también ISR PF/PM/PM-RESICO contra
// `tests/fixtures/golden-declaraciones-output.json` — una captura de un motor Python
// de referencia cuyas tablas ISR resultaron NO coincidir con el Anexo 8 SAT/DOF real
// (ver declaraciones/isr-tablas.ts) y cuyo RESICO PM aplicaba por error la tabla
// progresiva de RESICO PF (ver isr-engine.ts). Esa fixture ya NO es una fuente de
// verdad fiscal válida para ISR: se retiraron esas secciones de aquí. La corrección
// numérica de ISR PF/PM/PM-RESICO está cubierta directamente en
// declaraciones-isr.spec.ts, con assertions explícitas contra los valores oficiales
// verificados (no contra una fixture capturada de un sistema con datos incorrectos).
//
// La parte de DIOT (`aggregate_diot`) sí se conserva: la fixture sigue siendo válida
// para los montos/agrupación por RFC — solo se ajustaron los campos `tipoOperacion`
// esperados, que la fixture capturó con la derivación incorrecta "tasa de IVA ->
// tipo de operación" (ver corrección del hallazgo "DIOT con tasa mal codificada" en
// diot-aggregate.ts): ahora se comparan por separado, no contra `tipo_operacion` de
// la fixture.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-declaraciones-output.json" with { type: "json" };
import { agregarDiot } from "../src/declaraciones/diot-aggregate.ts";
import type { RegistroDiotCandidato } from "../src/declaraciones/types.ts";

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

function diotCases() {
  return goldenEntries.filter(([name]) => name.startsWith("diot_"));
}

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

describe("golden-set numérico: DIOT (TS) vs aggregate_diot (montos/agrupación por RFC)", () => {
  // `tipoOperacion` se compara aparte (no contra `tipo_operacion` de la fixture,
  // que capturó la derivación incorrecta "tasa de IVA -> tipo de operación" — ver
  // cabecera del archivo): ninguno de los candidatos de esta fixture trae un
  // override explícito, así que el TS corregido siempre cae a "85" (Otros). El
  // efecto colateral real es que filas que la fixture separaba por tasa de IVA
  // ahora se agrupan juntas (mismo rfc, mismo tipoOperacion="85") — por eso los
  // casos cuyo `entrada` tiene un RFC repetido con distinta tasa (p. ej. "caso B")
  // producen MENOS registros que `total_records` de la fixture; se comparan aparte
  // más abajo en vez de con esta comparación genérica.
  const CASOS_CON_AGRUPACION_DISTINTA = new Set(["diot_caso_b_mismo_rfc_dos_tasas"]);

  for (const [name, raw] of diotCases()) {
    if (CASOS_CON_AGRUPACION_DISTINTA.has(name)) continue;
    const { entrada, resultado } = raw as GoldenDiot;
    it(`${name}: mismos registros agregados (orden, montos)`, () => {
      const candidatos = entrada.invoices.map(toCandidato);
      const ts = agregarDiot(candidatos, entrada.rfcContribuyente, entrada.periodo);

      expect(ts.registros.length).toBe(resultado.total_records);
      resultado.records.forEach((pyRec, idx) => {
        const tsRec = ts.registros[idx]!;
        expect(tsRec.rfcTercero).toBe(pyRec.rfc_tercero);
        expect(tsRec.nombre).toBe(pyRec.nombre);
        expect(tsRec.tipoOperacion).toBe("85"); // ver nota arriba: nunca derivado de tasaIva
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
    const { entrada } = golden.diot_caso_a_multi_factura_generico_filtrado as unknown as GoldenDiot;
    const ts = agregarDiot(entrada.invoices.map(toCandidato), entrada.rfcContribuyente, entrada.periodo);
    expect(ts.registros.length).toBe(1);
    expect(ts.registros[0]!.count).toBe(2);
    expect(ts.registros[0]!.montoNeto).toBe(8000);
  });

  it("caso B: mismo RFC con dos tasas de IVA y SIN tipoOperacion explícito produce UN solo registro (ya no se fragmenta por tasa — corrección hallazgo DIOT)", () => {
    const { entrada } = golden.diot_caso_b_mismo_rfc_dos_tasas as unknown as GoldenDiot;
    const ts = agregarDiot(entrada.invoices.map(toCandidato), entrada.rfcContribuyente, entrada.periodo);
    expect(ts.registros.length).toBe(1);
    expect(ts.registros[0]!.tipoOperacion).toBe("85");
    expect(ts.registros[0]!.montoNeto).toBe(30000); // 10000 + 20000
    expect(ts.registros[0]!.ivaTrasladado16).toBe(1600);
    expect(ts.registros[0]!.ivaTrasladado0).toBe(0);
    expect(ts.registros[0]!.count).toBe(2);
  });

  it("caso C: IVA de frontera 8% cae en ivaExento, no en un campo de 8% (no existe)", () => {
    const { entrada } = golden.diot_caso_c_moneda_extranjera_y_frontera_8pct as unknown as GoldenDiot;
    const ts = agregarDiot(entrada.invoices.map(toCandidato), entrada.rfcContribuyente, entrada.periodo);
    const frontera = ts.registros.find((r) => r.rfcTercero === "FRO010101YY2")!;
    expect(frontera.ivaExento).toBe(320);
    expect(frontera.tipoOperacion).toBe("85");
  });
});
