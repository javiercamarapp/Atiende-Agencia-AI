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
  TIPOS_VENCIMIENTO_BASE,
  REGIMEN_FISCAL_POR_DEFECTO,
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

export { RepRfcAjenoError, analizarComplementoPago, proporcionCentavos } from "./cfdi/rep.ts";
export type { AnalisisDocumentoRep, AnalisisRep, FacturaLigable, FlujoRep, FuenteIvaRep } from "./cfdi/rep.ts";

export {
  ANIOS_CALENDARIO_VERIFICADOS,
  RegimenNoSoportadoError,
  calcularCalendarioFiscal,
  diaDeLaSemana,
  feriadosDelAnio,
  infoDiaInhabil,
  metadatosVencimiento,
  regimenSoportado,
  siguienteDiaHabil,
  sumarDias,
  tipoPersonaDeRegimen,
} from "./vencimientos/calendario-fiscal.ts";
export { barrerEscalamientosVencimientos, crearVencimientosDelPeriodo, esCheckViolation, registrarEscalamiento } from "./vencimientos/procesos.ts";
export type { ResultadoBarridoVencimientos, ResultadoCrearVencimientos } from "./vencimientos/procesos.ts";
export type { FeriadoFiscal, FechaLimiteHabil, ObligacionFiscalPeriodo, TipoPersona } from "./vencimientos/calendario-fiscal.ts";

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
  VER_CONCILIACION_ROLES,
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
  VER_DASHBOARD_ROLES,
  VER_REPORTES_ROLES,
  VER_CARTERA_ROLES,
  GESTIONAR_CARTERA_ROLES,
  VER_LIBRO_ROLES,
  GESTIONAR_LIBRO_ROLES,
  VER_PAGOS_PROVISIONALES_ROLES,
  GESTIONAR_PAGOS_PROVISIONALES_ROLES,
  VER_BITACORA_ROLES,
} from "./roles.ts";
export type { DespachosRole } from "./roles.ts";

// ---- Conciliación bancaria (Fase 5) ----
export { conciliarMovimientos, compatibilidadDireccion } from "./conciliacion/matching-engine.ts";
export type { CompatibilidadDireccion } from "./conciliacion/matching-engine.ts";
export { aCentavos as aCentavosConciliacion, buscarSubconjuntos, MITM_UMBRAL, PRESUPUESTO_NODOS_POR_DEFECTO } from "./conciliacion/subset-sum.ts";
export type { ItemSubsetSum, OpcionesSubsetSum, ResultadoSubsetSum } from "./conciliacion/subset-sum.ts";
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
  OpcionesSubsetSumMotor,
  AmbiguoMultilinea,
  MotivoSinConciliar,
  SinConciliarMovimiento,
  AlertaAntiguedad,
} from "./conciliacion/types.ts";
export type { ClasificacionDeposito, ResultadoClasificacionDeposito, CasoDepositoSospechoso, BalanceIva } from "./conciliacion/classification.ts";
export type { ResultadoVerificacionSpei, VerificadorSpeiExternoPort, ConsultaSpeiInput, ConsultaSpeiResultado } from "./conciliacion/spei-matching.ts";

// ---- Importación de estados de cuenta bancarios CSV/OFX (D-03) ----
export {
  parsearEstadoDeCuenta,
  parsearCsvEstadoCuenta,
  parsearOfxEstadoCuenta,
  detectarFormato as detectarFormatoEstadoCuenta,
  parsearMonto as parsearMontoEstadoCuenta,
  parsearFechaMx,
  parsearFechaOfx,
  clabeValida,
  bancoPorClabe,
  hashMovimiento as hashMovimientoEstadoCuenta,
  conceptoCanonico as conceptoCanonicoEstadoCuenta,
  BANCOS_MX,
  MAX_RENGLONES_ESTADO,
  construirVistaPreviaImportacion,
  MAX_MOVIMIENTOS_CONCILIACION,
} from "./conciliacion/estado-de-cuenta/index.ts";
export type {
  BancoMx,
  FormatoEstadoCuenta,
  ResultadoParseoEstado,
  MovimientoImportado,
  ErrorRenglonEstado,
  AdvertenciaEstado,
  OpcionesParseoEstado,
  VistaPreviaImportacion,
  CoincidenciaImportacion,
  EntradaVistaPrevia,
  CuentaPorCobrarPendiente,
  NuevoLoteEstadoCuenta,
  NuevoMovimientoEstadoCuenta,
  ResultadoGuardadoEstadoCuenta,
} from "./conciliacion/estado-de-cuenta/index.ts";

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
  DespachosAuditLogEntry,
  DespachosAuditLogPage,
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

// ---- D-01: dashboard gerencial y reportes de cliente (balanza/DIOT/nómina/impuestos) ----
export { calcularKpisCliente, consolidarKpisDespacho, DIAS_REVISION_ANTIGUA, DIAS_VENCIMIENTO_PROXIMO, SCORE_COBRANZA_BAJO } from "./dashboard/kpis.ts";
export type {
  AnomaliaDashboard,
  CarteraEntrada,
  CierreEntrada,
  EntradaKpisCliente,
  FuenteDashboard,
  KpisCartera,
  KpisCargaTrabajo,
  KpisCfdiMes,
  KpisCierres,
  KpisCliente,
  KpisDespacho,
  NivelAtencion,
  SeveridadAnomalia,
} from "./dashboard/kpis.ts";
export { construirDiotDesdeInvoices, candidatosDiotDesdeInvoices } from "./declaraciones/diot-desde-invoices.ts";
export type { DiotDesdeInvoices } from "./declaraciones/diot-desde-invoices.ts";
export { TIPOS_REPORTE_CLIENTE, ETIQUETA_TIPO_REPORTE } from "./reportes/types.ts";
export type { CeldaReporte, ColumnaReporte, ReporteCliente, ReporteTabular, SeccionReporte, TipoColumnaReporte, TipoReporteCliente } from "./reportes/types.ts";
export { construirReporteBalanza, construirReporteCliente, construirReporteDiot, construirReporteImpuestos, construirReporteNomina } from "./reportes/builders.ts";
export type { EntradaReporte } from "./reportes/builders.ts";
export { crc32, crearZipStored, nombreHojaSeguro, reporteAXlsx, XLSX_CONTENT_TYPE } from "./reportes/xlsx.ts";
export { leerKpisCliente, leerFuenteOpcional, MAX_PERIODOS_CIERRE_ABIERTOS } from "./dashboard/lectura.ts";
export type { ClienteDashboardRef } from "./dashboard/lectura.ts";
export { construirDiotLayout, generarDiotTxt, generarDiotXml, redondearPesos, esRfcValidoDiot, DiotLayoutError, COLUMNAS_DIOT, LAYOUT_DIOT_VERSION } from "./declaraciones/diot-layout.ts";
export type { DiotLayout, RenglonDiotLayout, DiotOmitido, DiotTipoTercero } from "./declaraciones/diot-layout.ts";
export {
  parsearListado69B,
  decodificarListado69B,
  hallazgoEfosParaCfdi,
  aplicarEfosAlResultado,
  esPeriodoEfosValido,
  Efos69bFormatoError,
  EFOS_NO_DISPONIBLE,
  EFOS_RFC_RE,
  CODIGO_EFOS_DEFINITIVO,
  CODIGO_EFOS_PRESUNTO,
} from "./cfdi/efos.ts";
export type { EfosSituacion, EfosContribuyente, EfosConsulta, EfosListadoParseado, EfosFilaDescartada, HallazgoEfos } from "./cfdi/efos.ts";
export type { EfosEstadoLista, EfosInvoiceAfectado, EfosAfectadosResultado, EfosIngestaResultado } from "./repository.ts";
export { EfosUnavailableError } from "./errors.ts";

// "Chatea con tus datos": catalogo cerrado de herramientas de solo lectura (ver docs/DATA-CHAT.md).
export * from "./data-chat/index.ts";

// D-08: portal del cliente final del despacho (enlace con token, subida estricta, estatus, mensajes).
export * from "./portal-cliente/index.ts";
// D-11: cola de cobranza (gestiones por factura/cliente, reporte de cartera, outbox de WhatsApp con opt-in/opt-out).
export * from "./cola-cobranza/index.ts";


// D-21: cartera de clientes del despacho (ficha fiscal por property).
export * from "./cartera/index.ts";

// D-22: modelo CFDI completo (direccion emitido/recibido, centavos enteros, impuestos desglosados, estado SAT).
export {
  clasificarDireccionCfdi,
  aCentavos,
  montosCfdiACentavos,
  normalizarCamposPagoCfdi,
  impuestosDesdeXml,
  esEstadoSatCfdi,
  ESTADOS_SAT_CFDI,
  NOMBRE_IMPUESTO,
  MontoInvalidoError,
} from "./cfdi/modelo-cfdi.ts";
export type {
  DireccionCfdi,
  EstadoSatCfdi,
  ImpuestoCfdiInput,
  ImpuestoCfdiRecord,
  CamposPagoCfdi,
  MontosCfdiCentavos,
  MontosCfdiEntrada,
  NaturalezaImpuesto,
  TipoFactorImpuesto,
} from "./cfdi/modelo-cfdi.ts";
export { EstadoSatNoDisponibleError, EstadoSatInvalidoError, InvoiceNoEncontradoError } from "./errors.ts";

// D-24: libro contable persistido (catálogo por cliente, pólizas con folio, balanza derivada, póliza de un CFDI).
export * from "./libro/index.ts";
// D-35 + D-02: conciliación bancaria persistida (sesiones, matches confirmados, sugerencias del nivel 4 con aprobación humana).
export * from "./conciliacion/persistida/index.ts";

// D-25: pagos provisionales de ISR/IVA (papel de trabajo por flujo de efectivo, pagos de REP persistidos).
export * from "./pagos-provisionales/index.ts";

// D-27: consulta publica del estatus de un CFDI ante el SAT (puerto + adaptador SOAP).
export * from "./cfdi/estatus-sat/index.ts";

// D-26/D-27/D-28: repositorio de solo sistema de los crons (migracion 022).
export * from "./cron-sat/index.ts";

// D-13: carga masiva de CFDI (contrato del resultado por archivo, totales, enrutado por tipo de comprobante).
export * from "./cfdi/lote.ts";
