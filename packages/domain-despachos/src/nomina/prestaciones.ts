// ═══════════════════════════════════════════════════════════════════════════
// PRESTACIONES — puerto de `calculate_aguinaldo`/`calculate_prima_vacacional`
// (nomina_completa/service.py). Fórmulas simples LFT art. 87/80, bajo riesgo
// (diseño Fase 3 §3, grupo G). No incluye PTU (LFT art. 123 fr. IX): existe
// en `services/payroll.py::calc_ptu` pero NO en `nomina_completa/service.py`
// (el módulo fuente de este port) — fuera de alcance salvo que se decida
// adoptar el motor paralelo (diseño §5.2/§6).
import { r2 } from "./redondeo.ts";

/** Puerto de `calculate_aguinaldo` (LFT art. 87). Mínimo legal: 15 días de
 * salario. `salarioDiario` negativo se trata como 0 (`max(0, ...)`), igual
 * que el Python — nunca produce un aguinaldo negativo. */
export function calcularAguinaldo(salarioDiario: number, diasAguinaldo = 15): number {
  return r2(Math.max(0, salarioDiario) * diasAguinaldo);
}

/** Puerto de `calculate_prima_vacacional` (LFT art. 80). Mínimo legal: 6 días
 * de vacaciones al 25%. `salarioDiario` negativo se trata como 0, igual que
 * el Python. */
export function calcularPrimaVacacional(salarioDiario: number, diasVacaciones = 6, porcentaje = 0.25): number {
  const baseVacaciones = Math.max(0, salarioDiario) * diasVacaciones;
  return r2(baseVacaciones * porcentaje);
}
