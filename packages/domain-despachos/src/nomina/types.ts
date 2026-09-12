// Tipos del motor de nómina (Fase 3) — puerto de los `@dataclass` de
// ~/Desktop/supabase/despachos/b2b_ai/features/nomina_completa/models.py
// (PayrollTaxes, EmployeePayroll, PayrollPeriod). Solo se portan los campos
// que payroll-engine.ts realmente produce (mismo criterio que
// declaraciones/types.ts en Fase 2) — se omiten los campos de
// `FiscalOutput`/`AuditTrailEntry` que el modelo Python importa pero que
// pertenecen a infraestructura de auditoría/compliance fuera de alcance de
// este motor de cálculo puro.
import type { Periodicidad } from "./subsidio-empleo.ts";

export interface PayrollTaxes {
  readonly isr: number;
  readonly imssPatronal: number;
  readonly imssObrero: number;
  readonly infonavit: number;
  /** Puerto de `PayrollTaxes.total`: `isr + imssObrero + infonavit`. NO
   * incluye `imssPatronal` (es aportación del patrón, no del trabajador) —
   * fidelidad literal al Python, confirmado leyendo el dataclass. Es la suma
   * de los tres campos ya redondeados, con un SEGUNDO redondeo aplicado
   * sobre la suma — el dataclass `__post_init__` no lo aplica, pero
   * `to_dict()` sí (`round(self.total, 2)`), y `to_dict()` es lo que
   * cualquier consumidor real ve (y lo que el golden-set capturó). Sin este
   * segundo redondeo, el ruido de punto flotante de la suma no coincide con
   * el valor limpio que produce el sistema de referencia — ver
   * payroll-engine.ts::calcularImpuestosNomina. */
  readonly total: number;
}

export interface OpcionesImpuestosNomina {
  /** Salario bruto mensual (o diario si `salaryPerDay > 0`) — puerto de
   * `salary`. Default 0. */
  readonly salary?: number;
  /** Prestaciones gravables — puerto de `benefits`. Default 0. */
  readonly benefits?: number;
  /** Si se provee (> 0), `salary` se ignora y el cálculo usa este valor como
   * salario diario — puerto de `salary_per_day`. Default 0. */
  readonly salaryPerDay?: number;
  /** Días pagados en el periodo — puerto de `dias_pagados`. Default 30. */
  readonly diasPagados?: number;
  /** 'mensual' o 'quincenal' — puerto de `periodicidad`. Default 'mensual'.
   * NOTA DE FIDELIDAD (diseño §5.4): la rama 'quincenal' calcula el ISR
   * mensual completo y lo divide entre 2 — NO usa la tabla
   * `ISR_QUINCENAL_2026` real (que existe en `fiscal_tables.py` pero que
   * `nomina_completa` nunca importa). Esta rama es código muerto en el camino
   * de producción realmente cableado hoy: ningún endpoint del sistema de
   * referencia expone `periodicidad` en su request schema. Se porta tal cual
   * (contrato público de `calculate_taxes`), no se "activa" la tabla
   * quincenal real — eso sería inventar comportamiento que el Python no
   * tiene, no un puerto fiel. */
  readonly periodicidad?: Periodicidad;
  /** Tabla ISR explícita — default documentado en isr-nomina-engine.ts. */
  readonly isrTabla?: import("../declaraciones/isr-tablas.ts").TablaIsr;
  /** Tabla de subsidio explícita — default documentado en
   * subsidio-empleo.ts. */
  readonly subsidioTabla?: import("./subsidio-empleo.ts").TablaSubsidio;
}

export interface EmployeePayroll {
  readonly employeeId: string;
  readonly nombre: string;
  /** NOTA DE FIDELIDAD: este es el `salario_diario` de ENTRADA (0 si no se
   * proveyó), NO el valor que realmente alimentó el cálculo de IMSS cuando
   * solo se dio `salarioBruto` — en ese caso `calcularImpuestosNomina`
   * deriva internamente `salarioBruto/30` para IMSS, pero ese valor derivado
   * NUNCA se escribe de vuelta a este campo. Confirmado leyendo
   * `process_payroll` (nunca reasigna `sal_diario` con el valor derivado
   * dentro de `calculate_taxes`) y verificado en el golden-set
   * (`process_payroll_basico`: `salario_diario` queda en 0.0 pese a que el
   * IMSS sí se calculó sobre 15000/30). Se porta tal cual. */
  readonly salarioDiario: number;
  readonly salarioBruto: number;
  readonly percepciones: number;
  /** `isr + imssObrero` (deducciones AL TRABAJADOR; Infonavit es patronal). */
  readonly deducciones: number;
  readonly taxes: PayrollTaxes;
  /** `max(0, salarioBruto + percepciones - deducciones)`, redondeado. */
  readonly neto: number;
  readonly diasPagados: number;
}

export interface PayrollPeriodInput {
  readonly month?: number;
  readonly year?: number;
  readonly diasPagados?: number;
  /** Salario diario por defecto del periodo, usado solo para el empleado que
   * no trae su propio `salarioDiario` — puerto de `period["salario_diario"]`. */
  readonly salarioDiarioDefault?: number;
}

export interface EmployeePayrollInput {
  readonly employeeId?: string;
  readonly nombre?: string;
  readonly salarioBruto?: number;
  readonly percepciones?: number;
  readonly salarioDiario?: number;
}

export interface PayrollPeriod {
  readonly month: number;
  readonly year: number;
  readonly employees: readonly EmployeePayroll[];
  readonly totalBruto: number;
  readonly totalNeto: number;
  readonly totalDeducciones: number;
  readonly totalIsr: number;
  readonly totalImssPatronal: number;
  readonly totalImssObrero: number;
  readonly totalInfonavit: number;
  readonly tenantId: number | null;
  readonly requiresHumanReview: boolean;
  readonly humanReviewReason: string;
  readonly referenciaLegal: string;
  readonly supuesto: string;
  /** Puerto de `idempotency_key = f"nomina-{year}-{month:02d}-{tenant_id}"`.
   * NOTA DE FIDELIDAD: cuando `tenantId` es `null`, el f-string de Python
   * produce literalmente la cadena `"None"` (interpolación de `None`) — NO
   * una cadena vacía ni "null". Se porta ese literal exacto, verificado en el
   * golden-set (`process_payroll_sin_tenant_id`). */
  readonly idempotencyKey: string;
}
