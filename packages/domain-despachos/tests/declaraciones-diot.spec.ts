// Tests unitarios de agregarDiot (Fase 2) — complementan el golden-set
// (declaraciones.golden.spec.ts) con casos de contrato de API y edge cases que no
// requieren el intérprete Python.
import { describe, expect, it } from "vitest";
import { agregarDiot, esRfcGenerico } from "../src/declaraciones/diot-aggregate.ts";
import type { RegistroDiotCandidato } from "../src/declaraciones/types.ts";

function candidato(overrides: Partial<RegistroDiotCandidato> = {}): RegistroDiotCandidato {
  return {
    rfcEmisor: "CON950820K12",
    nombreEmisor: "PROVEEDOR DE PRUEBA SA DE CV",
    subtotal: 1000,
    ivaTrasladado: 160,
    ivaAcreditable: 160,
    tasaIva: 0.16,
    tipoCambio: 1,
    moneda: "MXN",
    fecha: "2026-07-01",
    ...overrides,
  };
}

describe("esRfcGenerico", () => {
  it("detecta los 3 RFCs genéricos exactos", () => {
    expect(esRfcGenerico("XAXX010101000")).toBe(true);
    expect(esRfcGenerico("XEXX010101000")).toBe(true);
    expect(esRfcGenerico("XAXX010101001")).toBe(true);
  });

  it("es insensible a mayúsculas/minúsculas y espacios", () => {
    expect(esRfcGenerico("xaxx010101000")).toBe(true);
    expect(esRfcGenerico("  XAXX010101000  ")).toBe(true);
  });

  it("un RFC normal no es genérico", () => {
    expect(esRfcGenerico("CON950820K12")).toBe(false);
  });
});

describe("agregarDiot — contrato de API y edge cases", () => {
  it("lista vacía produce un DiotAgregado vacío, no un error", () => {
    const r = agregarDiot([], "DESP010101AB1", "2026-07");
    expect(r.registros).toEqual([]);
    expect(r.totalMontoNeto).toBe(0);
    expect(r.totalIvaTrasladado).toBe(0);
    expect(r.totalIvaAcreditable).toBe(0);
    expect(r.periodo).toBe("2026-07");
    expect(r.rfcContribuyente).toBe("DESP010101AB1");
  });

  it("una sola factura genérica produce cero registros", () => {
    const r = agregarDiot([candidato({ rfcEmisor: "XAXX010101000" })], "DESP010101AB1", "2026-07");
    expect(r.registros).toEqual([]);
  });

  // CORRECCIÓN FISCAL (auditoría, hallazgo ALTO "DIOT con tasa mal codificada"):
  // tipoOperacion NUNCA se deriva de tasaIva -- son datos independientes (uno es la
  // TASA de IVA de la factura, el otro es la NATURALEZA de negocio de la operación,
  // catálogo real 03/06/85 de la Regla 3.10.7 RMF). Ver diot-aggregate.ts.
  it("sin tipoOperacion explícito -> cae a 85 (Otros), sin importar la tasa de IVA", () => {
    expect(agregarDiot([candidato({ tasaIva: 0.16 })], "DESP010101AB1", "2026-07").registros[0]!.tipoOperacion).toBe("85");
    expect(agregarDiot([candidato({ tasaIva: 0, ivaTrasladado: 0, ivaAcreditable: 0 })], "DESP010101AB1", "2026-07").registros[0]!.tipoOperacion).toBe("85");
    expect(agregarDiot([candidato({ tasaIva: 0.08, ivaTrasladado: 80 })], "DESP010101AB1", "2026-07").registros[0]!.tipoOperacion).toBe("85");
  });

  it("tasa 0.08 (frontera) sigue clasificando el monto en ivaExento (columna de tasa, no tipoOperacion)", () => {
    const r = agregarDiot([candidato({ tasaIva: 0.08, ivaTrasladado: 80 })], "DESP010101AB1", "2026-07");
    expect(r.registros[0]!.ivaExento).toBe(80);
  });

  it("tipoOperacion explícito y válido se respeta tal cual (override de quien captura el proveedor)", () => {
    const r = agregarDiot([candidato({ tasaIva: 0.16, tipoOperacion: "03" })], "DESP010101AB1", "2026-07");
    expect(r.registros[0]!.tipoOperacion).toBe("03");
  });

  it("tipoOperacion explícito pero inválido (fuera del catálogo 03/06/85) cae a 85, nunca se propaga un código inventado", () => {
    const r = agregarDiot([candidato({ tipoOperacion: "99" as never })], "DESP010101AB1", "2026-07");
    expect(r.registros[0]!.tipoOperacion).toBe("85");
  });

  it("dos facturas del mismo RFC con distinta tasa de IVA y SIN tipoOperacion explícito se agrupan en UN solo registro (ya no se fragmentan por tasa)", () => {
    const r = agregarDiot(
      [candidato({ rfcEmisor: "EXP900101AB1", tasaIva: 0.16, subtotal: 10000, ivaTrasladado: 1600, ivaAcreditable: 1600 }), candidato({ rfcEmisor: "EXP900101AB1", tasaIva: 0, subtotal: 20000, ivaTrasladado: 0, ivaAcreditable: 0 })],
      "DESP010101AB1",
      "2026-07",
    );
    expect(r.registros.length).toBe(1);
    expect(r.registros[0]!.tipoOperacion).toBe("85");
    expect(r.registros[0]!.montoNeto).toBe(30000);
    expect(r.registros[0]!.ivaTrasladado16).toBe(1600);
    expect(r.registros[0]!.ivaTrasladado0).toBe(0);
    expect(r.registros[0]!.count).toBe(2);
  });

  it("ordena los registros por (rfc, tipoOperacion) — comparación de string, determinista", () => {
    const r = agregarDiot(
      [
        candidato({ rfcEmisor: "ZZZ010101AB1", tasaIva: 0.16, tipoOperacion: "03" }),
        candidato({ rfcEmisor: "AAA010101AB1", tasaIva: 0, tipoOperacion: "06" }),
        candidato({ rfcEmisor: "AAA010101AB1", tasaIva: 0.16, tipoOperacion: "03" }),
      ],
      "DESP010101AB1",
      "2026-07",
    );
    expect(r.registros.map((x) => `${x.rfcTercero}:${x.tipoOperacion}`)).toEqual(["AAA010101AB1:03", "AAA010101AB1:06", "ZZZ010101AB1:03"]);
  });

  it("conversión multi-moneda: campo × tipoCambio antes de sumar", () => {
    const r = agregarDiot([candidato({ subtotal: 100, ivaTrasladado: 0, ivaAcreditable: 0, tasaIva: 0, tipoCambio: 20 })], "DESP010101AB1", "2026-07");
    expect(r.registros[0]!.montoNeto).toBe(2000);
  });

  it("moneda/tipoCambio/fecha/nombre son 'last-wins' dentro de un mismo grupo (limitación heredada, ver diseño §2.4.4)", () => {
    const r = agregarDiot(
      [
        candidato({ moneda: "USD", tipoCambio: 18, fecha: "2026-07-01", nombreEmisor: "PRIMERO" }),
        candidato({ moneda: "MXN", tipoCambio: 1, fecha: "2026-07-15", nombreEmisor: "SEGUNDO" }),
      ],
      "DESP010101AB1",
      "2026-07",
    );
    expect(r.registros[0]!.moneda).toBe("MXN");
    expect(r.registros[0]!.tipoCambio).toBe(1);
    expect(r.registros[0]!.fecha).toBe("2026-07-15");
    expect(r.registros[0]!.nombre).toBe("SEGUNDO");
    expect(r.registros[0]!.count).toBe(2);
  });
});
