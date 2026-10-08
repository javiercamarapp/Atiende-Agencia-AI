// Tipos del motor de nómina. Salario diario/SBC, IMSS por rama, subsidio %UMA y prestaciones con exentos (paridad3).
import type { Periodicidad } from "./subsidio-empleo.ts";
import type { ImssDesglose } from "./imss-engine.ts";

export interface PayrollTaxes {
  /** ISR a retener: ISR causado menos subsidio causado, nunca negativo (sin pago en efectivo del excedente). */
  readonly isr: number;
  /** ISR de la tarifa antes del subsidio. */
  readonly isrCausado: number;
  /** Subsidio al empleo causado en el periodo (% de la UMA, ver subsidio-empleo.ts). */
  readonly subsidioCausado: number;
  /** IMSS patronal por ramas (incluye retiro y CEAV; EXCLUYE INFONAVIT). */
  readonly imssPatronal: number;
  readonly imssObrero: number;
  readonly infonavit: number;
  readonly imss: ImssDesglose;
  /** `isr + imssObrero + infonavit` redondeado (se conserva la definición histórica; no incluye imssPatronal). */
  readonly total: number;
}

export interface HoraExtraInput {
  readonly dias: number;
  /** "01" dobles, "02" triples (c_TipoHoras). */
  readonly tipo: "01" | "02";
  readonly horas: number;
  readonly importe: number;
}

export interface IncapacidadInput {
  readonly dias: number;
  /** c_TipoIncapacidad: 01 riesgo de trabajo, 02 enfermedad general, 03 maternidad, 04 licencia por cuidados médicos. */
  readonly tipo: string;
  /** Descuento por la incapacidad (se refleja como deducción 006). */
  readonly importe?: number;
}

export interface ConceptosPeriodoInput {
  readonly aguinaldo?: number;
  readonly primaVacacional?: number;
  readonly ptu?: number;
  readonly horasExtra?: readonly HoraExtraInput[];
  /** Semanas del periodo para el tope de 5 UMA/semana del tiempo extra; por omisión 2 (quincenal) o 4 (mensual). */
  readonly semanasTiempoExtra?: number;
  readonly incapacidades?: readonly IncapacidadInput[];
}

export interface ConceptosPeriodoDesglose {
  readonly aguinaldo: { readonly total: number; readonly exento: number; readonly gravado: number };
  readonly primaVacacional: { readonly total: number; readonly exento: number; readonly gravado: number };
  readonly ptu: { readonly total: number; readonly exento: number; readonly gravado: number };
  readonly tiempoExtra: { readonly total: number; readonly exento: number; readonly gravado: number };
  readonly descuentoIncapacidad: number;
  readonly totalPercibido: number;
  readonly totalExento: number;
  readonly totalGravado: number;
}

export interface OpcionesImpuestosNomina {
  /** YYYY-MM-DD de pago: define UMA, subsidio y tarifa vigentes. */
  readonly fechaPago: string;
  /** Sueldo bruto del PERIODO que se paga (mes en mensual, quincena en quincenal); se ignora para ISR/SBC si `salaryPerDay > 0`. */
  readonly salary?: number;
  /** Prestaciones gravables adicionales del periodo (misma escala que `salary`). */
  readonly benefits?: number;
  readonly salaryPerDay?: number;
  /** Días pagados: por omisión 30 (mensual) o 15 (quincenal). */
  readonly diasPagados?: number;
  readonly periodicidad?: Periodicidad;
  /** Años completos de antigüedad (define vacaciones y factor de integración). Por omisión 1. */
  readonly antiguedadAnios?: number;
  /** SBC diario explícito; si falta = salario diario × factor de integración. */
  readonly sbc?: number;
  /** Prima RT de la empresa (fracción). Por omisión clase I 0.54355 %. */
  readonly primaRt?: number;
  readonly conceptos?: ConceptosPeriodoInput;
  readonly isrTabla?: import("../declaraciones/isr-tablas.ts").TablaIsr;
}

export interface EmployeePayroll {
  readonly employeeId: string;
  readonly nombre: string;
  /** Salario diario de ENTRADA (0 si solo se dio salarioBruto). */
  readonly salarioDiario: number;
  /** Salario diario que alimentó el cálculo (entrada, o salarioBruto/30 en mensual y salarioBruto/15 en quincenal). */
  readonly salarioDiarioCalculado: number;
  readonly sbcDiario: number;
  readonly factorIntegracion: number | null;
  readonly antiguedadAnios: number;
  /** Sueldo bruto del periodo pagado (mes o quincena según la periodicidad). */
  readonly salarioBruto: number;
  readonly percepciones: number;
  readonly conceptos: ConceptosPeriodoDesglose;
  /** `isr + imssObrero + descuentoIncapacidad` (INFONAVIT es patronal). */
  readonly deducciones: number;
  readonly taxes: PayrollTaxes;
  readonly neto: number;
  readonly diasPagados: number;
  readonly periodicidad: Periodicidad;
  readonly fechaPago: string;
  /** Eco de las horas extra capturadas (el XML las lista dentro de la percepción 019). */
  readonly horasExtra: readonly HoraExtraInput[];
  /** Eco de las incapacidades capturadas (nodo Incapacidades del XML). */
  readonly incapacidades: readonly IncapacidadInput[];
}

export interface PayrollPeriodInput {
  readonly month?: number;
  readonly year?: number;
  readonly diasPagados?: number;
  readonly salarioDiarioDefault?: number;
  /** YYYY-MM-DD; por omisión el último día del mes del periodo. */
  readonly fechaPago?: string;
  readonly periodicidad?: Periodicidad;
  /** Primer día del periodo pagado (YYYY-MM-DD) para el XML; por omisión el día 1 del mes. */
  readonly fechaInicialPago?: string;
  readonly fechaFinalPago?: string;
}

export interface EmployeePayrollInput {
  readonly employeeId?: string;
  readonly nombre?: string;
  /** Sueldo bruto del periodo pagado (mes en mensual, quincena en quincenal). */
  readonly salarioBruto?: number;
  readonly percepciones?: number;
  readonly salarioDiario?: number;
  readonly antiguedadAnios?: number;
  /** YYYY-MM-DD: si viene y no hay antiguedadAnios, se calcula a la fecha de pago. */
  readonly fechaInicioRelLaboral?: string;
  readonly sbc?: number;
  readonly primaRt?: number;
  readonly conceptos?: ConceptosPeriodoInput;
}

export interface PayrollPeriod {
  readonly month: number;
  readonly year: number;
  readonly fechaPago: string;
  readonly periodicidad: Periodicidad;
  readonly employees: readonly EmployeePayroll[];
  readonly totalBruto: number;
  readonly totalNeto: number;
  readonly totalDeducciones: number;
  readonly totalIsr: number;
  readonly totalSubsidioCausado: number;
  readonly totalImssPatronal: number;
  readonly totalImssObrero: number;
  readonly totalInfonavit: number;
  readonly tenantId: number | null;
  readonly requiresHumanReview: boolean;
  readonly humanReviewReason: string;
  readonly referenciaLegal: string;
  readonly supuesto: string;
  /** `nomina-AAAA-MM-<tenant>`; con tenantId ausente la cadena literal "None" (se conserva por compatibilidad). */
  readonly idempotencyKey: string;
}
