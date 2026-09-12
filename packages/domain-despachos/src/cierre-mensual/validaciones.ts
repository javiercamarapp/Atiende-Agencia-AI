// Validaciones de balance antes de cerrar el periodo — puerto BYTE-EXACTO de
// `b2b_ai/features/close_management/validation_engine.py::ValidationEngine`
// (verificado contra el intérprete real, ver tests/fixtures/
// golden_gen_cierre_mensual.py). Puro, sin estado — la tolerancia se pasa
// explícita en vez de guardarse en un objeto `self` mutable.
export interface ValidationResult {
  readonly type: string;
  readonly passed: boolean;
  readonly message: string;
  readonly details: Record<string, unknown>;
  readonly warnings: readonly string[];
}

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Aproxima `str(float)` de Python para los mensajes de error de
 * nómina/pólizas (que el origen interpola SIN redondear a 2 decimales fijos,
 * `f"${valor}"` sobre el float crudo — Python siempre muestra al menos un
 * decimal para un float, p.ej. `str(8000.0) == "8000.0"`, mientras que JS
 * `${8000}` da `"8000"`). NOTA DE FIDELIDAD: esto solo cubre el caso común
 * de montos "limpios" (enteros o con pocos decimales) — no reimplementa el
 * algoritmo completo de reproducción mínima de dígitos de CPython para
 * cualquier float arbitrario; para los montos de nómina/pólizas típicos
 * (2 decimales) es suficiente y fue verificado contra el intérprete real. */
function pyFloatStr(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** `validate_balance_cuadrada` — tolerancia de $1.00 MXN por defecto (nivel
 * balanza, más laxa que el chequeo por póliza individual de 0.01). */
export function validateBalanceCuadrada(totalDebe: number, totalHaber: number, toleranceBalance = 1.0): ValidationResult {
  const diff = r2(Math.abs(totalDebe - totalHaber));
  const passed = diff <= toleranceBalance;
  return {
    type: "balance_cuadrada",
    passed,
    message: passed ? "Balanza cuadrada" : `Balanza NO cuadrada — diferencia $${money(diff)}`,
    details: { total_debe: totalDebe, total_haber: totalHaber, diferencia: diff, tolerancia: toleranceBalance },
    warnings: [],
  };
}

/** `validate_iva_conciliado` — tolerancia flat de $100 MXN por defecto. */
export function validateIvaConciliado(ivaTrasladado: number, ivaAcreditable: number, ivaProvisionado: number, tolerance = 100.0): ValidationResult {
  const expected = r2(ivaTrasladado - ivaAcreditable);
  const diff = r2(Math.abs(expected - ivaProvisionado));
  const passed = diff <= tolerance;
  return {
    type: "iva_conciliado",
    passed,
    message: passed ? "IVA conciliado correctamente" : `IVA NO conciliado — diferencia $${money(diff)}`,
    details: { iva_trasladado: ivaTrasladado, iva_acreditable: ivaAcreditable, expected, iva_provisionado: ivaProvisionado, diferencia: diff },
    warnings: [],
  };
}

/** `validate_isr_provisionado` — sin ISR esperado si `utilidadFiscal <= 0`
 * (regla fiscal legítima, no un bug); si no, tolerancia = max(1% del
 * esperado, $100 MXN). */
export function validateIsrProvisionado(isrProvision: number, utilidadFiscal: number, isrRate = 0.3): ValidationResult {
  if (utilidadFiscal <= 0) {
    return { type: "isr_provisionado", passed: true, message: "ISR no aplica — sin utilidad fiscal", details: { utilidad_fiscal: utilidadFiscal, isr_provision: isrProvision }, warnings: [] };
  }
  const expected = r2(utilidadFiscal * isrRate);
  const diff = r2(Math.abs(expected - isrProvision));
  const tolerance = Math.max(expected * 0.01, 100.0);
  const passed = diff <= tolerance;
  return {
    type: "isr_provisionado",
    passed,
    message: passed ? "ISR provisionado correctamente" : `ISR provision insuficiente — esperado $${money(expected)}, actual $${money(isrProvision)}, diferencia $${money(diff)}`,
    details: { utilidad_fiscal: utilidadFiscal, expected, isr_provision: isrProvision, diferencia: diff, tasa: isrRate },
    warnings: [],
  };
}

/** `validate_nomina_cuadrada` — bruto − deducciones == neto, tolerancia
 * 0.01 MXN por nómina. Nota de fidelidad: el origen NO redondea
 * `bruto`/`deducciones`/`neto` en el mensaje de error (usa los floats
 * crudos con `f"${bruto}"`, que en Python imprime su repr corta) — aquí se
 * imprime igual con `String(n)` en vez de forzar 2 decimales, para
 * replicar ese detalle en vez de "mejorarlo" en silencio. */
export function validateNominaCuadrada(nominas: readonly { readonly sueldoBruto: number; readonly totalDeducciones: number; readonly sueldoNeto: number }[]): ValidationResult {
  const errors: string[] = [];
  nominas.forEach((nom, i) => {
    const expectedNeto = r2(nom.sueldoBruto - nom.totalDeducciones);
    if (Math.abs(expectedNeto - nom.sueldoNeto) > 0.01) {
      errors.push(`Nómina #${i + 1}: bruto $${pyFloatStr(nom.sueldoBruto)} - deducciones $${pyFloatStr(nom.totalDeducciones)} = $${pyFloatStr(expectedNeto)}, neto reportado $${pyFloatStr(nom.sueldoNeto)}`);
    }
  });
  const passed = errors.length === 0;
  return {
    type: "nomina_cuadrada",
    passed,
    message: passed ? `${nominas.length} nóminas cuadradas` : `${errors.length} nóminas con desfase`,
    details: { total_nominas: nominas.length, errors },
    warnings: errors,
  };
}

/** `validate_bancos_conciliados` — `matchRate` puede venir 0-1 (fracción) o
 * >1 (ya en porcentaje); el umbral (`minReconciliationRate`) SIEMPRE se
 * interpreta como fracción (0.80 = 80%). */
export function validateBancosConciliados(matchRate: number, minReconciliationRate = 0.8, totalMovements = 0, matched = 0): ValidationResult {
  // `round(x, 1)` de Python — un decimal fijo (no 2, a diferencia del resto
  // de las validaciones de este módulo); se formatea con `toFixed(1)` en el
  // mensaje para reproducir `str(float)` de Python (siempre 1 decimal aquí,
  // p.ej. `str(95.0) == "95.0"`, nunca `"95"`).
  const ratePctNum = matchRate <= 1 ? matchRate * 100 : matchRate;
  const ratePct = Math.round((ratePctNum + Number.EPSILON) * 10) / 10;
  const passed = matchRate >= minReconciliationRate;
  return {
    type: "bancos_conciliados",
    passed,
    message: passed ? `Bancos conciliados al ${ratePct.toFixed(1)}%` : `Bancos insuficientemente conciliados: ${ratePct.toFixed(1)}% (mínimo ${(minReconciliationRate * 100).toFixed(0)}%)`,
    details: { match_rate: matchRate, total_movements: totalMovements, matched, threshold: minReconciliationRate },
    warnings: [],
  };
}

/** `validate_polizas_cuadradas` — tolerancia fija de 0.01 MXN por póliza
 * (más estricta que la balanza global). */
export function validatePolizasCuadradas(polizas: readonly { readonly id?: string; readonly totalDebe: number; readonly totalHaber: number }[]): ValidationResult {
  const errors: string[] = [];
  for (const pol of polizas) {
    const debe = r2(pol.totalDebe);
    const haber = r2(pol.totalHaber);
    if (Math.abs(debe - haber) > 0.01) errors.push(`Póliza ${pol.id ?? "?"}: debe $${pyFloatStr(debe)} ≠ haber $${pyFloatStr(haber)}`);
  }
  const passed = errors.length === 0;
  return {
    type: "polizas_cuadradas",
    passed,
    message: passed ? `${polizas.length} pólizas cuadradas` : `${errors.length} pólizas con desfase`,
    details: { total_polizas: polizas.length, errors },
    warnings: errors,
  };
}
