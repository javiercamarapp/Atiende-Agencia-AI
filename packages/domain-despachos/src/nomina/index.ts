// Barrel de nómina (Fase 3 despachos). Cero acoplamiento nuevo hacia
// cfdi/reglas-fiscales-avanzadas.ts (Fase 1/2): un consumidor de más arriba
// alimenta `validarCfdiDespachos({ ..., nomina: { totalPercepciones } })` con
// la salida de `procesarNomina`, pero eso vive fuera de domain-despachos
// (diseño §3). Fuera de alcance de este módulo: generación/timbrado de XML
// del complemento Nómina 1.2, FIEL, RPA a portales SAT/IMSS, y persistencia
// de periodos de nómina (diseño §6).
export { ISR_NOMINA_MENSUAL_2026, ISR_NOMINA_ANUAL_2026 } from "./isr-nomina-tablas.ts";
export { calcularIsrNomina } from "./isr-nomina-engine.ts";

export {
  UMA_MENSUAL_2026,
  UMA_DIARIA_2026,
  SBC_MAX_UMA,
  IMSS_OBRERO_TASA,
  IMSS_PATRONAL_TASA,
  INFONAVIT_TASA,
  sbcDiarioTopado,
  calcularImssObrero,
  calcularImssPatronal,
  calcularInfonavit,
} from "./imss-engine.ts";

export { SUBSIDIO_EMPLEO_MENSUAL_2026, SUBSIDIO_EMPLEO_QUINCENAL_2026, calcularSubsidio } from "./subsidio-empleo.ts";
export type { FilaSubsidio, TablaSubsidio, Periodicidad } from "./subsidio-empleo.ts";

export { calcularAguinaldo, calcularPrimaVacacional } from "./prestaciones.ts";

export { calcularImpuestosNomina, procesarNomina } from "./payroll-engine.ts";

export type {
  PayrollTaxes,
  OpcionesImpuestosNomina,
  EmployeePayroll,
  EmployeePayrollInput,
  PayrollPeriod,
  PayrollPeriodInput,
} from "./types.ts";
