// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE NÓMINA — composición — puerto 1:1 de `calculate_taxes` y
// `process_payroll` de
// ~/Desktop/supabase/despachos/b2b_ai/features/nomina_completa/service.py.
// Puro, sin I/O, sin fechas de sistema. Compone isr-nomina-engine.ts +
// imss-engine.ts + subsidio-empleo.ts exactamente como el Python. Verificado
// campo por campo contra el intérprete real — ver
// tests/fixtures/golden_gen_nomina.py y tests/nomina-payroll-engine.golden.spec.ts.
import { calcularIsrNomina } from "./isr-nomina-engine.ts";
import { calcularImssObrero, calcularImssPatronal, calcularInfonavit } from "./imss-engine.ts";
import { calcularSubsidio } from "./subsidio-empleo.ts";
import { r2 } from "./redondeo.ts";
import type {
  EmployeePayroll,
  EmployeePayrollInput,
  OpcionesImpuestosNomina,
  PayrollPeriod,
  PayrollPeriodInput,
  PayrollTaxes,
} from "./types.ts";

/** Puerto de `calculate_taxes`. Calcula ISR, IMSS (obrero + patronal) e
 * INFONAVIT para un salario, aplicando subsidio al empleo.
 *
 * NOTA DE FIDELIDAD — subsidio_efectivo (diseño §3, aclaración no anticipada
 * por el diseño original): el Python calcula
 * `subsidio_efectivo = max(0.0, subsidio - isr)` pero JAMÁS lo asigna a
 * ningún campo de `PayrollTaxes` ni lo retorna de ninguna forma — es
 * literalmente una variable local descartada, confirmado leyendo
 * `calculate_taxes` completo. Este puerto no la calcula (no hay nada que
 * fielmente reproducir de un valor que el propio Python tira a la basura).
 *
 * NOTA DE FIDELIDAD — gravable en la rama quincenal usa la tabla de subsidio
 * "quincenal" con un ingreso a ESCALA MENSUAL (hallazgo adicional durante la
 * construcción, no anticipado por el diseño §3): `gravable` siempre se arma
 * como `salarioMensual + benefits` (nunca se divide entre 2), pero cuando
 * `periodicidad === "quincenal"` este mismo valor de escala mensual se pasa a
 * `calcularSubsidio(gravable, "quincenal")`, que compara contra los tramos de
 * `SUBSIDIO_EMPLEO_QUINCENAL_2026` (topes ~$1,000-$6,747) — casi cualquier
 * salario mensual real cae por encima del último tramo quincenal y el
 * subsidio sale en 0. Es el comportamiento real de `_calcular_subsidio`
 * llamada así desde `calculate_taxes`, verificado con el intérprete
 * (`e2e_salario_quincenal_real` en el golden-set). Se porta tal cual — es
 * más evidencia de que la rama quincenal es código no ejercitado y no
 * probado en el sistema de referencia (diseño §5.4), no un ajuste de este
 * puerto. */
export function calcularImpuestosNomina(opts: OpcionesImpuestosNomina = {}): PayrollTaxes {
  const salary = opts.salary ?? 0;
  const benefits = opts.benefits ?? 0;
  const salaryPerDay = opts.salaryPerDay ?? 0;
  const diasPagados = opts.diasPagados ?? 30;
  const periodicidad = opts.periodicidad ?? "mensual";

  let salarioMensual: number;
  let salarioDiario: number;
  if (salaryPerDay > 0) {
    salarioMensual = salaryPerDay * 30;
    salarioDiario = salaryPerDay;
  } else {
    salarioMensual = salary;
    salarioDiario = salary > 0 ? salary / 30 : 0;
  }

  const gravable = salarioMensual + benefits;

  let isr: number;
  if (periodicidad === "quincenal") {
    const isrMensual = calcularIsrNomina(gravable, false, opts.isrTabla);
    isr = r2(isrMensual / 2);
  } else {
    isr = calcularIsrNomina(gravable, false, opts.isrTabla);
  }

  const imssObrero = calcularImssObrero(salarioDiario, diasPagados);
  const imssPatronal = calcularImssPatronal(salarioDiario, diasPagados);
  const infonavit = calcularInfonavit(salarioDiario, diasPagados);

  const subsidio = calcularSubsidio(gravable, periodicidad, opts.subsidioTabla);
  const isrNeto = Math.max(0, isr - subsidio);

  const isrR = r2(isrNeto);
  const imssObreroR = r2(imssObrero);
  const imssPatronalR = r2(imssPatronal);
  const infonavitR = r2(infonavit);

  return {
    isr: isrR,
    imssPatronal: imssPatronalR,
    imssObrero: imssObreroR,
    infonavit: infonavitR,
    // Puerto de `PayrollTaxes.total`: el dataclass calcula
    // `self.isr + self.imss_obrero + self.infonavit` SIN redondear en
    // `__post_init__`, pero `to_dict()` (lo que cualquier consumidor real ve,
    // y lo que el golden-set capturó) aplica `round(self.total, 2)` al
    // serializar — una segunda pasada de redondeo sobre la suma, no solo
    // sobre los sumandos. Confirmado con el intérprete real: sin este
    // segundo redondeo, el ruido de punto flotante de la suma (p. ej.
    // 32600.499999999996) no coincide con el `32600.5` limpio que
    // `to_dict()` produce. Este puerto expone directamente el equivalente de
    // `to_dict()` (no hay una capa de serialización aparte), así que se
    // redondea aquí también.
    total: r2(isrR + imssObreroR + infonavitR),
  };
}

/** Puerto de `process_payroll`. Procesa la nómina completa de un periodo.
 *
 * NOTA DE FIDELIDAD — `idempotencyKey` con `tenantId` ausente: el f-string de
 * Python (`f"nomina-{year}-{month:02d}-{tenant_id}"`) interpola literalmente
 * la cadena `"None"` cuando `tenant_id is None` — se porta ese literal exacto
 * (verificado en el golden-set), no `"null"` ni cadena vacía.
 *
 * NOTA DE FIDELIDAD — `requiresHumanReview` es un control matemáticamente
 * inalcanzable (diseño §5.3): dispara si
 * `(isr+imssObrero)/bruto > 0.4`, pero con la tasa marginal máxima de ISR en
 * 35% y el IMSS obrero topado en términos absolutos (SBC topa a 25 UMA), el
 * cociente tiene una asíntota matemática en 35% — nunca cruza 0.4 para
 * ningún salario, por alto que sea (verificado con $1,000,000/mes en el
 * golden-set: cociente ≈ 0.342, ver `process_payroll_extremo_no_dispara_review`).
 * Se porta el guard tal cual — es un control inerte por diseño de la fórmula,
 * no un bug de este puerto ni algo que corregir aquí (recalibrar el umbral es
 * una decisión de producto, no de puerto). */
export function procesarNomina(period: PayrollPeriodInput, employees: readonly EmployeePayrollInput[], tenantId: number | null = null): PayrollPeriod {
  const month = period.month ?? 1;
  const year = period.year ?? 2026;
  const diasPagados = period.diasPagados ?? 30;
  const salaryPerDayDefault = period.salarioDiarioDefault ?? null;

  const payrollEmployees: EmployeePayroll[] = employees.map((emp) => {
    const salarioBruto = emp.salarioBruto ?? 0;
    const percepciones = emp.percepciones ?? 0;
    let salDiario = emp.salarioDiario ?? 0;
    if (salaryPerDayDefault && !salDiario) {
      salDiario = salaryPerDayDefault;
    }

    const taxes = calcularImpuestosNomina({
      salary: salarioBruto,
      benefits: percepciones,
      salaryPerDay: salDiario,
      diasPagados,
    });

    // Deducciones AL TRABAJADOR: ISR + IMSS obrero. Infonavit es aportación
    // PATRONAL (Ley INFONAVIT art. 29-II); NO se descuenta del neto.
    const deducciones = taxes.isr + taxes.imssObrero;
    const neto = salarioBruto + percepciones - deducciones;

    return {
      employeeId: emp.employeeId ?? "",
      nombre: emp.nombre ?? "",
      salarioDiario: salDiario,
      salarioBruto,
      percepciones,
      deducciones: r2(deducciones),
      taxes,
      neto: r2(Math.max(0, neto)),
      diasPagados,
    };
  });

  // NOTA DE FIDELIDAD: `PayrollPeriod.recalc_totals()` (Python) asigna sumas
  // SIN redondear a los atributos del dataclass; el guard de
  // `requires_human_review` (ver abajo) lee esos atributos CRUDOS, sin
  // redondear — solo `to_dict()` aplica `round(x, 2)` al serializar, en un
  // paso posterior que el guard nunca ve. Este puerto no tiene una capa de
  // serialización aparte, así que expone directamente los totales
  // redondeados (equivalente a `to_dict()`, lo que cualquier consumidor real
  // vería) — pero el guard de 40% se evalúa aquí sobre las sumas SIN
  // redondear, para no introducir una diferencia de fidelidad en el único
  // lugar donde el redondeo podría cambiar si el guard dispara o no.
  const totalBrutoRaw = sum(payrollEmployees.map((e) => e.salarioBruto + e.percepciones));
  const totalDeduccionesRaw = sum(payrollEmployees.map((e) => e.deducciones));

  const totalBruto = r2(totalBrutoRaw);
  const totalNeto = r2(sum(payrollEmployees.map((e) => e.neto)));
  const totalDeducciones = r2(totalDeduccionesRaw);
  const totalIsr = r2(sum(payrollEmployees.map((e) => e.taxes.isr)));
  const totalImssPatronal = r2(sum(payrollEmployees.map((e) => e.taxes.imssPatronal)));
  const totalImssObrero = r2(sum(payrollEmployees.map((e) => e.taxes.imssObrero)));
  const totalInfonavit = r2(sum(payrollEmployees.map((e) => e.taxes.infonavit)));

  let requiresHumanReview = false;
  let humanReviewReason = "";
  if (totalBrutoRaw > 0 && totalDeduccionesRaw / totalBrutoRaw > 0.4) {
    requiresHumanReview = true;
    humanReviewReason = `Deducciones representan ${((totalDeduccionesRaw / totalBrutoRaw) * 100).toFixed(1)}% del bruto (>40%)`;
  }

  return {
    month,
    year,
    employees: payrollEmployees,
    totalBruto,
    totalNeto,
    totalDeducciones,
    totalIsr,
    totalImssPatronal,
    totalImssObrero,
    totalInfonavit,
    tenantId,
    requiresHumanReview,
    humanReviewReason,
    referenciaLegal: "CFF Art. 105, LISR Art. 96",
    supuesto: "Procesamiento de nómina con deducciones ISR/IMSS/INFONAVIT",
    idempotencyKey: `nomina-${year}-${String(month).padStart(2, "0")}-${tenantId === null || tenantId === undefined ? "None" : tenantId}`,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
