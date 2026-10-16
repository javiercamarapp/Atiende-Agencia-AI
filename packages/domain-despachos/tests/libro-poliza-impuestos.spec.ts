// D-P3-17: pólizas de un CFDI con retenciones de ISR/IVA (honorarios y arrendamiento de persona física), con IEPS, y póliza de cobro/pago de un
// complemento de pago (REP) con el traspaso del IVA. Cada póliza debe CUADRAR, usar solo cuentas del catálogo base y pasar la validación de entrada.
import { describe, expect, it } from "vitest";
import {
  InMemoryLibroRepository,
  construirCatalogoBase,
  construirPolizaDesdeCfdi,
  construirPolizaDesdeRep,
  validarPolizaEntrada,
} from "../src/libro/index.ts";
import type { PagoRepContable, PolizaInput } from "../src/libro/index.ts";
import type { InvoiceRecord } from "../src/types.ts";

function cfdi(parcial: Partial<InvoiceRecord>): InvoiceRecord {
  return {
    id: "i1", organizationId: "o1", propertyId: "p1", folioFiscal: "11111111-1111-1111-1111-111111111111", tipo: "I", rfcEmisor: "AAAA010101AAA", rfcReceptor: "BBB010101BBB",
    emisorNombre: null, subtotal: 1000, total: 1160, iva: 160, descuento: 0, categoria: "honorarios", confianza: null, valido: true, issues: [], warnings: [], requiresHumanReview: false,
    diot: { reportable: false } as InvoiceRecord["diot"], fecha: "2026-07-10", createdAt: "2026-07-10T00:00:00Z", direccion: "recibido", metodoPago: "PUE", moneda: "MXN",
    subtotalCentavos: 100000, descuentoCentavos: 0, totalCentavos: 116000, ivaTrasladadoCentavos: 16000, isrRetenidoCentavos: 0, ivaRetenidoCentavos: 0, iepsCentavos: 0, estadoSat: "vigente",
    ...parcial,
  } as InvoiceRecord;
}

// Honorarios de una persona física a una persona moral: base 10,000.00, IVA 16% = 1,600.00, retención de ISR 10% = 1,000.00 y de IVA 2/3 = 1,066.67.
const HONORARIOS_PF = { subtotalCentavos: 1_000_000, ivaTrasladadoCentavos: 160_000, isrRetenidoCentavos: 100_000, ivaRetenidoCentavos: 106_667, totalCentavos: 953_333 };

const CATALOGO = new Set(construirCatalogoBase().map((c) => c.codigo));

function tabla(p: PolizaInput): Array<[string, number, number]> {
  return p.movimientos.map((m) => [m.cuenta, m.debeCentavos, m.haberCentavos]);
}
function cuadraYValida(p: PolizaInput): void {
  const debe = p.movimientos.reduce((s, m) => s + m.debeCentavos, 0);
  const haber = p.movimientos.reduce((s, m) => s + m.haberCentavos, 0);
  expect(debe).toBe(haber);
  for (const m of p.movimientos) expect(CATALOGO.has(m.cuenta), `cuenta ${m.cuenta} fuera del catálogo base`).toBe(true);
  expect(validarPolizaEntrada({ ...p, movimientos: p.movimientos.map((m) => ({ cuenta: m.cuenta, concepto: m.concepto, debe: m.debeCentavos, haber: m.haberCentavos })) }).ok).toBe(true);
}

describe("CFDI recibido con retenciones", () => {
  it("honorarios de persona física: ISR 10% e IVA 2/3 retenidos van a cuentas de impuestos retenidos por pagar; el proveedor se abona por lo que se le paga", () => {
    const r = construirPolizaDesdeCfdi(cfdi(HONORARIOS_PF));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.poliza.tipo).toBe("egreso");
    expect(tabla(r.poliza)).toEqual([
      ["6020100", 1_000_000, 0],
      ["2600300", 160_000, 0],
      ["2010000", 0, 953_333],
      ["2600600", 0, 100_000],
      ["2600700", 0, 106_667],
    ]);
    cuadraYValida(r.poliza);
  });

  it("arrendamiento de persona física: el staff elige la cuenta de rentas y las retenciones se registran igual", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ ...HONORARIOS_PF, categoria: "gasto_operativo" }), { cuentaGasto: "6020400" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.poliza.movimientos[0]).toMatchObject({ cuenta: "6020400", debeCentavos: 1_000_000 });
    cuadraYValida(r.poliza);
  });

  it("solo retención de ISR (sin IVA retenido): una sola cuenta de retenido", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ subtotalCentavos: 100000, ivaTrasladadoCentavos: 16000, isrRetenidoCentavos: 10000, totalCentavos: 106000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(tabla(r.poliza)).toEqual([["6020100", 100000, 0], ["2600300", 16000, 0], ["2010000", 0, 106000], ["2600600", 0, 10000]]);
    cuadraYValida(r.poliza);
  });

  it("el descuento reduce la base y el total sigue siendo base + IVA - retenciones", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ subtotalCentavos: 110000, descuentoCentavos: 10000, ivaTrasladadoCentavos: 16000, isrRetenidoCentavos: 10000, totalCentavos: 106000 }));
    expect(r.ok && r.poliza.movimientos[0]?.debeCentavos).toBe(100000);
    if (r.ok) cuadraYValida(r.poliza);
  });

  it("si el total no es base + IVA + IEPS - retenciones NO sale la póliza", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ ...HONORARIOS_PF, totalCentavos: 953_334 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/no es igual a base más IVA e IEPS menos retenciones/);
  });
});

describe("CFDI emitido con retenciones (la persona física a la que le retienen)", () => {
  it("cargo a Clientes por lo que cobrará y a ISR/IVA retenido a favor; abono a Ingresos e IVA trasladado", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ ...HONORARIOS_PF, direccion: "emitido" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.poliza.tipo).toBe("ingreso");
    expect(tabla(r.poliza)).toEqual([
      ["1050000", 953_333, 0],
      ["1140100", 100_000, 0],
      ["1140200", 106_667, 0],
      ["4080000", 0, 1_000_000],
      ["2600400", 0, 160_000],
    ]);
    cuadraYValida(r.poliza);
  });

  it("una nota de crédito con retenciones no genera póliza automática", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ ...HONORARIOS_PF, direccion: "emitido", tipo: "E" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/no genera póliza automática/);
  });
});

describe("CFDI con IEPS", () => {
  // Base 1,000.00, IEPS 8% = 80.00, IVA 16% sobre (base + IEPS) = 172.80, total 1,252.80.
  const IEPS = { subtotalCentavos: 100000, iepsCentavos: 8000, ivaTrasladadoCentavos: 17280, totalCentavos: 125280 };

  it("recibido: por omisión el IEPS se suma al costo o gasto", () => {
    const r = construirPolizaDesdeCfdi(cfdi(IEPS));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(tabla(r.poliza)).toEqual([["6020100", 108000, 0], ["2600300", 17280, 0], ["2010000", 0, 125280]]);
    cuadraYValida(r.poliza);
  });

  it("recibido: con tratamiento acreditable el IEPS va a su propia cuenta", () => {
    const r = construirPolizaDesdeCfdi(cfdi(IEPS), { tratamientoIeps: "acreditable" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(tabla(r.poliza)).toEqual([["6020100", 100000, 0], ["2600300", 17280, 0], ["2600320", 8000, 0], ["2010000", 0, 125280]]);
    cuadraYValida(r.poliza);
  });

  it("emitido: el IEPS trasladado se abona a IEPS por pagar", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ ...IEPS, direccion: "emitido" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(tabla(r.poliza)).toEqual([["1050000", 125280, 0], ["4080000", 0, 100000], ["2600400", 0, 17280], ["2600800", 0, 8000]]);
    cuadraYValida(r.poliza);
  });

  it("IEPS y retenciones juntos también cuadran", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ ...IEPS, isrRetenidoCentavos: 10000, totalCentavos: 115280 }));
    expect(r.ok).toBe(true);
    if (r.ok) cuadraYValida(r.poliza);
  });
});

describe("el CFDI sin retenciones ni IEPS sigue igual (regresión)", () => {
  it("recibido simple: cargo gasto e IVA acreditable, abono proveedores", () => {
    const r = construirPolizaDesdeCfdi(cfdi({}));
    expect(r.ok && tabla(r.poliza)).toEqual([["6020100", 100000, 0], ["2600300", 16000, 0], ["2010000", 0, 116000]]);
  });
  it("la cuenta de gasto elegida por el staff también aplica sin retenciones", () => {
    const r = construirPolizaDesdeCfdi(cfdi({ categoria: "gasto_operativo" }), { cuentaGasto: "6020400" });
    expect(r.ok && r.poliza.movimientos[0]?.cuenta).toBe("6020400");
  });
});

function pago(parcial: Partial<PagoRepContable>): PagoRepContable {
  return {
    pagoId: "pg1", folioFiscalRep: "22222222-2222-2222-2222-222222222222", pagoIndex: 0, fechaPago: "2026-07-28", flujo: "trasladado", numParcialidad: 1,
    importePagadoCentavos: 58000, baseCentavos: 50000, ivaCentavos: 8000, ivaRetenidoCentavos: 0, folioFiscalCfdi: "11111111-1111-1111-1111-111111111111",
    direccionCfdi: "emitido", metodoPagoCfdi: "PPD", monedaCfdi: "MXN", estadoSatCfdi: "vigente", ...parcial,
  };
}

describe("construirPolizaDesdeRep", () => {
  it("cobro (emitido): cargo Bancos y abono Clientes por lo cobrado, y traspaso del IVA trasladado no cobrado a cobrado", () => {
    const r = construirPolizaDesdeRep(pago({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.poliza.tipo).toBe("ingreso");
    expect(r.poliza.fecha).toBe("2026-07-28");
    expect(r.poliza.concepto).toBe("Cobro REP 22222222 parcialidad 1 de CFDI 11111111");
    expect(tabla(r.poliza)).toEqual([["1020000", 58000, 0], ["1050000", 0, 58000], ["2600400", 8000, 0], ["2600410", 0, 8000]]);
    cuadraYValida(r.poliza);
  });

  it("pago (recibido): cargo Proveedores y abono Bancos, y traspaso del IVA acreditable pendiente a pagado", () => {
    const r = construirPolizaDesdeRep(pago({ flujo: "acreditable", direccionCfdi: "recibido" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.poliza.tipo).toBe("egreso");
    expect(r.poliza.concepto).toMatch(/^Pago REP/);
    expect(tabla(r.poliza)).toEqual([["2010000", 58000, 0], ["1020000", 0, 58000], ["2600310", 8000, 0], ["2600300", 0, 8000]]);
    cuadraYValida(r.poliza);
  });

  it("sin IVA (pago de un CFDI exento) solo lleva el par de cobro", () => {
    const r = construirPolizaDesdeRep(pago({ ivaCentavos: 0, baseCentavos: 58000 }));
    expect(r.ok && tabla(r.poliza)).toEqual([["1020000", 58000, 0], ["1050000", 0, 58000]]);
  });

  it("acepta una cuenta de bancos distinta", () => {
    const r = construirPolizaDesdeRep(pago({}), { cuentaBancos: "1020100" });
    expect(r.ok && r.poliza.movimientos[0]?.cuenta).toBe("1020100");
  });

  it("el IVA retenido del pago no se traspasa y queda como advertencia", () => {
    const r = construirPolizaDesdeRep(pago({ ivaRetenidoCentavos: 500 }));
    expect(r.ok && r.advertencias.join(" ")).toMatch(/IVA retenido/);
  });

  it.each([
    ["CFDI cancelado", { estadoSatCfdi: "cancelado" }, /cancelado/],
    ["CFDI que no es PPD", { metodoPagoCfdi: "PUE" }, /PPD/],
    ["método de pago desconocido", { metodoPagoCfdi: null }, /PPD/],
    ["moneda extranjera", { monedaCfdi: "USD" }, /extranjera/],
    ["flujo que no corresponde al sentido del CFDI", { direccionCfdi: "recibido" as const }, /no corresponde/],
    ["importe cero", { importePagadoCentavos: 0 }, /mayor a cero/],
    ["IVA mayor a lo pagado", { ivaCentavos: 58001 }, /IVA del pago es inválido/],
    ["IVA negativo", { ivaCentavos: -1 }, /IVA del pago es inválido/],
    ["fecha inválida", { fechaPago: "28/07/2026" }, /fecha/],
  ])("no sale la póliza: %s", (_n, parcial, motivo) => {
    const r = construirPolizaDesdeRep(pago(parcial as Partial<PagoRepContable>));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(motivo);
  });

  it("registradas en el libro: el cobro deja neto cero el IVA no cobrado contra la póliza del CFDI y la balanza cuadra", async () => {
    const repo = new InMemoryLibroRepository();
    await repo.sembrarCatalogo("p1", construirCatalogoBase());
    const devengada = construirPolizaDesdeCfdi(cfdi({ direccion: "emitido", subtotalCentavos: 100000, ivaTrasladadoCentavos: 16000, totalCentavos: 116000, metodoPago: "PPD" }));
    const cobro1 = construirPolizaDesdeRep(pago({ importePagadoCentavos: 58000, ivaCentavos: 8000 }));
    const cobro2 = construirPolizaDesdeRep(pago({ pagoIndex: 1, numParcialidad: 2, importePagadoCentavos: 58000, ivaCentavos: 8000, fechaPago: "2026-07-30" }));
    if (!devengada.ok || !cobro1.ok || !cobro2.ok) throw new Error("las tres pólizas debían salir");
    await repo.registrarPoliza("p1", devengada.poliza, "i1");
    await repo.registrarPoliza("p1", cobro1.poliza);
    await repo.registrarPoliza("p1", cobro2.poliza);
    const balanza = (await repo.balanza("p1", 2026, 7)).datos;
    const por = new Map(balanza.map((l) => [l.cuenta, l] as const));
    expect(por.get("2600400")?.saldoFinalCentavos).toBe(0); // todo el IVA trasladado ya está cobrado
    expect(por.get("2600410")?.saldoFinalCentavos).toBe(16000);
    expect(por.get("1050000")?.saldoFinalCentavos).toBe(0); // la cuenta por cobrar quedó saldada
    expect(por.get("1020000")?.saldoFinalCentavos).toBe(116000);
    expect(balanza.reduce((s, l) => s + l.debeCentavos, 0)).toBe(balanza.reduce((s, l) => s + l.haberCentavos, 0));
  });
});
