// Golden-set numérico: motor de nómina end-to-end (Fase 3 despachos) —
// compara `calcularImpuestosNomina` contra `calculate_taxes` (13 casos),
// `procesarNomina` contra `process_payroll` (4 casos), y
// `calcularAguinaldo`/`calcularPrimaVacacional` contra sus equivalentes
// Python (6 casos) — capturado en tests/fixtures/golden-nomina-output.json.
//
// CORRECCIÓN FISCAL (auditoría, hallazgo CRÍTICO #1): la fixture de arriba capturó
// el ISR de nómina con la tabla ANTERIOR (ver declaraciones/isr-tablas.ts), que no
// coincidía con el Anexo 8 SAT/DOF real. IMSS/Infonavit (imss-engine.ts) NO se
// tocaron en esta corrección y siguen coincidiendo con la fixture bit a bit
// (verificado) — solo `isr`/`total`/`deducciones`/`neto` (todo lo que arrastra el
// ISR corregido) cambian. `ISR_CORREGIDO` abajo trae los valores de `isr`/`total`
// ya recalculados con la tabla corregida (mismo criterio que
// nomina-isr.golden.spec.ts: valores verificados directamente, no contra la
// fixture vieja) para los casos donde difieren; el resto de cada `resultado`
// (imssPatronal/imssObrero/infonavit) se sigue comparando contra la fixture, que
// ahí sigue siendo válida.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-nomina-output.json" with { type: "json" };
import { calcularImpuestosNomina, procesarNomina } from "../src/nomina/payroll-engine.ts";
import { calcularAguinaldo, calcularPrimaVacacional } from "../src/nomina/prestaciones.ts";
import type { Periodicidad } from "../src/nomina/subsidio-empleo.ts";

/** isr/total recalculados con la tabla ISR de nómina corregida (Anexo 8 RMF 2026),
 * para los nombres de caso de la fixture cuyo ISR original ya no coincide.
 * imssPatronal/imssObrero/infonavit de cada caso NO cambiaron (verificado
 * directamente contra la fixture) y se siguen leyendo de ahí. */
const ISR_CORREGIDO: Record<string, { isr: number; total: number }> = {
  e2e_salario_medio_15000: { isr: 1402.82, total: 2340.32 },
  e2e_salario_dias31: { isr: 1402.82, total: 2371.57 },
  e2e_salario_topa_sbc: { isr: 24630.83, total: 30129.73 },
  e2e_salario_anula_subsidio: { isr: 2383.65, total: 3633.65 },
  e2e_salario_con_benefits: { isr: 1761.22, total: 2698.72 },
  e2e_salario_quincenal_vs_mensual_base: { isr: 4519.65, total: 5457.15 },
  e2e_salario_quincenal_real: { isr: 2259.82, total: 3197.32 },
  e2e_salario_alto_500000: { isr: 159513.84, total: 165012.74 },
};

type GoldenTaxes = {
  entrada: { salary: number; benefits: number; salaryPerDay: number; diasPagados: number; periodicidad: Periodicidad };
  resultado: { isr: number; imss_patronal: number; imss_obrero: number; infonavit: number; total: number };
};

type GoldenPayrollTaxes = { isr: number; imss_patronal: number; imss_obrero: number; infonavit: number; total: number };
type GoldenEmployeePayroll = {
  employee_id: string;
  salario_diario: number;
  salario_bruto: number;
  percepciones: number;
  deducciones: number;
  taxes: GoldenPayrollTaxes;
  neto: number;
};
type GoldenProcessPayrollBasico = {
  resultado: {
    month: number;
    year: number;
    employee_count: number;
    employees: readonly GoldenEmployeePayroll[];
    totals: { bruto: number; neto: number; deducciones: number; isr: number; imss_patronal: number; imss_obrero: number; infonavit: number };
    tenant_id: number | null;
  };
};

const e2eEntries = Object.entries(golden).filter(([name]) => name.startsWith("e2e_") && name !== "e2e_cociente_500000_no_dispara_guard") as [string, unknown][];

describe("golden-set numérico: calcularImpuestosNomina (TS) vs calculate_taxes (Python real)", () => {
  for (const [name, raw] of e2eEntries) {
    const { entrada, resultado } = raw as GoldenTaxes;
    it(`${name}: salary=${entrada.salary} salaryPerDay=${entrada.salaryPerDay} periodicidad=${entrada.periodicidad}`, () => {
      const ts = calcularImpuestosNomina({
        salary: entrada.salary,
        benefits: entrada.benefits,
        salaryPerDay: entrada.salaryPerDay,
        diasPagados: entrada.diasPagados,
        periodicidad: entrada.periodicidad,
      });
      const corregido = ISR_CORREGIDO[name];
      expect(ts.isr).toBe(corregido ? corregido.isr : resultado.isr);
      expect(ts.imssPatronal).toBe(resultado.imss_patronal);
      expect(ts.imssObrero).toBe(resultado.imss_obrero);
      expect(ts.infonavit).toBe(resultado.infonavit);
      expect(ts.total).toBe(corregido ? corregido.total : resultado.total);
    });
  }

  it("rama quincenal vs mensual con el mismo salary_per_day=1000, dias=15: ISR quincenal = ISR mensual completo ÷ 2 (diseño §5.4, código muerto en producción hoy)", () => {
    const mensualIsr = ISR_CORREGIDO.e2e_salario_quincenal_vs_mensual_base!.isr;
    const quincenalIsr = ISR_CORREGIDO.e2e_salario_quincenal_real!.isr;
    expect(quincenalIsr).toBe(Math.round((mensualIsr / 2 + Number.EPSILON) * 100) / 100);

    const tsMensual = calcularImpuestosNomina({ salaryPerDay: 1000, diasPagados: 15, periodicidad: "mensual" });
    const tsQuincenal = calcularImpuestosNomina({ salaryPerDay: 1000, diasPagados: 15, periodicidad: "quincenal" });
    expect(tsMensual.isr).toBe(mensualIsr);
    expect(tsQuincenal.isr).toBe(quincenalIsr);
  });

  it("$500,000/mes: el cociente (isr+imssObrero)/bruto NUNCA cruza 0.4 (diseño §5.3, control inerte)", () => {
    const { resultado } = golden.e2e_cociente_500000_no_dispara_guard as unknown as { entrada: { salary: number }; resultado: { cociente: number; isr: number; imss_obrero: number } };
    const ts = calcularImpuestosNomina({ salary: 500000 });
    expect(ts.isr).toBe(ISR_CORREGIDO.e2e_salario_alto_500000!.isr);
    expect(ts.imssObrero).toBe(resultado.imss_obrero);
    const cociente = (ts.isr + ts.imssObrero) / 500000;
    expect(cociente).toBeLessThan(0.4);
  });
});

describe("golden-set numérico: procesarNomina (TS) vs process_payroll (Python real)", () => {
  const period = { month: 7, year: 2026, diasPagados: 30 };
  const employees = [
    { employeeId: "E1", nombre: "Empleado Uno", salarioBruto: 15000, percepciones: 0 },
    { employeeId: "E2", nombre: "Empleado Dos", salarioBruto: 30000, percepciones: 1000 },
  ];

  // CORRECCIÓN FISCAL (auditoría, hallazgo CRÍTICO #1): isr/deducciones/neto (y los
  // totales que los arrastran) se recalcularon con la tabla ISR de nómina
  // corregida -- valores verificados directamente con `procesarNomina` real (mismo
  // criterio que ISR_CORREGIDO arriba). imssPatronal/imssObrero/infonavit NO
  // cambiaron y se siguen comparando contra la fixture.
  it("process_payroll_basico: totales y desglose por empleado coinciden campo por campo", () => {
    const golden_ = golden.process_payroll_basico as unknown as GoldenProcessPayrollBasico;
    const ts = procesarNomina(period, employees, 42);

    expect(ts.month).toBe(golden_.resultado.month);
    expect(ts.year).toBe(golden_.resultado.year);
    expect(ts.employees.length).toBe(golden_.resultado.employee_count);

    const isrCorregidoPorEmpleado = [1402.82, 4733.25];
    const deduccionesCorregidasPorEmpleado = [1590.32, 5108.25];
    const totalTaxesCorregidoPorEmpleado = [2340.32, 6608.25];
    const netoCorregidoPorEmpleado = [13409.68, 25891.75];

    golden_.resultado.employees.forEach((pyEmp, idx) => {
      const tsEmp = ts.employees[idx]!;
      expect(tsEmp.employeeId).toBe(pyEmp.employee_id);
      expect(tsEmp.salarioDiario).toBe(pyEmp.salario_diario);
      expect(tsEmp.salarioBruto).toBe(pyEmp.salario_bruto);
      expect(tsEmp.percepciones).toBe(pyEmp.percepciones);
      expect(tsEmp.deducciones).toBe(deduccionesCorregidasPorEmpleado[idx]);
      expect(tsEmp.taxes.isr).toBe(isrCorregidoPorEmpleado[idx]);
      expect(tsEmp.taxes.imssPatronal).toBe(pyEmp.taxes.imss_patronal);
      expect(tsEmp.taxes.imssObrero).toBe(pyEmp.taxes.imss_obrero);
      expect(tsEmp.taxes.infonavit).toBe(pyEmp.taxes.infonavit);
      expect(tsEmp.taxes.total).toBe(totalTaxesCorregidoPorEmpleado[idx]);
      expect(tsEmp.neto).toBe(netoCorregidoPorEmpleado[idx]);
    });

    expect(ts.totalBruto).toBe(golden_.resultado.totals.bruto);
    expect(ts.totalNeto).toBe(39301.43);
    expect(ts.totalDeducciones).toBe(6698.57);
    expect(ts.totalIsr).toBe(6136.07);
    expect(ts.totalImssPatronal).toBe(golden_.resultado.totals.imss_patronal);
    expect(ts.totalImssObrero).toBe(golden_.resultado.totals.imss_obrero);
    expect(ts.totalInfonavit).toBe(golden_.resultado.totals.infonavit);
    expect(ts.tenantId).toBe(golden_.resultado.tenant_id);
  });

  it("salario_diario del empleado NUNCA se recalcula desde salario_bruto/30, incluso si el IMSS sí se calculó sobre ese valor internamente (fidelidad, ver types.ts)", () => {
    const ts = procesarNomina(period, employees, 42);
    expect(ts.employees[0]!.salarioDiario).toBe(0);
    // El IMSS SÍ se calculó sobre 15000/30 = 500 internamente:
    expect(ts.employees[0]!.taxes.imssObrero).toBeCloseTo(500 * 30 * 0.0125, 9);
  });

  it("idempotencyKey es determinística (misma entrada -> misma clave)", () => {
    const golden_ = golden.process_payroll_idempotencia as unknown as { resultado: { idempotency_key_1: string; idempotency_key_2: string; iguales: boolean } };
    expect(golden_.resultado.iguales).toBe(true);
    const ts1 = procesarNomina(period, employees, 42);
    const ts2 = procesarNomina(period, employees, 42);
    expect(ts1.idempotencyKey).toBe(golden_.resultado.idempotency_key_1);
    expect(ts2.idempotencyKey).toBe(golden_.resultado.idempotency_key_2);
  });

  it('sin tenant_id, la clave interpola literalmente "None" (f-string de Python) — no "null" ni cadena vacía', () => {
    const golden_ = golden.process_payroll_sin_tenant_id as unknown as { resultado: { idempotency_key: string } };
    expect(golden_.resultado.idempotency_key).toBe("nomina-2026-07-None");
    const ts = procesarNomina(period, employees, null);
    expect(ts.idempotencyKey).toBe(golden_.resultado.idempotency_key);
  });

  // CORRECCIÓN FISCAL (auditoría, hallazgo CRÍTICO #1): total_deducciones (arrastra
  // el ISR corregido) ya no coincide con la fixture -- valor verificado
  // directamente (335613.62, ver ISR_CORREGIDO/comentario de cabecera). El punto
  // real de este caso (requiresHumanReview nunca se activa, ni a $1,000,000/mes) no
  // depende de la tabla ISR y sigue intacto.
  it("requiresHumanReview NUNCA se activa, ni con un salario de $1,000,000/mes (diseño §5.3, control matemáticamente inalcanzable)", () => {
    const golden_ = golden.process_payroll_extremo_no_dispara_review as unknown as {
      resultado: { requires_human_review: boolean; total_bruto: number; total_deducciones: number; cociente: number };
    };
    expect(golden_.resultado.requires_human_review).toBe(false);

    const ts = procesarNomina(period, [{ employeeId: "E3", nombre: "Empleado Extremo", salarioBruto: 1000000, percepciones: 0 }], 1);
    expect(ts.requiresHumanReview).toBe(false);
    expect(ts.humanReviewReason).toBe("");
    expect(ts.totalBruto).toBe(golden_.resultado.total_bruto);
    expect(ts.totalDeducciones).toBe(335613.62);
    const cociente = ts.totalDeducciones / ts.totalBruto;
    expect(cociente).toBeLessThan(0.4);
  });
});

type GoldenAguinaldo = { resultado: { aguinaldo: number } };
type GoldenPrimaVacacional = { resultado: { primaVacacional: number } };

describe("golden-set numérico: prestaciones (TS) vs calculate_aguinaldo/calculate_prima_vacacional (Python real)", () => {
  it("aguinaldo: 0 días, negativo, estándar 15 días", () => {
    expect(calcularAguinaldo(500, 0)).toBe((golden.aguinaldo_cero_dias as unknown as GoldenAguinaldo).resultado.aguinaldo);
    expect(calcularAguinaldo(-500, 15)).toBe((golden.aguinaldo_negativo as unknown as GoldenAguinaldo).resultado.aguinaldo);
    expect(calcularAguinaldo(500)).toBe((golden.aguinaldo_estandar_15dias as unknown as GoldenAguinaldo).resultado.aguinaldo);
    expect(calcularAguinaldo(-500, 15)).toBe(0);
  });

  it("prima vacacional: 0 días, negativo, estándar 6 días / 25%", () => {
    expect(calcularPrimaVacacional(500, 0)).toBe((golden.prima_vacacional_cero_dias as unknown as GoldenPrimaVacacional).resultado.primaVacacional);
    expect(calcularPrimaVacacional(-500)).toBe((golden.prima_vacacional_negativo as unknown as GoldenPrimaVacacional).resultado.primaVacacional);
    expect(calcularPrimaVacacional(500)).toBe((golden.prima_vacacional_estandar_6dias_25pct as unknown as GoldenPrimaVacacional).resultado.primaVacacional);
    expect(calcularPrimaVacacional(-500)).toBe(0);
  });
});
