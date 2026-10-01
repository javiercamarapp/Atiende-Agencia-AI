export { WhatsAppConfigError, WhatsAppInvalidPayloadError, WhatsAppSendError } from "./errors.ts";
export type { OutboundButton, OutboundTemplate, OutboundWhatsAppMessagePayload, WhatsAppGraphClient, WhatsAppSendResult } from "./types.ts";
export { MAX_TEMPLATE_PARAMS, MAX_TEMPLATE_PARAM_LENGTH, TEMPLATE_LANGUAGE_PATTERN, TEMPLATE_NAME_PATTERN } from "./types.ts";
export type { MessagingOutboxItem, MessagingOutboxPort } from "./outbox-port.ts";
export {
  computeBackoffSeconds,
  DEFAULT_BATCH_LIMIT,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_MAX_ATTEMPTS,
  WhatsAppOutboundDispatcher,
} from "./dispatcher.ts";
export type { DispatchItemOutcome, DispatchItemResult, DispatchSummary, WhatsAppOutboundDispatcherOptions } from "./dispatcher.ts";
export { DEFAULT_GRAPH_API_VERSION, MAX_BUTTON_ID_LENGTH, MAX_BUTTON_TITLE_LENGTH, MAX_INTERACTIVE_BUTTONS, MetaGraphWhatsAppClient } from "./providers/meta-graph-client.ts";
export type { MetaGraphWhatsAppClientOptions } from "./providers/meta-graph-client.ts";
export { FakeWhatsAppGraphClient } from "./providers/fake-graph-client.ts";
export type { FakeWhatsAppGraphClientOptions } from "./providers/fake-graph-client.ts";
