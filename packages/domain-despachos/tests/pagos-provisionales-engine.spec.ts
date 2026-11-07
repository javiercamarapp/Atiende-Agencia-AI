// D-25: motor del papel de pagos provisionales ISR/IVA. Cada cifra esperada está calculada a mano (centavos enteros).
import { describe, expect, it } from "vitest";
import { aplicarTablaIsr } from "../src/declaraciones/isr-engine.ts";
import { ISR_MENSUAL_2025, ISR_MENSUAL_2026 } from "../src/declaraciones/isr-tablas.ts";
import { calcularPapelProvisional, coeficienteAMicros, isrTarifaAcumuladaCentavos, tasaResicoBp, tipoPersonaPorRfc } from "../src/pagos-provisionales/index.ts";
import type { EntradaPapel, FacturaProvisional, PagoRepProvisional } from "../src/pagos-provisionales/index.ts";

let contador = 0;
function factura(p: Partial<FacturaProvisional> & { base?: number }): FacturaProvisional {
  contador += 1;
  const base = p.base ?? 1_000_000;
  const iva = p.ivaTrasladadoCentavos ?? Math.round(base * 0.16);
  return {
    id: `f${contador}`, folioFiscal: `folio-${contador}`, tipo: "I", valido: true, fecha: "2026-07-10", direccion: "emitido", metodoPago: "PUE", formaPago: "03", usoCfdi: "G03", moneda: "MXN",
    subtotalCentavos: base, descuentoCentavos: 0, totalCentavos: base + iva, ivaTrasladadoCentavos: iva, isrRetenidoCentavos: 0, ivaRetenidoCentavos: 0, estadoSat: "vigente", ...p,
  };
}
function entrada(parcial: Partial<EntradaPapel>): EntradaPapel {
  return { ejercicio: 2026, mes: 7, regimen: "601", rfc: "XAXX010101000", facturas: [], pagos: [], pagosDisponibles: true, isr: {}, iva: {}, pagosPreviosIsrPresentadosCentavos: 0, saldoFavorIvaMesAnteriorCentavos: null, ...parcial };
}

describe("PM 601: coeficiente de utilidad (LISR 14) e IVA", () => {
  it("ISR = 30% de (ingresos acumulados x coeficiente), menos pagos previos; IVA = trasladado - acreditable", () => {
    const p = calcularPapelProvisional(
      entrada({
        facturas: [
          factura({ base: 6_000_000, fecha: "2026-06-05" }), // acumula en el ejercicio, pero su IVA es de junio
          factura({ base: 4_000_000, fecha: "2026-07-10" }),
          factura({ base: 2_000_000, fecha: "2026-07-12", direccion: "recibido" }), // gasto: no entra a ISR 601, su IVA se acredita
        ],
        isr: { coeficienteUtilidad: "0.200000" },
        pagosPreviosIsrPresentadosCentavos: 200_000,
      }),
    );
    expect(p.isr.estado).toBe("calculado");
    expect(p.isr.baseCentavos).toBe(2_000_000); // 10,000,000 x 0.2
    expect(p.isr.determinadoCentavos).toBe(600_000); // 30%
    expect(p.isr.aCargoCentavos).toBe(400_000);
    expect(p.isr.aFavorCentavos).toBe(0);
    // IVA solo del mes de julio: 640,000 trasladado (16% de 4,000,000) - 320,000 acreditable.
    expect(p.iva.lineas.find((l) => l.clave === "trasladado")?.centavos).toBe(640_000);
    expect(p.iva.aCargoCentavos).toBe(320_000);
    expect(p.documentosIncluidos).toBe(3);
  });

  it("pérdidas pendientes reducen la base; el excedente de retenciones queda a favor", () => {
    const p = calcularPapelProvisional(
      entrada({
        facturas: [factura({ base: 10_000_000, isrRetenidoCentavos: 1_000_000 })],
        isr: { coeficienteUtilidad: "0.5", perdidasPendientesCentavos: 1_000_000 },
      }),
    );
    expect(p.isr.baseCentavos).toBe(4_000_000); // 5,000,000 - 1,000,000
    expect(p.isr.determinadoCentavos).toBe(1_200_000);
    expect(p.isr.aCargoCentavos).toBe(200_000); // 1,200,000 - 1,000,000 de retenciones
  });

  it("sin coeficiente NO inventa el ISR: faltan parámetros (el IVA sí sale)", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [factura({})] }));
    expect(p.isr.estado).toBe("faltan_parametros");
    expect(p.isr.motivo).toMatch(/coeficiente de utilidad/);
    expect(p.isr.aCargoCentavos).toBe(0);
    expect(p.iva.estado).toBe("calculado");
  });

  it("un coeficiente mal formado no se acepta", () => {
    expect(coeficienteAMicros("0.2345678")).toBeNull();
    expect(coeficienteAMicros("abc")).toBeNull();
    expect(coeficienteAMicros("-0.1")).toBeNull();
    expect(coeficienteAMicros("0.234567")).toBe(234_567);
    expect(coeficienteAMicros("1")).toBe(1_000_000);
  });
});

describe("PM 601: el ISR es por ingresos NOMINALES (LISR 17), el IVA por flujo (LIVA 1-B)", () => {
  const ppd = factura({ id: "ppdm", metodoPago: "PPD", formaPago: "99", base: 5_000_000, fecha: "2026-07-05" });
  it("un CFDI PPD emitido en el mes y NO cobrado entra al ISR 601 (nominal) pero no al IVA trasladado (flujo)", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [ppd, factura({ base: 1_000_000 })], isr: { coeficienteUtilidad: "0.5" } }));
    expect(p.isr.lineas.find((l) => l.clave === "ingresos")?.centavos).toBe(6_000_000);
    expect(p.isr.baseCentavos).toBe(3_000_000); // 6,000,000 x 0.5
    expect(p.isr.determinadoCentavos).toBe(900_000);
    expect(p.iva.lineas.find((l) => l.clave === "trasladado")?.centavos).toBe(160_000); // solo el PUE
    expect(p.advertencias.join(" ")).toMatch(/ISR 601: el ingreso se acumula por CFDI emitido/);
    expect(p.advertencias.join(" ")).toMatch(/el ISR 601 sí los acumula/);
  });
  it("el cobro posterior del PPD (REP) NO duplica el ingreso nominal ya acumulado al emitir", () => {
    const pago: PagoRepProvisional = { invoiceId: "ppdm", fechaPago: "2026-07-20", flujo: "trasladado", importePagadoCentavos: 5_800_000, baseCentavos: 5_000_000, ivaCentavos: 800_000, ivaRetenidoCentavos: 0 };
    const p = calcularPapelProvisional(entrada({ facturas: [ppd], pagos: [pago], isr: { coeficienteUtilidad: "1" } }));
    expect(p.isr.baseCentavos).toBe(5_000_000);
    expect(p.iva.lineas.find((l) => l.clave === "trasladado")?.centavos).toBe(800_000);
  });
  it("una nota de crédito emitida resta del ingreso nominal; cancelados, sin montos y moneda extranjera no cuentan", () => {
    const p = calcularPapelProvisional(
      entrada({
        facturas: [factura({ base: 10_000_000 }), factura({ tipo: "E", base: 2_000_000 }), factura({ estadoSat: "cancelado" }), factura({ moneda: "USD" }), factura({ subtotalCentavos: null })],
        isr: { coeficienteUtilidad: "1" },
      }),
    );
    expect(p.isr.baseCentavos).toBe(8_000_000);
  });
  it("sin pagos de complemento disponibles el ISR 601 igual cuenta el PPD emitido (no depende de la migración de pagos)", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [ppd], pagosDisponibles: false, isr: { coeficienteUtilidad: "1" } }));
    expect(p.isr.baseCentavos).toBe(5_000_000);
  });
});

describe("PF 612: utilidad acumulada y tarifa del art. 96 escalada", () => {
  it("ingresos 300,000 - deducciones 100,000 en el mes 3: ISR = 41,208.25 (calculado a mano)", () => {
    const p = calcularPapelProvisional(
      entrada({
        mes: 3,
        regimen: "612",
        facturas: [factura({ base: 30_000_000, fecha: "2026-03-10" }), factura({ base: 10_000_000, fecha: "2026-02-10", direccion: "recibido" })],
      }),
    );
    expect(p.isr.estado).toBe("calculado");
    expect(p.isr.baseCentavos).toBe(20_000_000);
    expect(p.isr.determinadoCentavos).toBe(4_120_825);
    expect(p.advertencias.join(" ")).toMatch(/escala al periodo acumulado/);
  });

  it("una utilidad negativa no genera ISR", () => {
    const p = calcularPapelProvisional(entrada({ regimen: "612", facturas: [factura({ base: 1_000_000 }), factura({ base: 5_000_000, direccion: "recibido" })] }));
    expect(p.isr.baseCentavos).toBe(0);
    expect(p.isr.determinadoCentavos).toBe(0);
  });

  it("con 1 mes el escalado coincide con la tarifa mensual del motor existente (sin diferencias de centavos)", () => {
    for (const pesos of [100, 844.59, 844.6, 5000, 7168.52, 12598.03, 35362.84, 55736.69, 106410.51, 141880.67, 425641.99, 500000]) {
      const centavos = Math.round(pesos * 100);
      expect(isrTarifaAcumuladaCentavos(centavos, 1)).toBe(Math.round(aplicarTablaIsr(pesos, ISR_MENSUAL_2026) * 100));
    }
  });
});

describe("PF 626 RESICO: tasa mensual sobre ingresos cobrados", () => {
  it("30,000.00 de ingreso del mes -> 1.10% = 330.00; con retención de 375.00 queda a favor 45.00", () => {
    const p = calcularPapelProvisional(
      entrada({ regimen: "626", facturas: [factura({ base: 3_000_000, isrRetenidoCentavos: 37_500 }), factura({ base: 9_000_000, fecha: "2026-06-10" })] }),
    );
    expect(p.isr.determinadoCentavos).toBe(33_000);
    expect(p.isr.aCargoCentavos).toBe(0);
    expect(p.isr.aFavorCentavos).toBe(4_500);
  });
  it("tasas por tramo mensual", () => {
    expect(tasaResicoBp(2_500_000)).toBe(100);
    expect(tasaResicoBp(2_500_001)).toBe(110);
    expect(tasaResicoBp(5_000_001)).toBe(150);
    expect(tasaResicoBp(8_333_334)).toBe(200);
    expect(tasaResicoBp(20_833_334)).toBe(250);
    expect(tasaResicoBp(350_000_001)).toBeNull();
  });
});

describe("626 y 612 son de personas físicas; la tabla del 612 sale del ejercicio", () => {
  it("626 con RFC de persona moral (12) responde no soportado, sin cifras; el IVA sí sale", () => {
    const p = calcularPapelProvisional(entrada({ regimen: "626", rfc: "ABC010101AB1", facturas: [factura({ base: 3_000_000 })] }));
    expect(p.isr.estado).toBe("no_soportado");
    expect(p.isr.motivo).toMatch(/persona moral/);
    expect(p.isr.determinadoCentavos).toBe(0);
    expect(p.iva.estado).toBe("calculado");
  });
  it("626 sin RFC utilizable tampoco se calcula", () => {
    expect(calcularPapelProvisional(entrada({ regimen: "626", rfc: null, facturas: [factura({})] })).isr.estado).toBe("no_soportado");
  });
  it("626 con RFC de persona física (13) sí se calcula", () => {
    expect(calcularPapelProvisional(entrada({ regimen: "626", facturas: [factura({ base: 3_000_000 })] })).isr.determinadoCentavos).toBe(33_000);
  });
  it("612 con RFC de persona moral es no soportado", () => {
    const p = calcularPapelProvisional(entrada({ regimen: "612", rfc: "ABC010101AB1", facturas: [factura({ base: 3_000_000 })] }));
    expect(p.isr.estado).toBe("no_soportado");
  });
  it("612 usa la tabla del ejercicio: 2025 difiere de 2026; un ejercicio sin tabla es no soportado", () => {
    const f2025 = [factura({ base: 20_000_000, fecha: "2025-01-10" })];
    const p2025 = calcularPapelProvisional(entrada({ ejercicio: 2025, mes: 1, regimen: "612", facturas: f2025 }));
    const f2026 = [factura({ base: 20_000_000, fecha: "2026-01-10" })];
    const p2026 = calcularPapelProvisional(entrada({ ejercicio: 2026, mes: 1, regimen: "612", facturas: f2026 }));
    expect(p2025.isr.determinadoCentavos).toBe(isrTarifaAcumuladaCentavos(20_000_000, 1, ISR_MENSUAL_2025));
    expect(p2026.isr.determinadoCentavos).toBe(isrTarifaAcumuladaCentavos(20_000_000, 1, ISR_MENSUAL_2026));
    expect(p2025.isr.determinadoCentavos).not.toBe(p2026.isr.determinadoCentavos);
    const p2027 = calcularPapelProvisional(entrada({ ejercicio: 2027, mes: 1, regimen: "612", facturas: [factura({ base: 20_000_000, fecha: "2027-01-10" })] }));
    expect(p2027.isr.estado).toBe("no_soportado");
    expect(p2027.isr.motivo).toMatch(/2027/);
    expect(p2027.isr.determinadoCentavos).toBe(0);
  });
  it("tipoPersonaPorRfc distingue por longitud", () => {
    expect(tipoPersonaPorRfc("ABC010101AB1")).toBe("moral");
    expect(tipoPersonaPorRfc("ABCD010101AB1")).toBe("fisica");
    expect(tipoPersonaPorRfc("")).toBeNull();
    expect(tipoPersonaPorRfc(null)).toBeNull();
  });
});

describe("régimen sin papel modelado", () => {
  it("603 no calcula ISR (lo dice) y el IVA sigue calculándose", () => {
    const p = calcularPapelProvisional(entrada({ regimen: "603", facturas: [factura({})] }));
    expect(p.isr.estado).toBe("no_soportado");
    expect(p.isr.motivo).toMatch(/no está modelado/);
    expect(p.iva.estado).toBe("calculado");
  });
});

describe("flujo de efectivo: PPD por complemento de pago", () => {
  const ppd = factura({ id: "ppd1", metodoPago: "PPD", formaPago: "99", base: 5_000_000, fecha: "2026-06-20" });
  const pago = (parcial: Partial<PagoRepProvisional>): PagoRepProvisional => ({ invoiceId: "ppd1", fechaPago: "2026-07-15", flujo: "trasladado", importePagadoCentavos: 2_900_000, baseCentavos: 2_500_000, ivaCentavos: 400_000, ivaRetenidoCentavos: 0, ...parcial });

  it("flujo (612 e IVA): el CFDI PPD NO cuenta el día de su emisión; cuenta por el pago, en el mes del pago", () => {
    const sinPago = calcularPapelProvisional(entrada({ mes: 6, regimen: "612", facturas: [ppd] }));
    expect(sinPago.isr.baseCentavos).toBe(0);
    expect(sinPago.pendientesPpd).toEqual({ cantidad: 1, importeCentavos: 5_800_000 });
    expect(sinPago.advertencias.join(" ")).toMatch(/no tienen complemento de pago/);

    const julio = calcularPapelProvisional(entrada({ mes: 7, regimen: "612", facturas: [ppd], pagos: [pago({})] }));
    expect(julio.isr.baseCentavos).toBe(2_500_000);
    expect(julio.iva.lineas.find((l) => l.clave === "trasladado")?.centavos).toBe(400_000);
    expect(julio.pendientesPpd.cantidad).toBe(0);
  });

  it("un pago de agosto no entra al papel de julio", () => {
    const p = calcularPapelProvisional(entrada({ mes: 7, regimen: "612", facturas: [ppd], pagos: [pago({ fechaPago: "2026-08-02" })] }));
    expect(p.isr.baseCentavos).toBe(0);
  });

  it("un PPD pagado en julio cuyo CFDI es de un mes anterior del ejercicio SÍ entra al IVA de julio (por la fecha de pago)", () => {
    const p = calcularPapelProvisional(entrada({ mes: 7, facturas: [ppd], pagos: [pago({})] }));
    expect(p.iva.determinadoCentavos).toBe(400_000);
  });

  it("PPD recibido: el IVA se acredita en el mes del pago", () => {
    const rec = factura({ id: "ppd2", direccion: "recibido", metodoPago: "PPD", formaPago: "99", base: 1_000_000, fecha: "2026-05-02" });
    const p = calcularPapelProvisional(entrada({ facturas: [rec], pagos: [pago({ invoiceId: "ppd2", flujo: "acreditable", importePagadoCentavos: 580_000, baseCentavos: 500_000, ivaCentavos: 80_000 })] }));
    expect(p.iva.acreditableCentavos).toBe(80_000);
    expect(p.iva.aFavorCentavos).toBe(80_000);
  });

  it("sin la migración de pagos (pagosDisponibles=false) los PPD se excluyen y se advierte", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [ppd], pagosDisponibles: false }));
    expect(p.advertencias.join(" ")).toMatch(/REP\) no están disponibles/);
    expect(p.exclusiones[0]?.motivo).toMatch(/migración pendiente/);
  });

  it("la retención de ISR de un PPD se prorratea al pago", () => {
    const f = factura({ id: "ppd3", metodoPago: "PPD", base: 10_000_000, ivaTrasladadoCentavos: 1_600_000, isrRetenidoCentavos: 1_000_000, fecha: "2026-07-01" });
    const p = calcularPapelProvisional(
      entrada({ regimen: "612", facturas: [f], pagos: [{ invoiceId: "ppd3", fechaPago: "2026-07-20", flujo: "trasladado", importePagadoCentavos: 5_300_000, baseCentavos: 5_000_000, ivaCentavos: 800_000, ivaRetenidoCentavos: 0 }] }),
    );
    expect(p.isr.lineas.find((l) => l.clave === "retenciones")?.centavos).toBe(456_897); // 1,000,000 x 5,300,000 / 11,600,000 = 456,896.55 -> mitad hacia arriba
  });
});

describe("exclusiones (cada una con su motivo e importe)", () => {
  const e = (fs: FacturaProvisional[]) => calcularPapelProvisional(entrada({ facturas: fs, isr: { coeficienteUtilidad: "1" } }));
  it.each([
    ["cancelado", { estadoSat: "cancelado" as const }, /cancelado/],
    ["no encontrado", { estadoSat: "no_encontrado" as const }, /no encontrado/],
    ["moneda extranjera", { moneda: "USD" }, /moneda extranjera/],
    ["sin método de pago", { metodoPago: null }, /sin método de pago/],
    ["sentido indeterminado", { direccion: "indeterminado" as const }, /indeterminado/],
    ["sin centavos", { totalCentavos: null }, /sin montos en centavos/],
  ])("%s", (_n, parcial, motivo) => {
    const p = e([factura(parcial as Partial<FacturaProvisional>)]);
    expect(p.exclusiones).toHaveLength(1);
    expect(p.exclusiones[0]!.motivo).toMatch(motivo);
    expect(p.exclusiones[0]!.cantidad).toBe(1);
    expect(p.isr.baseCentavos).toBe(0);
  });

  it("deducciones: efectivo > $2,000, uso personal, CFDI inválido (EFOS) y recibidos cancelados no se deducen ni acreditan", () => {
    const p = calcularPapelProvisional(
      entrada({
        regimen: "612",
        facturas: [
          factura({ base: 10_000_000 }),
          factura({ direccion: "recibido", base: 1_000_000, formaPago: "01" }), // efectivo, 11,600.00 > 2,000
          factura({ direccion: "recibido", base: 1_000_000, usoCfdi: "D01" }),
          factura({ direccion: "recibido", base: 1_000_000, valido: false }),
          factura({ direccion: "recibido", base: 1_000_000, estadoSat: "cancelado" }),
          factura({ direccion: "recibido", base: 100_000, ivaTrasladadoCentavos: 16_000, totalCentavos: 116_000, formaPago: "01" }), // efectivo de 1,160.00: sí se deduce
        ],
      }),
    );
    const motivos = p.exclusiones.map((x) => x.motivo);
    expect(motivos.some((m) => /efectivo/.test(m))).toBe(true);
    expect(motivos.some((m) => /personal/.test(m))).toBe(true);
    expect(motivos.some((m) => /69-B/.test(m))).toBe(true);
    expect(motivos.some((m) => /cancelado/.test(m))).toBe(true);
    expect(p.exclusiones.every((x) => x.cantidad === 1 && x.importeCentavos === 1_160_000)).toBe(true);
    expect(p.isr.lineas.find((l) => l.clave === "deducciones")?.centavos).toBe(100_000);
    expect(p.iva.acreditableCentavos).toBe(16_000);
  });

  it("el efectivo de un ingreso emitido NO se excluye (solo limita deducciones)", () => {
    const p = e([factura({ base: 1_000_000, formaPago: "01" })]);
    expect(p.isr.baseCentavos).toBe(1_000_000);
  });

  it("inversiones (uso I0x): no se deducen de golpe pero su IVA se acredita; se advierte", () => {
    const p = calcularPapelProvisional(entrada({ regimen: "612", facturas: [factura({ base: 10_000_000 }), factura({ direccion: "recibido", base: 5_000_000, usoCfdi: "I01" })] }));
    expect(p.isr.lineas.find((l) => l.clave === "deducciones")?.centavos).toBe(0);
    expect(p.iva.acreditableCentavos).toBe(800_000);
    expect(p.advertencias.join(" ")).toMatch(/inversiones/);
  });

  it("nota de crédito emitida (E, PUE) resta de los ingresos y del IVA trasladado", () => {
    const p = calcularPapelProvisional(entrada({ regimen: "612", facturas: [factura({ base: 10_000_000 }), factura({ tipo: "E", base: 2_000_000 })] }));
    expect(p.isr.lineas.find((l) => l.clave === "ingresos")?.centavos).toBe(8_000_000);
    expect(p.iva.lineas.find((l) => l.clave === "trasladado")?.centavos).toBe(1_280_000);
  });

  it("nómina emitida por el cliente se deduce (612)", () => {
    const p = calcularPapelProvisional(entrada({ regimen: "612", facturas: [factura({ base: 10_000_000 }), factura({ tipo: "N", base: 3_000_000, ivaTrasladadoCentavos: 0, totalCentavos: 3_000_000 })] }));
    expect(p.isr.lineas.find((l) => l.clave === "deducciones")?.centavos).toBe(3_000_000);
  });

  it("traslados (T) y pagos (P) no son ingreso ni deducción", () => {
    const p = e([factura({ tipo: "T" }), factura({ tipo: "P" })]);
    expect(p.documentosIncluidos).toBe(0);
    expect(p.exclusiones).toHaveLength(0);
  });

  it("CFDI de otro ejercicio o de meses posteriores al del papel no cuentan", () => {
    const p = e([factura({ fecha: "2025-12-30" }), factura({ fecha: "2026-08-01" })]);
    expect(p.documentosIncluidos).toBe(0);
  });
});

describe("IVA: saldo a favor y retenciones", () => {
  it("el saldo a favor del mes anterior presentado se acredita; el manual solo si no hay papel anterior", () => {
    const base = { facturas: [factura({ base: 1_000_000 })] };
    expect(calcularPapelProvisional(entrada({ ...base, saldoFavorIvaMesAnteriorCentavos: 100_000 })).iva.aCargoCentavos).toBe(60_000);
    expect(calcularPapelProvisional(entrada({ ...base, saldoFavorIvaMesAnteriorCentavos: null, iva: { saldoFavorAnteriorCentavos: 50_000 } })).iva.aCargoCentavos).toBe(110_000);
    expect(calcularPapelProvisional(entrada({ ...base, saldoFavorIvaMesAnteriorCentavos: 0, iva: { saldoFavorAnteriorCentavos: 50_000 } })).iva.aCargoCentavos).toBe(160_000);
  });
  it("IVA retenido por clientes se acredita contra el trasladado", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [factura({ base: 1_000_000, ivaRetenidoCentavos: 106_667 })] }));
    expect(p.iva.aCargoCentavos).toBe(53_333);
  });
  it("sin movimientos: todo en cero, nunca un NaN", () => {
    const p = calcularPapelProvisional(entrada({ isr: { coeficienteUtilidad: "0.3" } }));
    expect(p.isr).toMatchObject({ baseCentavos: 0, determinadoCentavos: 0, aCargoCentavos: 0, aFavorCentavos: 0 });
    expect(p.iva).toMatchObject({ determinadoCentavos: 0, aCargoCentavos: 0, aFavorCentavos: 0 });
  });
});

// D-P3-06 (brief paridad3-despachos-fiscal-correcciones): IVA acreditable proporcional (LIVA 5-V) y alerta "acreditable > 3x trasladado".
describe("IVA proporcional con actos exentos (LIVA 5-V)", () => {
  const emitido = factura({ base: 1_000_000 }); // IVA trasladado 160,000
  const recibido = factura({ base: 500_000, direccion: "recibido" }); // IVA acreditable 80,000
  it("sin actos exentos registrados: acredita al 100 % y lo dice con la bandera visible", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [emitido, recibido] }));
    expect(p.iva.acreditableCentavos).toBe(80_000);
    expect(p.iva.aCargoCentavos).toBe(80_000);
    expect(p.advertencias).toContain("Proporción no aplicada: sin actos exentos registrados. El IVA acreditable se tomó al 100 %; si el cliente realiza actos exentos captura actosExentosCentavos (LIVA 5-V).");
  });
  it("con exentos: gravados de los CFDI emitidos (1,000,000) y exentos 250,000 -> proporcion 80 % y acreditable 64,000", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [emitido, recibido], iva: { actosExentosCentavos: 250_000 } }));
    expect(p.iva.acreditableCentavos).toBe(64_000);
    expect(p.iva.aCargoCentavos).toBe(96_000);
    expect(p.iva.lineas.find((l) => l.clave === "acreditable")).toMatchObject({ centavos: 64_000 });
    expect(p.iva.lineas.find((l) => l.clave === "acreditable")!.detalle).toContain("80.00 %");
    expect(p.advertencias.some((a) => a.startsWith("Proporción no aplicada"))).toBe(false);
    expect(p.advertencias.some((a) => a.includes("los actos gravados se tomaron de la base de los CFDI emitidos"))).toBe(true);
  });
  it("con gravados capturados la proporcion usa lo capturado (750,000 / 1,000,000 = 75 %)", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [emitido, recibido], iva: { actosGravadosCentavos: 750_000, actosExentosCentavos: 250_000 } }));
    expect(p.iva.acreditableCentavos).toBe(60_000);
    expect(p.advertencias.some((a) => a.includes("los actos gravados se tomaron"))).toBe(false);
  });
  it("todo exento y sin gravados: acreditable 0 (proporcion 0 %), nunca un NaN", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [recibido], iva: { actosExentosCentavos: 100_000 } }));
    expect(p.iva.acreditableCentavos).toBe(0);
    expect(p.iva.aFavorCentavos).toBe(0);
  });
});

describe("alerta: IVA acreditable mayor a 3 veces el trasladado", () => {
  it("496,000 acreditable contra 160,000 trasladado (3.1x) avisa; 3.0x exacto no", () => {
    const emitido = factura({ base: 1_000_000 });
    const avisa = calcularPapelProvisional(entrada({ facturas: [emitido, factura({ base: 3_100_000, direccion: "recibido" })] }));
    expect(avisa.advertencias.some((a) => a.includes("mayor a 3 veces el IVA trasladado"))).toBe(true);
    const noAvisa = calcularPapelProvisional(entrada({ facturas: [emitido, factura({ base: 3_000_000, direccion: "recibido" })] }));
    expect(noAvisa.advertencias.some((a) => a.includes("mayor a 3 veces"))).toBe(false);
  });
  it("sin IVA trasladado no se dispara (no hay base de comparacion)", () => {
    const p = calcularPapelProvisional(entrada({ facturas: [factura({ base: 3_100_000, direccion: "recibido" })] }));
    expect(p.advertencias.some((a) => a.includes("mayor a 3 veces"))).toBe(false);
  });
});
