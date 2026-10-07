export type { StorefrontCatalogRow } from "./types.ts";
export { evaluarDomicilioSucursal, describirDiasDomicilio, insigniaDomicilio, mensajeDomicilioNoDisponible, type EstadoDomicilio } from "./domicilio-sucursal.ts";
export type {
  Branch,
  BranchPolicy,
  BranchProductState,
  BranchSummary,
  BranchTimezoneConfig,
  CallbackRequest,
  CallbackRequestInput,
  CallbackRegistro,
  CanalPedido,
  Category,
  CategoryPatch,
  CreateOrderInput,
  CreateOrderItemInput,
  Customer,
  CustomerAddress,
  CarteraKpis,
  CustomerFrecuencia,
  CustomerListFilter,
  CustomerListItem,
  CustomerListPage,
  FilaImportacionCliente,
  ResultadoImportacionClientes,
  CustomerLookupResult,
  CustomerTier,
  DefaultComplement,
  KnownZone,
  NearestBranchMatch,
  NewCategoryInput,
  NewKnownZoneInput,
  NoDomicilioMarks,
  NewProductInput,
  NewPromotionInput,
  BranchHoursException,
  DoubleSalsa,
  NewBranchHoursExceptionInput,
  Order,
  OrderHistoryItem,
  OrderPickupInfo,
  OrderListFilter,
  OrderListPage,
  OrderQuote,
  OrderStatus,
  PersistedOrderItem,
  Product,
  ProductPatch,
  ProductoEncontrado,
  Promotion,
  PromotionPatch,
  PromotionType,
  PropinaPolitica,
  QuotedOrderLine,
  RegistrarAuditoriaInput,
  RequestedComplement,
  RequestedOrderItemInput,
  RestaurantesAuditEntityType,
  RestaurantesAuditLogFiltro,
  RestaurantesAuditLogPagina,
  RestaurantesAuditLogPaginacion,
  RestaurantesAuditLogRow,
  TortillaChoice,
  WhatsAppChannelResolution,
  WhatsappBranchChannel,
  WhatsappChannelConfig,
} from "./types.ts";
export { EMPTY_BRANCH_POLICY, CUSTOMER_FRECUENCIAS, CUSTOMER_TIERS } from "./types.ts";

export { OrderConflictError, OrderValidationError, PromotionError, WhatsappNumberInUseError } from "./errors.ts";

export {
  validarHorario,
  leerHorarioPersistido,
  estaAbiertoAhora,
  mensajeSucursalCerrada,
  aperturaConExcepciones,
  horarioDePuente,
  horarioParaFecha,
  validarExcepcionHorario,
  fechaLocal,
  fechaAnterior,
  corteDiaNegocioMinutos,
  diaDeNegocio,
} from "./horarios.ts";
export type { TurnoHorario, HorarioSucursal, EstadoApertura, ApreturaConExcepciones } from "./horarios.ts";
export { reporteColoniasAmbiguas, UMBRAL_AMBIGUA_KM } from "./colonias-ambiguas.ts";
export type { FilaColoniaAmbigua, MotivoRevisionColonia, ReporteColoniasAmbiguas } from "./colonias-ambiguas.ts";
export { aplicarReglasDeSucursal, normalizarCanal, debePreguntarPropina, matchKnownZone, COLONIA_FUERA_DE_VERIFICACION_MENSAJE } from "./reglas-pedido.ts";
export type { ReglasSucursalArgs, ReglasSucursalResultado } from "./reglas-pedido.ts";

export { normalizePromotionCode, assertPromotionApplicable, computePromotionDiscount, applyPromotionToOrderTotal, applyPromotionToOrder, computeBogoDiscount, computeCortesiaDiscount, selectAutomaticPromotion, PROMOTION_CODE_PATTERN } from "./promotions.ts";

export { normalizePhone, canonicalizeMexicanPhone, toWhatsAppRecipient, maskPhone } from "./phone.ts";
export { prepararImportacionClientes, IMPORTACION_MAX_FILAS } from "./clientes-importacion.ts";
export type { ErrorRenglonImportacion, PreparacionImportacion } from "./clientes-importacion.ts";

export { RESTAURANTES_ROLES, MANAGER_ROLES, REPARTIDOR_ROLES, STAFF_INVITE_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE, isRestaurantesRole, ACCIONES_RESTAURANTES, ACCIONES_RESTAURANTES_LISTA, rolesParaAccion, puedeEjecutar, permisosEfectivos } from "./roles.ts";
export type { RestaurantesRole, AccionRestaurantes } from "./roles.ts";

export { tokenizeForProductSearch, matchesProductSearch, sinAcentos, requiresTortillaChoice, extraerPackSize, requiresAdultConfirmation, resolveOrderItemsAgainstProducts, UUID_PATTERN } from "./product-search.ts";

export { DEFAULT_COMPLEMENTS, PM_BASIC_COMPLEMENTS, TORTILLA_CHOICES, buildComplementNotes, buildDoubleSalsaLine, buildOrderQuoteFromProducts, findExtraSalsaProduct, isTortillaChoice } from "./order-quote.ts";

export type {
  RestaurantesRepository,
  SearchableProduct,
  NewOrderRecord,
  ConversationMessage,
  KpiDateRange,
  SalesBucketRow,
  ChannelStatsRow,
  WhatsAppConversationStatsRow,
  TopCustomerRow,
  CustomerOverviewRow,
  TierDistributionMetric,
  TierDistributionRow,
  MessagingOutboxRow,
  StaffOrderNotificationEventType,
  StaffOrderNotificationRecord,
  EmailOutboxJobRow,
} from "./repository.ts";
export { RestaurantesConfigUnavailableError } from "./repository.ts";
export { InMemoryRestaurantesRepository } from "./in-memory-repository.ts";
export { PostgresRestaurantesRepository } from "./postgres-repository.ts";

export { lookupCustomer, lookupCustomerConPedidoReciente, getCustomerDetailById, vipNote } from "./customers.ts";
export { buscarPedidoReciente, estadoParaCliente, VENTANA_PEDIDO_RECIENTE_MIN } from "./pedido-reciente.ts";
export type { EstadoPedidoParaCliente, PedidoReciente } from "./pedido-reciente.ts";

export {
  ORDER_STATUSES,
  PICKUP_ONLY_STATUSES,
  esPedidoParaRecoger,
  OrderStatusTransitionError,
  isOrderStatus,
  nextValidStatuses,
  assertValidOrderStatusTransition,
  changeOrderStatus,
  REPARTIDOR_ALLOWED_STATUSES,
  assertValidRepartidorStatusTransition,
  changeAssignedOrderStatus,
  assertOrderCanBeDispatched,
} from "./order-lifecycle.ts";

export { searchProducts, prepareCreateOrder, createOrder, redondearACentavos, quoteOrder, resolveBranchOrderItems, validateCreateOrderPayload } from "./orders.ts";
export type { PreparedOrder, QuotePolicyInfo, QuotePromotionInfo } from "./orders.ts";

export {
  notifyCustomerOnOrderStatusChangeCore,
  tryNotifyCustomerOnOrderStatusChange,
  PLANTILLAS_ESTADO_PEDIDO,
  plantillaParaEstado,
  notifyStaffNewOrderCore,
  tryNotifyStaffNewOrder,
  notifyStaffOrderProblemCore,
  tryNotifyStaffOrderProblem,
  notifyStaffRepartidorAssignedCore,
  tryNotifyStaffRepartidorAssigned,
  notifyCustomerOrderConfirmationEmailCore,
  tryNotifyCustomerOrderConfirmationEmail,
} from "./order-notifications.ts";
export type { CustomerOrderNotificationResult, CustomerOrderConfirmationEmailResult } from "./order-notifications.ts";

// Fase de correo — ver emails/layout.ts, emails/order-templates.ts,
// emails/staff-invite-template.ts, email-dispatch.ts.
export { escapeHtml, renderCorreo } from "./emails/layout.ts";
export type { EtiquetaPlantilla, FilaPlantilla, SeccionPlantilla } from "./emails/layout.ts";
export { correoConfirmacionPedido } from "./emails/order-templates.ts";
export type { PedidoCorreo, PedidoCorreoItem, Correo as PedidoCorreoResultado } from "./emails/order-templates.ts";
export { correoInvitacionStaff } from "./emails/staff-invite-template.ts";
export type { StaffInviteCorreo, StaffInviteVerticalRole, Correo as StaffInviteCorreoResultado } from "./emails/staff-invite-template.ts";
export { dispatchPendingEmailJobs, MAX_EMAIL_DISPATCH_ATTEMPTS, sendEmailOutboxJob } from "./email-dispatch.ts";
export type { EmailDispatchSummary, ResendConfig } from "./email-dispatch.ts";

export { registerCallbackRequest } from "./callback-requests.ts";

export { findNearestBranch, normalizeZoneText, haversineKm, COLONIA_NO_RECONOCIDA_MENSAJE } from "./nearest-branch.ts";
export type { NearestBranchResult } from "./nearest-branch.ts";
export { assignBranch, rankBranchesByKm, FUERA_DE_ZONA_MENSAJE } from "./branch-assignment.ts";
export type { AssignBranchInput, BranchAssignment, BranchAssignmentVia, RankedBranch } from "./branch-assignment.ts";

export { actorHash, requestActor, consumeRateLimit } from "./rate-limit.ts";

export { verifyMetaSignature } from "./whatsapp/meta-signature.ts";
export { extractMetaInboundMessages, extractMetaTextMessages, extractMetaPhoneNumberId, resolveOrganizationByPhoneNumberId, resolveWhatsAppChannel } from "./whatsapp/channel-config.ts";
export type { MetaTextMessage } from "./whatsapp/channel-config.ts";
export {
  LIMITE_NOTAS_POR_CONVERSACION_HORA,
  LIMITE_NOTAS_POR_ORGANIZACION_DIA,
  NOTA_DE_VOZ_MAX_BYTES,
  NOTA_DE_VOZ_MAX_SEGUNDOS,
  NotaDeVozError,
  PREFIJO_NOTA_DE_VOZ,
  TRANSCRIPCION_MAX_CARACTERES,
  formatearNotaDeVoz,
  registrarMotivo as registrarMotivoNotaDeVoz,
  resolverCuerpoConNotaDeVoz,
  transcribirNotaDeVoz,
} from "./whatsapp/nota-de-voz.ts";
export type { AudioDescargado, MotivoSinTranscripcion, NotaDeVozEntrante, PuertoNotasDeVoz, ResultadoNotaDeVoz, TranscripcionDeEntrada } from "./whatsapp/nota-de-voz.ts";
export { splitMetaPayloadByChannel } from "./whatsapp/batch-routing.ts";
export type { MetaChannelBatch } from "./whatsapp/batch-routing.ts";
export { redactSensitiveInfo, handleInboundWhatsAppMessage, recibirMensajeConEspera, responderTrasEspera, mensajesSinResponder, usuariosRespondidos, analizarHistorial, MAX_PASADAS_RAFAGA, esperaEfectivaMs, FUNCION_MAX_MS, PASADA_ESTIMADA_MS, liberarTurnoTrasFalloDeFaseB } from "./whatsapp/inbound.ts";
export type { RecepcionConEspera } from "./whatsapp/inbound.ts";
export type { InboundMessageOutcome } from "./whatsapp/inbound.ts";
export { createRestaurantesMessagingOutboxPort } from "./whatsapp/outbox-adapter.ts";
export { UMBRAL_AVISOS_AGRUPADOS, procesarEstadosEntrega } from "./whatsapp/estados-entrega.ts";
export type { EmisionEntregaFallida, EventoEntregaFallida, ProcesarEstadosEntregaOptions, ResumenEstadosEntrega } from "./whatsapp/estados-entrega.ts";
export type { EstadoEntregaEntrante, MotivoFalloEntregaGuardado, RegistroEstadoEntrega } from "./repository.ts";
export { acknowledgeOnlyTurnHandler } from "./whatsapp/turn-handler.ts";
export type { WhatsAppTurnHandler } from "./whatsapp/turn-handler.ts";

export { createLlmWhatsAppTurnHandler, bloqueConocimientoDelTurno, FALLBACK_CONFIG, PM_CONFIG_POR_OMISION, getAgentConfig, resolveAgentConfig, TOOLS, TONE_INSTRUCTIONS, enforceBistecPackNotice, saludoSegunHora, providerFailureReply } from "./whatsapp/llm-turn-handler.ts";
export type { WhatsAppLlmAgentConfig, WhatsAppLlmAgentOptions, WhatsAppToneStyle } from "./whatsapp/llm-turn-handler.ts";
export { hashTelefonoParaLogs } from "./whatsapp/observabilidad-turno.ts";
export type { EventoObservabilidadWhatsApp, EventoToolWhatsApp, EventoTurnoWhatsApp, ObservabilidadTurno, ResultadoTool, ResultadoTurno } from "./whatsapp/observabilidad-turno.ts";

export {
  STATS_PERIODS,
  isStatsPeriod,
  buildTrendBuckets,
  buildComparisonPeriods,
  horasAbiertasHoy,
  periodLabel,
  getSalesKpis,
  getSalesTrendKpis,
  getChannelKpis,
  computeChannelKpis,
  channelPeriodLabel,
  getCustomerKpis,
  computeCustomerKpis,
} from "./kpis.ts";
export type { OpcionesTramos, StatsPeriod, TrendBucket, ComparisonPeriods, SalesSummary, SalesTrendPoint, ChannelKpis, CustomerKpis } from "./kpis.ts";
export * from "./voz/index.ts";
export * from "./whatsapp-kpi/index.ts";
export * from "./cierres/index.ts";
export * from "./autopiloto/index.ts";
export * from "./repartidor-perfil/index.ts";
export * from "./exportar/index.ts";
export { PM_COPY, buildPmSystemPrompt, pmCustomerContextBlock, saludoPorHora } from "./whatsapp/perfil-pm.ts";
export type { PerfilPmContexto, SaludoPorHora } from "./whatsapp/perfil-pm.ts";
export { MOTIVOS_ESCALACION_DESACTIVABLES, PERFILES_AGENTE_WHATSAPP, TONOS_AGENTE_WHATSAPP } from "./types.ts";
export type {
  MotivoEscalacionDesactivable,
  PerfilAgenteWhatsApp,
  TonoAgenteWhatsApp,
  WhatsAppAgentConfigAccion,
  WhatsAppAgentConfigHistorialEntry,
  WhatsAppAgentConfigInput,
  WhatsAppAgentConfigRow,
} from "./types.ts";
export { WhatsAppAgentConfigConflictError, ClienteMemoriaNoDisponibleError } from "./errors.ts";

// Cliente 360 (migracion 049): memoria del cliente, gustos, repetir pedido y ficha del staff.
export { PREFERENCE_KINDS, isPreferenceKind, POLITICA_POR_OMISION } from "./cliente-360/types.ts";
export type {
  ClosureAddress,
  ClosureObservation,
  CustomerAddressChanges,
  CustomerAddressDetail,
  CustomerFicha,
  CustomerMemory,
  CustomerPolicy,
  CustomerPreference,
  CustomerProfilePatch,
  CustomerReliability,
  OrderClosureInput,
  PastOrder,
  PreferenceAction,
  PreferenceKind,
  TasteProposal,
} from "./cliente-360/types.ts";
export { extraerObservaciones, extraerDomicilio, proponerGustos, describirGusto, MIN_VECES_PARA_PROPONER } from "./cliente-360/gustos.ts";
export { repetirPedido, elegirPedido } from "./cliente-360/repetir.ts";
export type { CambioDeRepeticion, PedidoRepetido, RenglonRepetido } from "./cliente-360/repetir.ts";
export { cargarMemoria, cerrarCicloDelCliente, evaluarReincidencia } from "./cliente-360/memoria.ts";
export type { DecisionReincidencia } from "./cliente-360/memoria.ts";
export type { PedidoAnteriorResumen } from "./types.ts";
export {
  AGENTE_LIMITES,
  ESPERA_RAFAGAS_MAX_SEGUNDOS,
  configPorDefectoDelPerfil,
  diffLineasPrompt,
  diferenciasConfigAgente,
  fotoConfigAgente,
  previewPromptAgente,
  validarConfigAgenteWhatsapp,
  valoresPorOmisionDelPerfil,
} from "./whatsapp/agent-config-editor.ts";
export type { DiferenciaCampo, LineaDiff, ResultadoValidacion } from "./whatsapp/agent-config-editor.ts";
export * from "./conversaciones/index.ts";
// R-19/R-20: organizacion demo (marca, widget publico de chat sin Meta, telefonos ficticios).
export * from "./demo/index.ts";
// R-33: checklist de onboarding calculado con datos reales.
export * from "./onboarding.ts";

export {
  AGENT_TOOL_DEFINITIONS,
  MOTIVOS_ESCALACION,
  normalizarMotivoEscalacion,
  VOICE_TOOL_HTTP_PATHS,
  FOLIO_PREVIEW_PREFIJO,
  TELEFONO_PREVIEW_PREFIJO,
  esTelefonoPreview,
  telefonoFicticioPreview,
  exportVoiceToolManifest,
  executeAgentToolSafely,
  invokeAgentTool,
  mapCreateOrderToolInput,
  toolDefinitionsForChannel,
} from "./agent-tools/registry.ts";
export type { MotivoEscalacion } from "./agent-tools/registry.ts";
export type { AgentChannel, AgentToolMode, AgentToolContext, AgentToolDefinition, AgentToolJsonSchema, AgentToolName, AgentToolOutcome } from "./agent-tools/registry.ts";
export {
  CLAIM_STALE_MS,
  OrderFlowViolationError,
  QUOTE_TTL_MS,
  assertCanConfirm,
  assertCanCreate,
  fingerprintOrder,
} from "./agent-tools/order-flow.ts";
export type { OrderFlowContext, OrderFlowSnapshot, OrderFlowState, OrderFlowStore, OrderFlowWriteResult } from "./agent-tools/order-flow.ts";
export type { VoiceSecretMatch, VoiceToolAuditInput, VoiceToolAuditOutcome } from "./types.ts";

export { formatLocationMessage, formatUbicacionEntregaNota, isValidCoordinate, latestDeliveryPin, latestSharedLocation, parseMapsLink, parseSharedLocation, parseUbicacionEntregaNota, type MetaLocationMessage, type SharedLocation, type UbicacionEntrega } from "./whatsapp/location.ts";
export type { MetaInboundMessage } from "./whatsapp/channel-config.ts";
export * from "./privacidad/index.ts";
export * from "./data-chat/index.ts";

// R-11 -- pedidos programados (migracion 034).
export {
  ANTICIPACION_PROMOCION_MIN,
  PROGRAMACION_MAXIMA_DIAS,
  PROGRAMACION_MINIMA_MIN,
  assertProgramacionDisponible,
  parsearProgramadoPara,
  promoverProgramadosTodasLasOrganizaciones,
  promoverProgramadosVencidos,
  validarVentanaProgramacion,
} from "./pedidos-programados.ts";
export type { PromocionProgramados } from "./pedidos-programados.ts";
export { ATRASO_PROGRAMADO_MIN, avisarProgramadosPromovidos, emitirAvisoProgramadoEnCocina, esPromocionAtrasada } from "./pedidos-programados-avisos.ts";
export type { ResumenAvisosProgramados } from "./pedidos-programados-avisos.ts";
export { etiquetaHoraLocal } from "./horarios.ts";
export type { OrderScheduleInfo } from "./types.ts";
export type { PromotedScheduledOrdersResult, ScheduledOrdersResult } from "./repository.ts";

// R-16 -- avisos del staff (migracion 043): preferencias por usuario, umbral de entrega tardia y alertas operativas.
export {
  AvisosNoDisponiblesError,
  AvisosPermisoError,
  AvisosValidacionError,
  EVENTOS_AVISO,
  TIPOS_AVISO,
  UMBRAL_ENTREGA_TARDIA_DEFECTO_MIN,
  UMBRAL_ENTREGA_TARDIA_MAX,
  UMBRAL_ENTREGA_TARDIA_MIN,
  guardarPreferenciaAviso,
  guardarUmbralEntrega,
  listarPreferenciasAvisos,
  listarUmbralesEntrega,
} from "./avisos-preferencias.ts";
export type { EventoAviso, PreferenciaAviso, UmbralSucursal } from "./avisos-preferencias.ts";
export { barrerAvisosOperativos, listarCandidatosAvisos } from "./avisos-operativos.ts";
export type { CandidatoAviso, ResultadoBarridoAvisos, TipoAvisoOperativo } from "./avisos-operativos.ts";
export { diaMerida } from "./alertas-duenio/dia.ts";
export { emitirAlertasProveedor, evaluarSaludProveedor, GRAPH_CODIGO_TOKEN_INVALIDO, UMBRAL_FALLAS_PROVEEDOR } from "./alertas-duenio/proveedor.ts";
export type { DiagnosticoProveedorOrg, ItemDespachoOrg, ResultadoAlertasProveedor } from "./alertas-duenio/proveedor.ts";

export * from "./encuesta-reglas.ts";
export * from "./resenas-provider.ts";
export * from "./mezcla-de-pago.ts";
// Ajustes del agente por organizacion (modelo, temperatura, voz, fondo) y base de conocimiento automatica (equivalentes de lo que el original hacia con ElevenLabs).
export * from "./ajustes-agente/index.ts";

export * from "./conocimiento/index.ts";
export { cargaDeRepartidor, sugerirRepartidor } from "./repartidor-sugerido.ts";
export type { CandidatoRepartidor, CargaRepartidor, SugerenciaRepartidor } from "./repartidor-sugerido.ts";
export {
  MarketingNoDisponibleError,
  MarketingParametrosError,
  MarketingRechazadoError,
  MarketingSinAccesoError,
  SEGMENTOS_MARKETING,
  decidirCampana,
  generarBorradoresMarketing,
  guardarConfigMarketing,
  leerConfigMarketing,
  listarCampanas,
  registrarConsentimientoMarketing,
  revocarMarketingPorTelefono,
} from "./marketing/campanas.ts";
export type {
  BorradorGenerado,
  CampanaMarketing,
  CodigoRechazoMarketing,
  ConfigMarketing,
  EntradaConfigMarketing,
  EstadoCampana,
  LecturaMarketing,
  ResultadoBorradores,
  ResultadoConsentimiento,
  ResultadoDecision,
  SegmentoMarketing,
} from "./marketing/campanas.ts";
export { AlertasDuenioNoDisponibleError, AlertasDuenioParametrosError, AlertasDuenioSinAccesoError, UMBRALES_ALERTAS_POR_OMISION, barrerSilencioWhatsapp, guardarUmbralesAlertasDuenio, leerUmbralesAlertasDuenio } from "./alertas-duenio/silencio.ts";
export type { CandidatoSilencio, ResultadoSilencio, UmbralesAlertasDuenio } from "./alertas-duenio/silencio.ts";
export { avisarPresupuestoIaAlDuenio } from "./alertas-duenio/presupuesto.ts";
export type { ResultadoAvisoPresupuesto, UmbralPresupuestoIa } from "./alertas-duenio/presupuesto.ts";
