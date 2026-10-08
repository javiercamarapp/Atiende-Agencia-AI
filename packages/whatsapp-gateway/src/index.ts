export { WhatsAppConfigError, WhatsAppInvalidPayloadError, WhatsAppSendError } from "./errors.ts";
export type { EnviadoComo, OutboundButton, OutboundTemplate, OutboundWhatsAppMessagePayload, WhatsAppGraphClient, WhatsAppSendResult } from "./types.ts";
export { MAX_TEMPLATE_PARAMS, MAX_TEMPLATE_PARAM_LENGTH, TEMPLATE_LANGUAGE_PATTERN, TEMPLATE_NAME_PATTERN } from "./types.ts";
export type { MensajeEnviadoDetalle, MessagingOutboxItem, MessagingOutboxPort } from "./outbox-port.ts";
export {
  computeBackoffSeconds,
  DEFAULT_BATCH_LIMIT,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_MAX_ATTEMPTS,
  SUPPRESSED_ERROR_CLASS,
  WhatsAppOutboundDispatcher,
} from "./dispatcher.ts";
export type { CatalogoPlantillas, ContextoMedicion, DispatchItemOutcome, DispatchItemResult, DispatchPendingOptions, DispatchSummary, MedidorMensajes, SuppressionGuard, WhatsAppOutboundDispatcherOptions } from "./dispatcher.ts";
export { DEFAULT_GRAPH_API_VERSION, MAX_BUTTON_ID_LENGTH, MAX_BUTTON_TITLE_LENGTH, MAX_INTERACTIVE_BUTTONS, MetaGraphWhatsAppClient } from "./providers/meta-graph-client.ts";
export type { MetaGraphWhatsAppClientOptions } from "./providers/meta-graph-client.ts";
export { FakeWhatsAppGraphClient } from "./providers/fake-graph-client.ts";
export type { FakeWhatsAppGraphClientOptions } from "./providers/fake-graph-client.ts";
export { detectarOptOut, normalizarTextoOptOut } from "./opt-out.ts";
export type { IntencionOptOut, OpcionesDeteccionOptOut } from "./opt-out.ts";
export { DEFAULT_ALLOWED_AUDIO_MIMES, DEFAULT_MEDIA_MAX_BYTES, DEFAULT_MEDIA_TIMEOUT_MS, MetaGraphMediaDownloader, WhatsAppMediaError, normalizeMimeType, oggOpusDurationSeconds } from "./media.ts";
export type { DownloadedMedia, MediaDownloadLimits, MediaDownloader, MetaMediaDownloaderOptions, WhatsAppMediaErrorCode } from "./media.ts";
export { ESTADOS_ENTREGA, avanzarEstadoEntrega, extractMetaStatuses, motivoFalloEntrega } from "./statuses.ts";
export type { EstadoEntrega, MetaDeliveryStatus, MotivoFalloEntrega } from "./statuses.ts";
export {
  CAMPOS_NUMERO,
  CAMPOS_PLANTILLA,
  CAMPOS_WABA,
  DEFAULT_GRAPH_READER_API_VERSION,
  GRAPH_API_VERSION_PATTERN,
  MetaGraphReadError,
  MetaGraphReaderConfigError,
  MetaGraphWhatsAppReader,
  esVersionGraphValida,
  redactarSecretos,
} from "./providers/meta-graph-reader.ts";
export type { MetaAppSuscrita, MetaGraphReadErrorInfo, MetaGraphWhatsAppReaderOptions, MetaNumero, MetaPlantilla, MetaWaba } from "./providers/meta-graph-reader.ts";
