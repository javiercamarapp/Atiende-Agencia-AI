// Tests unitarios de agregarDiot (Fase 2) — complementan el golden-set
// (declaraciones.golden.spec.ts) con casos de contrato de API y edge cases que no
// requieren el intérprete Python.
import { describe, expect, it } from "vitest";
import { agregarDiot, esRfcGenerico } from "../src/declaraciones/diot-aggregate.ts";
import type { RegistroDiotCandidato } from "../src/declaraciones/types.ts";
import { candidatosDiotDesdeInvoices, construirDiotDesdeInvoices } from "../src/declaraciones/diot-desde-invoices.ts";
import type { InvoiceRecord } from "../src/types.ts";

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

// D-P3-01: la DIOT solo toma compras del cliente y su RFC sale de la ficha, nunca de un CFDI.
function inv(id: string, extra: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id, organizationId: "org", propertyId: "p1", folioFiscal: `UUID-${id}`, tipo: "I",
    rfcEmisor: "CON950820K12", rfcReceptor: "DESP010101AB1", emisorNombre: "PROVEEDOR", subtotal: 1000, total: 1160, iva: 160, descuento: 0,
    categoria: "gasto_operativo", confianza: null, valido: true, issues: [], warnings: [], requiresHumanReview: false,
    diot: { reportable: true, proveedoresReportables: [{ rfcProveedor: "CON950820K12", nombreProveedor: "PROVEEDOR", totalOperacion: "1000", ivaAcreditable: "160", periodo: "2026-07", tasaIva: 0.16 }] },
    fecha: "2026-07-10", createdAt: "2026-07-11T00:00:00Z", direccion: "recibido", estadoSat: "vigente",
    ...extra,
  };
}
const FICHA_RFC = "DESP010101AB1";

describe("construirDiotDesdeInvoices — solo compras vigentes y validas del cliente (D-P3-01)", () => {
  it("un CFDI emitido por el cliente (su venta) NO es proveedor", () => {
    const r = construirDiotDesdeInvoices([inv("v", { direccion: "emitido", rfcEmisor: FICHA_RFC, rfcReceptor: "CLIENTE0001X9" })], "2026-07", FICHA_RFC);
    expect(r.registros).toHaveLength(0);
    expect(r.excluidos).toBe(1);
  });

  it("cancelado y no_encontrado ante el SAT quedan fuera; vigente y pendiente cuentan", () => {
    const r = construirDiotDesdeInvoices([inv("a", { estadoSat: "cancelado" }), inv("b", { estadoSat: "no_encontrado" }), inv("c", { estadoSat: "vigente" }), inv("d", { estadoSat: "pendiente" })], "2026-07", FICHA_RFC);
    expect(r.registros[0]!.count).toBe(2);
    expect(r.excluidos).toBe(2);
  });

  it("un CFDI invalido queda fuera", () => {
    const r = construirDiotDesdeInvoices([inv("a", { valido: false })], "2026-07", FICHA_RFC);
    expect(r.registros).toHaveLength(0);
    expect(r.excluidos).toBe(1);
  });

  it("el RFC del contribuyente es el de la ficha, aunque el receptor del CFDI sea otro", () => {
    const r = construirDiotDesdeInvoices([inv("a", { rfcReceptor: "OTRO010101AB1" })], "2026-07", FICHA_RFC);
    expect(r.rfcContribuyente).toBe(FICHA_RFC);
    expect(r.registros).toHaveLength(1);
  });

  it("sin ficha (RFC null): sin datos, rfcContribuyente null, aunque haya compras", () => {
    const r = construirDiotDesdeInvoices([inv("a")], "2026-07", null);
    expect(r.registros).toHaveLength(0);
    expect(r.rfcContribuyente).toBeNull();
  });

  it("direccion desconocida (base sin migrar): cuenta solo si la ficha confirma que el cliente es el receptor", () => {
    const compraLegada = inv("a", { direccion: null, estadoSat: undefined });
    const ventaLegada = inv("b", { direccion: null, estadoSat: undefined, rfcEmisor: FICHA_RFC, rfcReceptor: "CLIENTE0001X9" });
    const r = candidatosDiotDesdeInvoices([compraLegada, ventaLegada], FICHA_RFC);
    expect(r.candidatos).toHaveLength(1);
    expect(r.excluidos).toBe(1);
    expect(candidatosDiotDesdeInvoices([compraLegada], null).candidatos).toHaveLength(0);
  });
});
