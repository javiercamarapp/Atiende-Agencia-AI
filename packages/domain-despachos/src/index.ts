export {
  validarCfdiDespachos,
  TOLERANCIA,
} from "./cfdi/reglas-fiscales-avanzadas.ts";
export type { DatosCfdiDespachos, ResultadoValidacionCfdiDespachos, DiotResult, ProveedorReportableDiot, NominaCfdi } from "./cfdi/reglas-fiscales-avanzadas.ts";

// ---- Declaraciones ISR/IVA/RESICO + DIOT (Fase 2) ----
export {
  ISR_MENSUAL_2025,
  ISR_ANUAL_2025,
  ISR_MENSUAL_2026,
  ISR_ANUAL_2026,
  ISR_PF_MENSUAL_2025,
  ISR_PF_ANUAL_2025,
  RESICO_PF_MENSUAL,
  ISR_PM_MENSUAL_RESICO,
  ISR_PM_TASA,
} from "./declaraciones/isr-tablas.ts";
export type { TablaIsr, FilaTablaIsr } from "./declaraciones/isr-tablas.ts";

export { aplicarTablaIsr, calcularIsrPf, calcularIsrPm, calcularIsrPmResico } from "./declaraciones/isr-engine.ts";
export type { OpcionesIsrPf, OpcionesIsrPmResico } from "./declaraciones/isr-engine.ts";

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
export { generarXmlCfdiNomina, TIPOS_NOMINA, CLAVES_ENT_FED } from "./nomina/xml-nomina.ts";
export type { DatosEmisorNominaXml, DatosReceptorNominaXml, DatosPeriodoNominaXml, DatosLaboralesNominaXml, TipoNomina } from "./nomina/xml-nomina.ts";

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
  VER_REVISIONES_ROLES,
  RESOLVER_REVISION_ROLES,
  VER_CFDI_ROLES,
  INGESTA_CFDI_ROLES,
  VER_VENCIMIENTOS_ROLES,
  GESTION_VENCIMIENTOS_ROLES,
  VER_DECLARACIONES_ROLES,
  DECLARACIONES_ROLES,
  NOMINA_ROLES,
  CONCILIACION_ROLES,
  VER_MIGRACION_CATALOGO_ROLES,
  MIGRACION_CATALOGO_ROLES,
  DECIDIR_MAPEO_MIGRACION_ROLES,
  VER_DEVOLUCION_IVA_ROLES,
  DEVOLUCION_IVA_ROLES,
  VER_BOOKKEEPING_ROLES,
  BOOKKEEPING_ROLES,
  VER_CONTABILIDAD_ELECTRONICA_ROLES,
  CONTABILIDAD_ELECTRONICA_ROLES,
  VER_CIERRE_MENSUAL_ROLES,
  GESTIONAR_CIERRE_MENSUAL_ROLES,
  CERRAR_PERIODO_ROLES,
  VER_COBRANZA_ROLES,
  GESTIONAR_COBRANZA_ROLES,
  ADMIN_ROLES,
  STAFF_INVITE_ROLES,
  PLATFORM_ROLE_BY_VERTICAL_ROLE,
  VER_CONFIGURACION_ROLES,
  GESTIONAR_CONFIGURACION_ROLES,
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

// ---- Conciliación bancaria — nivel 4 asistido por LLM (Fase 11) ----
export {
  DEFAULT_DESPACHOS_CONCILIACION_LLM_ROLE,
  TOKEN_PRE_FILTER_THRESHOLD as TOKEN_PRE_FILTER_THRESHOLD_CONCILIACION_LLM,
  sugerirMatchesLLM,
  aprobarSugerenciaLLM,
  resolverIndiceOriginal,
  ActorSinPermisoParaConciliacionLLMError,
  SugerenciaLLMFallidaError,
  RespuestaLLMInvalidaError,
  AprobacionSugerenciaLLMRechazadaError,
} from "./conciliacion/llm-matching-agent.ts";
export type {
  SugerenciaMatchLLM,
  CoincidenciaConciliacionLLM,
  MovimientoSinSugerenciaLLM,
  ResultadoSugerenciasLLM,
  SugerirMatchesLLMOptions,
} from "./conciliacion/llm-matching-agent.ts";

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

export {
  IdempotencyConflictError,
  InvoiceAlreadyExistsError,
  InvoiceReviewAlreadyResolvedError,
  PeriodoCerradoError,
  PeriodoYaAbiertoError,
  CierreValidacionError,
  TareaCierreEstadoInvalidoError,
  TransicionPaqueteContabilidadInvalidaError,
  ReceivableAlreadyExistsError,
  ReceivableAlreadyPaidError,
  DespachosConfigUnavailableError,
} from "./errors.ts";

// ---- Contabilidad electrónica SAT — catálogo/balanza/paquete Anexo 24
// (cierre de gap de auditoría) ----
export {
  NATURALEZAS_VALIDAS as CE_NATURALEZAS_VALIDAS,
  CATALOGO_ANEXO24_BASE,
  CATEGORIA_A_CUENTA_ANEXO24,
  crearCatalogoBase,
  findCuenta as findCuentaAnexo24,
  erroresCatalogo as erroresCatalogoAnexo24,
  validarCatalogo as validarCatalogoAnexo24,
  mergeCuentas as mergeCuentasAnexo24,
  asignarAutomatico as asignarAutomaticoAnexo24,
  generarXmlCatalogo,
  acumularAsientos,
  generarBalanza,
  resumenBalanza,
  validarCuadratura,
  detectarSaldosAnomalos,
  generarXmlBalanza,
  calcularHashSha1,
  generarPaqueteContabilidadElectronica,
  generarResumenMensual,
  marcarListoParaTimbrar,
  marcarTimbrado,
  marcarEnviado,
  ESTADOS_PAQUETE_CONTABILIDAD,
  ESTADO_INICIAL_PAQUETE_CONTABILIDAD,
} from "./contabilidad-electronica/index.ts";
export type {
  OpcionesXmlCatalogo,
  TipoEnvioBalanza,
  OpcionesXmlBalanza,
  DatosGenerarPaquete,
  NaturalezaCuenta as NaturalezaCuentaAnexo24,
  CuentaAnexo24,
  AsientoContable,
  LineaBalanza,
  LineaBalanzaAnomala,
  ResumenBalanza,
  EstadoPaqueteContabilidad,
  ArchivoContabilidadElectronica,
  PaqueteContabilidadElectronica,
  ResumenMensualContabilidad,
} from "./contabilidad-electronica/index.ts";

// ---- Devolución de IVA (Fase 6) ----
export {
  recopilarFacturas,
  clasificarIva,
  ivaAcreditableEfectivamentePagado,
  generarDiotDevolucionIva,
  validarRfc as validarRfcDevolucionIva,
  validarTasaIva,
  validarDiot,
  conciliarFacturasDiot,
  conciliarDiotDeclaracion,
  conciliarDeclaracionSaldo,
  calcularSaldoFavor,
  calcularMontoDevolucion,
  validarCongruenciaDiotCfdiDeclaracion,
  UMBRAL_CONGRUENCIA_MONTO,
  TOLERANCIA_CONGRUENCIA_MXN,
  digitoVerificadorClabe,
  validarClabe,
  prepararSolicitud,
  DIAS_HABILES_PLAZO_RESOLUCION,
  DIAS_HABILES_PLAZO_RESOLUCION_CON_DICTAMEN_O_GARANTIA,
  MEXICO_HOLIDAYS_2026,
  sumarDiasHabiles,
  calcularFechaLimiteResolucion,
} from "./devolucion-iva/calculo.ts";
export { generarPapelTrabajo, ADVERTENCIA_ART_59_FRACC_III } from "./devolucion-iva/workpaper.ts";
export type {
  TipoFacturaIva,
  ClasificacionIva,
  EstatusConciliacionIva,
  EstatusDevolucion,
  EstadoEnvioSolicitud,
  FacturaCfdiIva,
  DiotFacturaDetalleIva,
  DiotEntryIva,
  DeclaracionMensualIva,
  ConciliacionFacturaDiot,
  ConciliacionDiotDeclaracion,
  ConciliacionDeclaracionSaldo,
  MontoDevolucion,
  CongruenciaDiotCfdiDeclaracion,
  SolicitudDevolucion,
} from "./devolucion-iva/types.ts";
export type { ClasificacionIvaResultado, SaldoDevolucionInput } from "./devolucion-iva/calculo.ts";
export type { PapelTrabajoDevolucionIva } from "./devolucion-iva/workpaper.ts";

// ---- Bookkeeping / auto-clasificador de pólizas (Fase 6) ----
export { CATALOGO_CUENTAS_SAT, DEFAULT_MAPPINGS, mappingKey } from "./bookkeeping/catalogo.ts";
export { getMapping, getAccountName, validateAccount, generatePoliza, getAllCategories, generateAdjustment, generateDepreciationEntry, generateProvisionEntry, validatePoliza } from "./bookkeeping/rules-engine.ts";
export { SYNTHETIC_PATTERNS, clasificarPorReglas, sugerirCategoria, predecirCategoria, necesitaRevisionHumana } from "./bookkeeping/clasificador.ts";
export { CONFIDENCE_FLOOR, CONFIDENCE_MEDIUM, CONFIDENCE_HIGH, DEFAULT_CONFIDENCE_THRESHOLD } from "./bookkeeping/confianza.ts";
export { getRfcCategoryFeedback, getAllRfcFeedback, getSuggestionsForRetraining } from "./bookkeeping/overrides.ts";
export type { TipoCfdiBookkeeping, PolizaType, LineaTipo, CfdiClassification, LineaPoliza, PolizaContable, AccountMapping, OverrideRecord, SuggestionRetraining } from "./bookkeeping/types.ts";
export type { MapeosCustom, EntradaManual, ActivoDepreciacion } from "./bookkeeping/rules-engine.ts";
export type { PrediccionCategoria } from "./bookkeeping/clasificador.ts";

// ---- Cierre mensual (Fase 6) ----
export { DEFAULT_MONTHLY_CLOSE_TEMPLATE, getTemplate } from "./cierre-mensual/templates.ts";
export {
  construirTareasDesdePlantilla,
  verificarPeriodoNoDuplicado,
  completarTarea,
  autoCheckTareas,
  recomputeOverdue,
  calcularEstadoPeriodo,
  evaluarCierre,
  cerrarPeriodo,
  generarReporteCierre,
  estaPeriodoCerrado,
} from "./cierre-mensual/engine.ts";
export {
  validateBalanceCuadrada,
  validatePolizasCuadradas,
  validateNominaCuadrada,
  validateIvaConciliado,
  validateIsrProvisionado,
  validateBancosConciliados,
} from "./cierre-mensual/validaciones.ts";
export type { ClosePeriodStatus, TaskStatus, TaskCategory, CloseTask, ClosePeriod, CloseTemplateTask, CloseTemplate } from "./cierre-mensual/types.ts";
export type { NuevaTareaCierre, AutoCheckResultado, EstadoPeriodoCierre, DecisionCierre, ReporteCierre } from "./cierre-mensual/engine.ts";
export type { ValidationResult as ValidacionCierreResult } from "./cierre-mensual/validaciones.ts";
export type { NewPeriodoCierreInput } from "./cierre-mensual/repository-types.ts";

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
  ReceivableRecord,
  NewReceivableInput,
  ReceivableReminderRow,
  CollectionEventStage,
  CollectionEventChannel,
  CollectionEventRecord,
  NewCollectionEventInput,
  NewSystemCollectionEventInput,
  DespachosPropertyConfigRecord,
} from "./types.ts";

export type { DespachosRepository, InvoicePage, OrganizationNotificationRecipient, EmailOutboxJobRow } from "./repository.ts";
export { InMemoryDespachosRepository } from "./in-memory-repository.ts";
export { PostgresDespachosRepository } from "./postgres-repository.ts";

// ---- Infraestructura de correo (hallazgo de auditoría, severidad ALTA:
// "despachos no tiene ninguna infraestructura de correo, mientras
// citas/rentas/licitaciones sí la tienen") — mismo patrón EXACTO que
// domain-citas/domain-licitaciones (leídos primero como plantilla). ----
export { escapeHtml, renderCorreo } from "./emails/layout.ts";
export type { EtiquetaPlantilla, FilaPlantilla, SeccionPlantilla } from "./emails/layout.ts";
export { correoEscalamientoVencimiento } from "./emails/vencimiento-templates.ts";
export type { EscalamientoVencimientoCorreo, Correo as CorreoVencimiento } from "./emails/vencimiento-templates.ts";
export { correoInvitacionStaff } from "./emails/staff-invite-template.ts";
export type { StaffInviteCorreo, Correo as CorreoInvitacionStaff } from "./emails/staff-invite-template.ts";
export { enqueueEscalationEmailCore, tryEnqueueEscalationEmail } from "./vencimientos/email-notifications.ts";
export type { EscalationEmailEnqueueResult } from "./vencimientos/email-notifications.ts";
export { construirCorreoCobranza } from "./cobranza/email-templates.ts";
export type { Correo as CorreoCobranza } from "./cobranza/email-templates.ts";
export {
  enqueueCollectionReminderEmailCore,
  tryEnqueueCollectionReminderEmail,
  enqueueCollectionReminderEmailForSystemCore,
  tryEnqueueCollectionReminderEmailForSystem,
} from "./cobranza/email-notifications.ts";
export type { CollectionReminderEmailResult, FacturaCobranza } from "./cobranza/email-notifications.ts";
export { dispatchPendingEmailJobs, MAX_EMAIL_DISPATCH_ATTEMPTS, sendEmailOutboxJob } from "./email-dispatch.ts";
export type { EmailDispatchSummary, ResendConfig } from "./email-dispatch.ts";

// ---- Cobranza automatizada (Fase 10) — puerto de b2b_ai/services/
// collections.py + collections_report.py + collections_templates.py ----
export {
  COBRANZA_AGE_BUCKETS,
  cobranzaAgeBucket,
  diasVencidoCartera,
  etapaRecordatorioCobranzaHoy,
  scoreCobrabilidadCartera,
  analizarCarteraCobranza,
  reporteAntiguedadCartera,
  proyeccionCobranza,
  resumenCobranza,
  construirRecordatorioCobranza,
  COBRANZA_REMINDER_SEQUENCE,
  COBRANZA_STAGE_OFFSET_DAYS,
} from "./cobranza/engine.ts";
export type {
  CobranzaAgeBucket,
  CuentaPorCobrarInput,
  CuentaPorCobrarAnalizada,
  CuentaPorCobrarConScore,
  BucketCartera,
  CarteraAnalizada,
  ReporteAntiguedadCartera,
  ProyeccionCobranza as ProyeccionCobranzaResultado,
  ResumenCobranza as ResumenCobranzaResultado,
  TopMontoCartera,
  HistorialCobranzaEntry,
  RecordatorioCobranza,
  CobranzaReminderStage,
} from "./cobranza/engine.ts";
export { formatMontoCobranza, renderRecordatorioCobranza, renderAsuntoRecordatorioCobranza } from "./cobranza/templates.ts";
