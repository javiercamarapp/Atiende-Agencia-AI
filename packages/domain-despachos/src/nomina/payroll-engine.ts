// MOTOR DE NÓMINA — composición. Puro, sin I/O ni reloj: la fecha de pago es explícita y define UMA, subsidio y IMSS.
// Compone ISR (tarifa art. 96), subsidio % UMA, IMSS por rama, prestaciones con exentos del art. 93. Valores legales en
// parametros.ts (por validar con fiscalista).
//
// Escala de las cifras: `salarioBruto` (salary) y `percepciones` (benefits) son importes DEL PERIODO que se paga: el sueldo
// del mes en nómina mensual y el sueldo de la quincena en nómina quincenal. Así neto, totalBruto y el sueldo del XML
// (percepción 001) cuadran con los días pagados. Para el ISR el ingreso del periodo quincenal se escala a mensual
// (2 × (salary + benefits + conceptos gravados)), se calcula ISR mensual y se divide entre 2; el subsidio se prorratea por
// días del periodo / 30.4 (subsidio-empleo.ts). El salario diario (base del SBC) es salary/15 en quincenal y salary/30 en
// mensual. Sin pago en efectivo del excedente del subsidio.
//
// Simplificación declarada: el gravado de aguinaldo/PTU/prima se suma al ingreso del periodo (no se usa el método de tasa
// efectiva del art. 174 RLISR); sobrestima el ISR en meses con aguinaldo grande.
import { calcularIsrNomina } from "./isr-nomina-engine.ts";
import { calcularImssPorRama, ImssInvalidoError } from "./imss-engine.ts";
import { calcularSubsidio } from "./subsidio-empleo.ts";
import { umaVigente } from "./parametros.ts";
import { exentoAguinaldo, exentoPrimaVacacional, exentoPtu, exentoTiempoExtra, factorIntegracion } from "./prestaciones.ts";
import { r2 } from "./redondeo.ts";
import type {
  ConceptosPeriodoDesglose,
  ConceptosPeriodoInput,
  EmployeePayroll,
  EmployeePayrollInput,
  OpcionesImpuestosNomina,
  PayrollPeriod,
  PayrollPeriodInput,
  PayrollTaxes,
} from "./types.ts";
import type { Periodicidad } from "./subsidio-empleo.ts";

export class NominaInvalidaError extends Error {}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

export function ultimoDiaDelMesIso(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Años completos entre dos fechas YYYY-MM-DD (0 si inicio es posterior). */
export function aniosCompletos(desde: string, hasta: string): number {
  if (!FECHA_RE.test(desde) || !FECHA_RE.test(hasta)) throw new NominaInvalidaError("Las fechas deben tener formato YYYY-MM-DD.");
  const [y1, m1, d1] = desde.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = hasta.split("-").map(Number) as [number, number, number];
  let a = y2 - y1;
  if (m2 < m1 || (m2 === m1 && d2 < d1)) a -= 1;
  return Math.max(0, a);
}

const CERO = { total: 0, exento: 0, gravado: 0 };

export function desglosarConceptos(c: ConceptosPeriodoInput | undefined, umaDiaria: number, periodicidad: Periodicidad): ConceptosPeriodoDesglose {
  const x = c ?? {};
  for (const [k, v] of Object.entries({ aguinaldo: x.aguinaldo, primaVacacional: x.primaVacacional, ptu: x.ptu })) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new NominaInvalidaError(`conceptos.${k} debe ser un número >= 0.`);
  }
  for (const h of x.horasExtra ?? []) {
    if (!Number.isInteger(h.dias) || h.dias < 1 || !Number.isInteger(h.horas) || h.horas < 1 || !Number.isFinite(h.importe) || h.importe < 0 || (h.tipo !== "01" && h.tipo !== "02")) {
      throw new NominaInvalidaError("conceptos.horasExtra: dias y horas enteros >= 1, importe >= 0 y tipo 01 o 02.");
    }
  }
  for (const i of x.incapacidades ?? []) {
    if (!Number.isInteger(i.dias) || i.dias < 1 || !/^0[1-4]$/.test(i.tipo) || (i.importe !== undefined && (!Number.isFinite(i.importe) || i.importe < 0))) {
      throw new NominaInvalidaError("conceptos.incapacidades: dias entero >= 1, tipo 01-04 e importe >= 0.");
    }
  }
  const doble = (x.horasExtra ?? []).filter((h) => h.tipo === "01").reduce((a, h) => a + h.importe, 0);
  const triple = (x.horasExtra ?? []).filter((h) => h.tipo === "02").reduce((a, h) => a + h.importe, 0);
  const semanas = x.semanasTiempoExtra ?? (periodicidad === "quincenal" ? 2 : 4);
  const aguinaldo = x.aguinaldo ? exentoAguinaldo(x.aguinaldo, umaDiaria) : CERO;
  const primaVacacional = x.primaVacacional ? exentoPrimaVacacional(x.primaVacacional, umaDiaria) : CERO;
  const ptu = x.ptu ? exentoPtu(x.ptu, umaDiaria) : CERO;
  const tiempoExtra = doble + triple > 0 ? exentoTiempoExtra(doble, triple, semanas, umaDiaria) : CERO;
  const descuentoIncapacidad = r2((x.incapacidades ?? []).reduce((a, i) => a + Math.max(0, i.importe ?? 0), 0));
  const partes = [aguinaldo, primaVacacional, ptu, tiempoExtra];
  return {
    aguinaldo,
    primaVacacional,
    ptu,
    tiempoExtra,
    descuentoIncapacidad,
    totalPercibido: r2(partes.reduce((a, p) => a + p.total, 0)),
    totalExento: r2(partes.reduce((a, p) => a + p.exento, 0)),
    totalGravado: r2(partes.reduce((a, p) => a + p.gravado, 0)),
  };
}

export interface ImpuestosNominaResultado {
  readonly taxes: PayrollTaxes;
  readonly salarioDiarioCalculado: number;
  readonly sbcDiario: number;
  readonly factorIntegracion: number | null;
  readonly antiguedadAnios: number;
  readonly conceptos: ConceptosPeriodoDesglose;
  readonly diasPagados: number;
  readonly periodicidad: Periodicidad;
}

/** Calcula ISR, subsidio, IMSS por rama e INFONAVIT de un trabajador en un periodo. */
export function calcularImpuestosNominaDetalle(opts: OpcionesImpuestosNomina): ImpuestosNominaResultado {
  const periodicidad = opts.periodicidad ?? "mensual";
  const salary = opts.salary ?? 0;
  const benefits = opts.benefits ?? 0;
  const salaryPerDay = opts.salaryPerDay ?? 0;
  const diasPagados = opts.diasPagados ?? (periodicidad === "quincenal" ? 15 : 30);
  const antiguedadAnios = opts.antiguedadAnios ?? 1;

  const escala = periodicidad === "quincenal" ? 2 : 1;
  const diasBase = periodicidad === "quincenal" ? 15 : 30;
  let salarioMensual: number;
  let salarioDiario: number;
  if (salaryPerDay > 0) {
    salarioMensual = salaryPerDay * 30;
    salarioDiario = salaryPerDay;
  } else {
    salarioMensual = salary * escala;
    salarioDiario = salary > 0 ? salary / diasBase : 0;
  }

  const uma = umaVigente(opts.fechaPago).diaria;
  const conceptos = desglosarConceptos(opts.conceptos, uma, periodicidad);
  const gravable = Math.max(0, salarioMensual + escala * benefits + escala * (conceptos.totalGravado - conceptos.descuentoIncapacidad));

  const isrMensual = calcularIsrNomina(gravable, false, opts.isrTabla);
  const isrCausado = periodicidad === "quincenal" ? r2(isrMensual / 2) : isrMensual;
  const subsidio = calcularSubsidio(gravable, opts.fechaPago, { periodicidad, diasPeriodo: diasPagados });
  const isr = r2(Math.max(0, isrCausado - subsidio));

  const factor = opts.sbc === undefined ? factorIntegracion(antiguedadAnios) : null;
  const sbcDiario = opts.sbc ?? r2(salarioDiario * (factor as number));
  const imss = calcularImssPorRama({ sbcDiario, diasPagados, fechaPago: opts.fechaPago, primaRt: opts.primaRt });

  const imssObrero = imss.obrero.total;
  const imssPatronal = imss.patronal.total;
  const infonavit = imss.infonavit;
  return {
    taxes: {
      isr,
      isrCausado,
      subsidioCausado: subsidio,
      imssPatronal,
      imssObrero,
      infonavit,
      imss,
      total: r2(isr + imssObrero + infonavit),
    },
    salarioDiarioCalculado: salarioDiario,
    sbcDiario: imss.sbcDiario,
    factorIntegracion: factor,
    antiguedadAnios,
    conceptos,
    diasPagados,
    periodicidad,
  };
}

export function calcularImpuestosNomina(opts: OpcionesImpuestosNomina): PayrollTaxes {
  return calcularImpuestosNominaDetalle(opts).taxes;
}

/** Procesa la nómina de un periodo. `idempotencyKey` con tenantId ausente usa el literal "None" (compatibilidad). */
export function procesarNomina(period: PayrollPeriodInput, employees: readonly EmployeePayrollInput[], tenantId: number | null = null, propertyId: string | null = null): PayrollPeriod {
  const month = period.month ?? 1;
  const year = period.year ?? 2026;
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new NominaInvalidaError("period.month debe estar entre 1 y 12.");
  const periodicidad: Periodicidad = period.periodicidad ?? "mensual";
  const diasPagados = period.diasPagados ?? (periodicidad === "quincenal" ? 15 : 30);
  const fechaPago = period.fechaPago ?? ultimoDiaDelMesIso(year, month);
  if (!FECHA_RE.test(fechaPago)) throw new NominaInvalidaError("period.fechaPago debe tener formato YYYY-MM-DD.");
  const salaryPerDayDefault = period.salarioDiarioDefault ?? null;

  const payrollEmployees: EmployeePayroll[] = employees.map((emp, idx) => {
    const salarioBruto = emp.salarioBruto ?? 0;
    const percepciones = emp.percepciones ?? 0;
    let salDiario = emp.salarioDiario ?? 0;
    if (salaryPerDayDefault && !salDiario) salDiario = salaryPerDayDefault;

    const antig = emp.antiguedadAnios ?? (emp.fechaInicioRelLaboral ? aniosCompletos(emp.fechaInicioRelLaboral, fechaPago) : undefined);
    let r: ImpuestosNominaResultado;
    try {
      r = calcularImpuestosNominaDetalle({
        fechaPago,
        salary: salarioBruto,
        benefits: percepciones,
        salaryPerDay: salDiario,
        diasPagados,
        periodicidad,
        antiguedadAnios: antig,
        sbc: emp.sbc,
        primaRt: emp.primaRt,
        conceptos: emp.conceptos,
      });
    } catch (err) {
      // Dice qué renglón falló (el motor lanza errores sin contexto de empleado).
      if (err instanceof NominaInvalidaError || err instanceof ImssInvalidoError) {
        const quien = emp.nombre || emp.employeeId || `empleado ${idx + 1}`;
        throw new (err.constructor as new (m: string) => Error)(`employees[${idx}] (${quien}): ${err.message}`);
      }
      throw err;
    }
    const taxes = r.taxes;
    const deducciones = taxes.isr + taxes.imssObrero + r.conceptos.descuentoIncapacidad;
    const neto = salarioBruto + percepciones + r.conceptos.totalPercibido - deducciones;

    return {
      employeeId: emp.employeeId ?? "",
      nombre: emp.nombre ?? "",
      salarioDiario: salDiario,
      salarioDiarioCalculado: r.salarioDiarioCalculado,
      sbcDiario: r.sbcDiario,
      factorIntegracion: r.factorIntegracion,
      antiguedadAnios: r.antiguedadAnios,
      salarioBruto,
      percepciones,
      conceptos: r.conceptos,
      deducciones: r2(deducciones),
      taxes,
      neto: r2(Math.max(0, neto)),
      diasPagados,
      periodicidad,
      fechaPago,
      horasExtra: emp.conceptos?.horasExtra ?? [],
      incapacidades: emp.conceptos?.incapacidades ?? [],
    };
  });

  const totalBrutoRaw = sum(payrollEmployees.map((e) => e.salarioBruto + e.percepciones + e.conceptos.totalPercibido));
  const totalDeduccionesRaw = sum(payrollEmployees.map((e) => e.deducciones));

  let requiresHumanReview = false;
  let humanReviewReason = "";
  if (totalBrutoRaw > 0 && totalDeduccionesRaw / totalBrutoRaw > 0.4) {
    requiresHumanReview = true;
    humanReviewReason = `Deducciones representan ${((totalDeduccionesRaw / totalBrutoRaw) * 100).toFixed(1)}% del bruto (>40%)`;
  }

  return {
    month,
    year,
    fechaPago,
    periodicidad,
    employees: payrollEmployees,
    totalBruto: r2(totalBrutoRaw),
    totalNeto: r2(sum(payrollEmployees.map((e) => e.neto))),
    totalDeducciones: r2(totalDeduccionesRaw),
    totalIsr: r2(sum(payrollEmployees.map((e) => e.taxes.isr))),
    totalSubsidioCausado: r2(sum(payrollEmployees.map((e) => e.taxes.subsidioCausado))),
    totalImssPatronal: r2(sum(payrollEmployees.map((e) => e.taxes.imssPatronal))),
    totalImssObrero: r2(sum(payrollEmployees.map((e) => e.taxes.imssObrero))),
    totalInfonavit: r2(sum(payrollEmployees.map((e) => e.taxes.infonavit))),
    tenantId,
    requiresHumanReview,
    humanReviewReason,
    referenciaLegal: "CFF Art. 105, LISR Art. 96, LSS, LFT",
    supuesto: "Procesamiento de nómina con ISR, subsidio (% UMA), IMSS por rama e INFONAVIT",
    // D-P3-50: la clave incluye la PROPERTY de la ruta (dos clientes del mismo despacho no comparten clave). Sin `propertyId` se conserva la clave original.
    idempotencyKey: `nomina-${year}-${String(month).padStart(2, "0")}-${propertyId ?? (tenantId === null || tenantId === undefined ? "None" : tenantId)}`,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
