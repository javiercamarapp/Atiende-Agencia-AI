export {
  validarCfdiDespachos,
  TOLERANCIA,
} from "./cfdi/reglas-fiscales-avanzadas.ts";
export type { DatosCfdiDespachos, ResultadoValidacionCfdiDespachos, DiotResult, ProveedorReportableDiot, NominaCfdi } from "./cfdi/reglas-fiscales-avanzadas.ts";

// ---- Declaraciones ISR/IVA/RESICO + DIOT (Fase 2) ----
export {
  ISR_PF_MENSUAL_2025,
  ISR_PF_ANUAL_2025,
  ISR_PM_MENSUAL_RESICO,
  ISR_PM_TASA,
} from "./declaraciones/isr-tablas.ts";
export type { TablaIsr, FilaTablaIsr } from "./declaraciones/isr-tablas.ts";

export { aplicarTablaIsr, calcularIsrPf, calcularIsrPm, calcularIsrPmResico } from "./declaraciones/isr-engine.ts";
export type { OpcionesIsrPf } from "./declaraciones/isr-engine.ts";

export { agregarDiot, esRfcGenerico } from "./declaraciones/diot-aggregate.ts";

// ---- Nómina (Fase 3) ----
export { ISR_NOMINA_MENSUAL_2026, ISR_NOMINA_ANUAL_2026 } from "./nomina/isr-nomina-tablas.ts";
export { calcularIsrNomina } from "./nomina/isr-nomina-engine.ts";
export {
  UMA_MENSUAL_2026 as NOMINA_UMA_MENSUAL_2026,
  UMA_DIARIA_2026 as NOMINA_UMA_DIARIA_2026,
  SBC_MAX_UMA,
  IMSS_OBRERO_TASA,
  IMSS_PATRONAL_TASA,
  INFONAVIT_TASA,
  sbcDiarioTopado,
  calcularImssObrero,
  calcularImssPatronal,
  calcularInfonavit,
} from "./nomina/imss-engine.ts";
export { SUBSIDIO_EMPLEO_MENSUAL_2026, SUBSIDIO_EMPLEO_QUINCENAL_2026, calcularSubsidio } from "./nomina/subsidio-empleo.ts";
export type { FilaSubsidio, TablaSubsidio, Periodicidad } from "./nomina/subsidio-empleo.ts";
export { calcularAguinaldo, calcularPrimaVacacional } from "./nomina/prestaciones.ts";
export { calcularImpuestosNomina, procesarNomina } from "./nomina/payroll-engine.ts";
export type {
  PayrollTaxes,
  OpcionesImpuestosNomina,
  EmployeePayroll,
  EmployeePayrollInput,
  PayrollPeriod,
  PayrollPeriodInput,
} from "./nomina/types.ts";

export type {
  IsrResultado,
  TipoContribuyente,
  TablaAplicadaIsr,
  DiotTipoOperacion,
  RegistroDiotCandidato,
  DiotRegistroAgregado,
  DiotAgregado,
} from "./declaraciones/types.ts";

export {
  TIPOS_FACTOR,
  DIOT_TIPO_OPERACION,
  CP_CATEGORIAS,
  esDiotTipoOperacionValido,
  describeImpuesto,
} from "./cfdi/catalogs-avanzados.ts";

export {
  TIPOS_VENCIMIENTO,
  fechaLimiteDia17MesSiguiente,
  diasHasta,
  calcularPrioridad,
  decidirEscalamiento,
  calcularVencimientosDelPeriodo,
} from "./vencimientos/engine.ts";
export type {
  PrioridadVencimiento,
  EstadoVencimiento,
  NivelEscalamiento,
  TipoVencimiento,
  DecisionEscalamiento,
  NuevoVencimiento,
} from "./vencimientos/engine.ts";

export {
  DESPACHOS_ROLES,
  isDespachosRole,
  RESOLVER_REVISION_ROLES,
  INGESTA_CFDI_ROLES,
  GESTION_VENCIMIENTOS_ROLES,
  DECLARACIONES_ROLES,
  NOMINA_ROLES,
  ADMIN_ROLES,
  PLATFORM_ROLE_BY_VERTICAL_ROLE,
} from "./roles.ts";
export type { DespachosRole } from "./roles.ts";

export { IdempotencyConflictError, InvoiceAlreadyExistsError, InvoiceReviewAlreadyResolvedError } from "./errors.ts";

export type {
  TipoComprobante,
  CategoriaContable,
  InvoiceRecord,
  NewInvoiceInput,
  InvoiceReviewStatus,
  InvoiceReviewRecord,
  NewInvoiceReviewInput,
  FiscalDeadlineRecord,
  NewFiscalDeadlineInput,
  DeadlineEscalationRecord,
} from "./types.ts";

export type { DespachosRepository } from "./repository.ts";
export { InMemoryDespachosRepository } from "./in-memory-repository.ts";
export { PostgresDespachosRepository } from "./postgres-repository.ts";
