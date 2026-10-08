// Composición del motor de nómina 2026: ISR + subsidio %UMA + IMSS por rama + prestaciones con exentos.
// Las cifras de ISR salen de la tarifa ya cubierta por nomina-isr.golden.spec.ts; aquí se prueba la composición.
import { describe, expect, it } from "vitest";
import { calcularIsrNomina } from "../src/nomina/isr-nomina-engine.ts";
import { aniosCompletos, calcularImpuestosNomina, calcularImpuestosNominaDetalle, NominaInvalidaError, procesarNomina } from "../src/nomina/payroll-engine.ts";
import { VigenciaNoSoportadaError } from "../src/nomina/parametros.ts";

const F = "2026-02-28";

describe("calcularImpuestosNomina", () => {
  it("salario medio (15,000): sin subsidio (arriba del tope), ISR de tarifa y SBC con factor 1.0493", () => {
    const d = calcularImpuestosNominaDetalle({ fechaPago: F, salary: 15000 });
    expect(d.taxes.subsidioCausado).toBe(0);
    expect(d.taxes.isr).toBe(1402.82);
    expect(d.factorIntegracion).toBe(1.0493);
    expect(d.sbcDiario).toBe(524.65); // 500 × 1.0493
    expect(d.taxes.infonavit).toBe(786.98); // 524.65 × 30 × 5 % = 786.975
    expect(d.taxes.total).toBe(Math.round((d.taxes.isr + d.taxes.imssObrero + d.taxes.infonavit) * 100) / 100);
  });

  it("salario bajo (9,000): el subsidio de 535.65 reduce el ISR y nunca lo deja negativo", () => {
    const t = calcularImpuestosNomina({ fechaPago: F, salary: 9000 });
    expect(t.subsidioCausado).toBe(535.65);
    expect(t.isrCausado).toBe(calcularIsrNomina(9000));
    expect(t.isr).toBe(Math.max(0, Math.round((t.isrCausado - 535.65) * 100) / 100));
    const bajo = calcularImpuestosNomina({ fechaPago: F, salary: 3000 });
    expect(bajo.isr).toBe(0);
    expect(bajo.subsidioCausado).toBe(535.65); // se causa aunque exceda el ISR; el excedente no se paga en efectivo
  });

  it("enero y febrero difieren en subsidio y UMA", () => {
    const ene = calcularImpuestosNomina({ fechaPago: "2026-01-31", salary: 9000 });
    const feb = calcularImpuestosNomina({ fechaPago: "2026-02-01", salary: 9000 });
    expect(ene.subsidioCausado).toBe(536.21);
    expect(feb.subsidioCausado).toBe(535.65);
    expect(ene.imss.umaDiaria).toBe(113.14);
    expect(feb.imss.umaDiaria).toBe(117.31);
  });

  it("quincenal: salarioBruto es el sueldo de la QUINCENA (4,500 equivale a 9,000 mensuales): ISR/2, subsidio 15/30.4 y SBC sobre salario/15", () => {
    const q = calcularImpuestosNominaDetalle({ fechaPago: "2026-02-15", salary: 4500, periodicidad: "quincenal" });
    expect(q.taxes.subsidioCausado).toBe(264.3);
    expect(q.taxes.isrCausado).toBe(Math.round((calcularIsrNomina(9000) / 2) * 100) / 100);
    expect(q.salarioDiarioCalculado).toBe(300);
    const m = calcularImpuestosNominaDetalle({ fechaPago: "2026-02-15", salary: 9000 });
    expect(q.sbcDiario).toBe(m.sbcDiario);
  });

  it("quincenal usa 15 días por omisión en IMSS e Infonavit: la mitad de lo mensual para el mismo sueldo mensual equivalente", () => {
    const q = calcularImpuestosNominaDetalle({ fechaPago: "2026-02-15", salary: 7500, periodicidad: "quincenal" });
    expect(q.diasPagados).toBe(15);
    const m = calcularImpuestosNominaDetalle({ fechaPago: "2026-02-15", salary: 15000 });
    expect(q.taxes.infonavit).toBeCloseTo(m.taxes.infonavit / 2, 1);
  });

  it("quincenal de punta a punta: neto, totalBruto y deducciones cuadran con el sueldo de la quincena (no con el mensual)", () => {
    const p = procesarNomina({ month: 2, year: 2026, periodicidad: "quincenal", fechaPago: "2026-02-15" }, [{ employeeId: "E1", nombre: "Ana", salarioBruto: 4500, percepciones: 500 }]);
    const e = p.employees[0]!;
    expect(e.diasPagados).toBe(15);
    expect(p.totalBruto).toBe(5000);
    expect(e.neto).toBe(Math.round((5000 - e.taxes.isr - e.taxes.imssObrero) * 100) / 100);
    // neto razonable: nunca más que la quincena bruta ni menos del 85 % de ella para este sueldo
    expect(e.neto).toBeLessThanOrEqual(5000);
    expect(e.neto).toBeGreaterThan(4250);
    // ISR causado quincenal = ISR mensual del ingreso x2, entre 2
    expect(e.taxes.isrCausado).toBe(Math.round((calcularIsrNomina(10000) / 2) * 100) / 100);
  });

  it("el error de un renglón dice qué empleado es", () => {
    expect(() => procesarNomina({ month: 2, year: 2026 }, [{ employeeId: "E7", nombre: "Luis" }])).toThrow(/employees\[0\] \(Luis\)/);
  });

  it("SBC explícito reemplaza el factor de integración", () => {
    const d = calcularImpuestosNominaDetalle({ fechaPago: F, salary: 15000, sbc: 600 });
    expect(d.sbcDiario).toBe(600);
    expect(d.factorIntegracion).toBeNull();
  });

  it("la antigüedad cambia el factor (6 años = 1.0562)", () => {
    expect(calcularImpuestosNominaDetalle({ fechaPago: F, salary: 15000, antiguedadAnios: 6 }).factorIntegracion).toBe(1.0562);
  });

  it("aguinaldo de 10,000: 3,519.30 exento (30 UMA) y 6,480.70 gravado se suma al ingreso", () => {
    const d = calcularImpuestosNominaDetalle({ fechaPago: "2026-12-20", salary: 15000, conceptos: { aguinaldo: 10000 } });
    expect(d.conceptos.aguinaldo).toEqual({ total: 10000, exento: 3519.3, gravado: 6480.7 });
    expect(d.taxes.isrCausado).toBe(calcularIsrNomina(15000 + 6480.7));
  });

  it("descuento por incapacidad baja el ingreso gravable", () => {
    const d = calcularImpuestosNominaDetalle({ fechaPago: F, salary: 15000, conceptos: { incapacidades: [{ dias: 3, tipo: "02", importe: 1000 }] } });
    expect(d.conceptos.descuentoIncapacidad).toBe(1000);
    expect(d.taxes.isrCausado).toBe(calcularIsrNomina(14000));
  });

  it("rechaza fechas sin vigencia cargada y conceptos inválidos", () => {
    expect(() => calcularImpuestosNomina({ fechaPago: "2025-12-31", salary: 15000 })).toThrow(VigenciaNoSoportadaError);
    expect(() => calcularImpuestosNomina({ fechaPago: F, salary: 15000, conceptos: { aguinaldo: -1 } })).toThrow(NominaInvalidaError);
    expect(() => calcularImpuestosNomina({ fechaPago: F, salary: 15000, conceptos: { horasExtra: [{ dias: 0, tipo: "01", horas: 1, importe: 1 }] } })).toThrow(NominaInvalidaError);
    expect(() => calcularImpuestosNomina({ fechaPago: F, salary: 0 })).toThrow(); // SBC <= 0
  });
});

describe("procesarNomina", () => {
  it("la fecha de pago por omisión es el último día del mes y define la vigencia", () => {
    const p = procesarNomina({ month: 1, year: 2026 }, [{ employeeId: "e1", nombre: "Ana", salarioBruto: 9000 }]);
    expect(p.fechaPago).toBe("2026-01-31");
    expect(p.employees[0]!.taxes.subsidioCausado).toBe(536.21);
    const q = procesarNomina({ month: 2, year: 2026 }, [{ employeeId: "e1", nombre: "Ana", salarioBruto: 9000 }]);
    expect(q.fechaPago).toBe("2026-02-28");
    expect(q.employees[0]!.taxes.subsidioCausado).toBe(535.65);
  });

  it("antigüedad desde la fecha de inicio de relación laboral a la fecha de pago", () => {
    expect(aniosCompletos("2020-03-01", "2026-02-28")).toBe(5);
    expect(aniosCompletos("2020-02-28", "2026-02-28")).toBe(6);
    expect(aniosCompletos("2027-01-01", "2026-02-28")).toBe(0);
    const p = procesarNomina({ month: 2, year: 2026 }, [{ salarioBruto: 15000, fechaInicioRelLaboral: "2020-03-01" }]);
    expect(p.employees[0]!.antiguedadAnios).toBe(5);
    expect(p.employees[0]!.taxes.imss.sbcDiario).toBe(527.4); // 500 × 1.0548
  });

  it("totales, neto sin ISR negativo e infonavit patronal fuera de las deducciones", () => {
    const p = procesarNomina({ month: 2, year: 2026 }, [
      { employeeId: "a", nombre: "A", salarioBruto: 15000 },
      { employeeId: "b", nombre: "B", salarioBruto: 3000 },
    ]);
    const [a, b] = p.employees;
    expect(a!.deducciones).toBe(Math.round((a!.taxes.isr + a!.taxes.imssObrero) * 100) / 100);
    expect(a!.neto).toBe(Math.round((15000 - a!.deducciones) * 100) / 100);
    expect(p.totalIsr).toBe(Math.round((a!.taxes.isr + b!.taxes.isr) * 100) / 100);
    expect(p.totalSubsidioCausado).toBe(535.65);
    expect(p.idempotencyKey).toBe("nomina-2026-02-None");
    expect(procesarNomina({ month: 2, year: 2026 }, [], 7).idempotencyKey).toBe("nomina-2026-02-7");
  });

  it("concepto percibido entra al bruto y al neto", () => {
    const p = procesarNomina({ month: 12, year: 2026 }, [{ salarioBruto: 15000, conceptos: { aguinaldo: 3000 } }]);
    const e = p.employees[0]!;
    expect(p.totalBruto).toBe(18000);
    expect(e.neto).toBe(Math.round((18000 - e.deducciones) * 100) / 100);
  });

  it("mes inválido o fecha de pago mal formada lanzan error", () => {
    expect(() => procesarNomina({ month: 13 }, [])).toThrow(NominaInvalidaError);
    expect(() => procesarNomina({ month: 1, fechaPago: "hoy" }, [])).toThrow(NominaInvalidaError);
  });
});
