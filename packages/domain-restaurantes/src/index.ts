export type {
  Branch,
  CallbackRequest,
  CallbackRequestInput,
  CreateOrderInput,
  CreateOrderItemInput,
  Customer,
  CustomerAddress,
  CustomerLookupResult,
  CustomerTier,
  DefaultComplement,
  Order,
  OrderHistoryItem,
  OrderQuote,
  PersistedOrderItem,
  ProductoEncontrado,
  QuotedOrderLine,
  RequestedComplement,
  RequestedOrderItemInput,
  TortillaChoice,
} from "./types.ts";

export { OrderConflictError, OrderValidationError } from "./errors.ts";

export { normalizePhone, canonicalizeMexicanPhone } from "./phone.ts";

export { RESTAURANTES_ROLES, MANAGER_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE, isRestaurantesRole } from "./roles.ts";
export type { RestaurantesRole } from "./roles.ts";

export { tokenizeForProductSearch, matchesProductSearch, extraerPackSize, requiresAdultConfirmation, resolveOrderItemsAgainstProducts, UUID_PATTERN } from "./product-search.ts";

export { DEFAULT_COMPLEMENTS, buildComplementNotes, buildOrderQuoteFromProducts } from "./order-quote.ts";

export type { RestaurantesRepository, SearchableProduct, NewOrderRecord, ConversationMessage } from "./repository.ts";
export { InMemoryRestaurantesRepository } from "./in-memory-repository.ts";
export { PostgresRestaurantesRepository } from "./postgres-repository.ts";

export { lookupCustomer, vipNote } from "./customers.ts";

export { searchProducts, prepareCreateOrder, createOrder, validateCreateOrderPayload } from "./orders.ts";
export type { PreparedOrder } from "./orders.ts";

export { registerCallbackRequest } from "./callback-requests.ts";

export { actorHash, requestActor, consumeRateLimit } from "./rate-limit.ts";

export { verifyMetaSignature } from "./whatsapp/meta-signature.ts";
export { extractMetaTextMessages, extractMetaPhoneNumberId, resolveOrganizationByPhoneNumberId } from "./whatsapp/channel-config.ts";
export type { MetaTextMessage } from "./whatsapp/channel-config.ts";
export { redactSensitiveInfo, handleInboundWhatsAppMessage } from "./whatsapp/inbound.ts";
export type { InboundMessageOutcome } from "./whatsapp/inbound.ts";
export { acknowledgeOnlyTurnHandler } from "./whatsapp/turn-handler.ts";
export type { WhatsAppTurnHandler } from "./whatsapp/turn-handler.ts";
