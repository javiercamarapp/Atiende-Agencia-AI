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
  CONCILIACION_ROLES,
  MIGRACION_CATALOGO_ROLES,
  DECIDIR_MAPEO_MIGRACION_ROLES,
  ADMIN_ROLES,
  PLATFORM_ROLE_BY_VERTICAL_ROLE,
} from "./roles.ts";
export type { DespachosRole } from "./roles.ts";

// ---- Conciliación bancaria (Fase 5) ----
export { conciliarMovimientos } from "./conciliacion/matching-engine.ts";
export { normalizarTexto as normalizarTextoConciliacion, conjuntoTokens, solapamientoTokens, ratio as ratioTexto, tokenSortRatio, partialRatio } from "./conciliacion/text-similarity.ts";
export { fechaADate, fechaDiff } from "./conciliacion/fechas.ts";
export {
  AGING_BUCKETS,
  UMBRAL_MOVIMIENTO_GRANDE,
  RATIO_DISCREPANCIA_INGRESOS,
  severidadPorAntiguedad,
  revisarMovimiento,
  revisarDuplicados,
  revisarDiscrepanciaIngresos,
} from "./conciliacion/alerts.ts";
export {
  CLASIFICACIONES_REQUIEREN_DOCUMENTO_SOPORTE,
  UMBRAL_CONFIANZA_SOSPECHOSA,
  NOTA_ART_59_FR_III_CFF,
  clasificarDeposito,
  puedePersistirseClasificacion,
  evaluarCasoDepositoSospechoso,
  calcularBalanceIva,
} from "./conciliacion/classification.ts";
export { verificarSpeiContraMovimientos, verificarPagoProveedor, verificadorSpeiExternoPendiente } from "./conciliacion/spei-matching.ts";
export type {
  NivelCoincidencia,
  SeveridadAlerta,
  MovimientoBancario,
  RegistroConciliable,
  CoincidenciaConciliacion,
  ResultadoConciliacion,
  OpcionesMatchingEngine,
  AlertaAntiguedad,
} from "./conciliacion/types.ts";
export type { ClasificacionDeposito, ResultadoClasificacionDeposito, CasoDepositoSospechoso, BalanceIva } from "./conciliacion/classification.ts";
export type { ResultadoVerificacionSpei, VerificadorSpeiExternoPort, ConsultaSpeiInput, ConsultaSpeiResultado } from "./conciliacion/spei-matching.ts";

// ---- Migración de catálogo contable (Fase 5) ----
export {
  normalizarTexto as normalizarTextoCatalogo,
  normalizarCodigo,
  normalizarCodigoEstricto,
  esMatchExacto,
  esAlertaRiesgo,
  similitudNombre,
  calcularScoreCompuesto,
  clasificarCuentaOrigen,
  clasificarCatalogo,
  PESO_NOMBRE,
  PESO_NIVEL,
  PESO_NATURALEZA,
  PESO_TIPO_AGREGADO,
  PESO_CUENTA_PADRE,
  UMBRAL_SIN_MATCH,
  NOTA_SIN_MATCH,
} from "./migracion-catalogo/matching.ts";
export { aprobarMapeo, rechazarMapeo, editarMapeo, validarCardinalidadAntesDeConfirmar, seleccionarMapeosActivosPorOrigen, migrarPoliza, migrarLote } from "./migracion-catalogo/migrador.ts";
export {
  TOLERANCIA_BALANCE_POLIZA,
  TOLERANCIA_CUADRE_MXN_DEFAULT,
  verificarConteoPolizas,
  detectarDiscrepanciasBalancePorPoliza,
  verificarBalancePorPoliza,
  calcularSaldoCuentaPeriodo,
  detectarDiscrepanciasCuadreSaldos,
  verificarCuadreSaldos,
  detectarReferenciasHuerfanas,
  verificarSinReferenciasHuerfanas,
  cerrarMigracion,
} from "./migracion-catalogo/verificacion.ts";
export { crearAdaptadorFailClosed } from "./migracion-catalogo/cross-db-port.ts";
export type { CatalogoOrigenPort, CatalogoDestinoPort } from "./migracion-catalogo/cross-db-port.ts";
export type {
  TipoMatchMigracion,
  EstadoMapeoMigracion,
  CuentaCatalogo,
  MapeoMigracionCuenta,
  NewMapeoMigracionInput,
  ResultadoMigracionPoliza,
  LineaPolizaOrigen,
  PolizaOrigen,
} from "./migracion-catalogo/types.ts";
export {
  MapeoNoEncontradoError,
  DecisionSinResponsableError,
  TransicionEstadoInvalidaError,
  DivisionUnoANoAutomaticaError,
  EstrategiaConciliacionRequeridaError,
  PolizaDesbalanceadaError,
  DiscrepanciaConteoPolizasError,
  DiscrepanciaBalancePolizaError,
  DiscrepanciaCuadreSaldoError,
  ReferenciasHuerfanasError,
  CuentaContableNoEncontradaError,
} from "./migracion-catalogo/types.ts";
export type { ClasificacionCuentaOrigen } from "./migracion-catalogo/matching.ts";
export type { LineaMigrada, MigracionPolizaResultado, DecisionMapeoOpciones } from "./migracion-catalogo/migrador.ts";
export type { ParCuadreSaldo, DiscrepanciaCuadreSaldo, DiscrepanciaBalancePoliza, InputCierreMigracion } from "./migracion-catalogo/verificacion.ts";

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
