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
