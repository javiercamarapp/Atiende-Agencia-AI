export type {
  Branch,
  BranchProductState,
  BranchSummary,
  CallbackRequest,
  CallbackRequestInput,
  Category,
  CategoryPatch,
  CreateOrderInput,
  CreateOrderItemInput,
  Customer,
  CustomerAddress,
  CustomerListFilter,
  CustomerListPage,
  CustomerLookupResult,
  CustomerTier,
  DefaultComplement,
  NearestBranchMatch,
  NewCategoryInput,
  NewProductInput,
  Order,
  OrderHistoryItem,
  OrderListFilter,
  OrderListPage,
  OrderQuote,
  OrderStatus,
  PersistedOrderItem,
  Product,
  ProductPatch,
  ProductoEncontrado,
  QuotedOrderLine,
  RequestedComplement,
  RequestedOrderItemInput,
  TortillaChoice,
} from "./types.ts";

export { OrderConflictError, OrderValidationError } from "./errors.ts";

export { normalizePhone, canonicalizeMexicanPhone } from "./phone.ts";

export { RESTAURANTES_ROLES, MANAGER_ROLES, REPARTIDOR_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE, isRestaurantesRole } from "./roles.ts";
export type { RestaurantesRole } from "./roles.ts";

export { tokenizeForProductSearch, matchesProductSearch, extraerPackSize, requiresAdultConfirmation, resolveOrderItemsAgainstProducts, UUID_PATTERN } from "./product-search.ts";

export { DEFAULT_COMPLEMENTS, buildComplementNotes, buildOrderQuoteFromProducts } from "./order-quote.ts";

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
} from "./repository.ts";
export { InMemoryRestaurantesRepository } from "./in-memory-repository.ts";
export { PostgresRestaurantesRepository } from "./postgres-repository.ts";

export { lookupCustomer, getCustomerDetailById, vipNote } from "./customers.ts";

export {
  ORDER_STATUSES,
  OrderStatusTransitionError,
  isOrderStatus,
  nextValidStatuses,
  assertValidOrderStatusTransition,
  changeOrderStatus,
  REPARTIDOR_ALLOWED_STATUSES,
  assertValidRepartidorStatusTransition,
  changeAssignedOrderStatus,
} from "./order-lifecycle.ts";

export { searchProducts, prepareCreateOrder, createOrder, quoteOrder, resolveBranchOrderItems, validateCreateOrderPayload } from "./orders.ts";
export type { PreparedOrder } from "./orders.ts";

export {
  notifyCustomerOnOrderStatusChangeCore,
  tryNotifyCustomerOnOrderStatusChange,
  notifyStaffNewOrderCore,
  tryNotifyStaffNewOrder,
  notifyStaffOrderProblemCore,
  tryNotifyStaffOrderProblem,
  notifyStaffRepartidorAssignedCore,
  tryNotifyStaffRepartidorAssigned,
} from "./order-notifications.ts";
export type { CustomerOrderNotificationResult } from "./order-notifications.ts";

export { registerCallbackRequest } from "./callback-requests.ts";

export { findNearestBranch, normalizeZoneText, haversineKm, COLONIA_NO_RECONOCIDA_MENSAJE } from "./nearest-branch.ts";
export type { NearestBranchResult } from "./nearest-branch.ts";

export { actorHash, requestActor, consumeRateLimit } from "./rate-limit.ts";

export { verifyMetaSignature } from "./whatsapp/meta-signature.ts";
export { extractMetaTextMessages, extractMetaPhoneNumberId, resolveOrganizationByPhoneNumberId } from "./whatsapp/channel-config.ts";
export type { MetaTextMessage } from "./whatsapp/channel-config.ts";
export { redactSensitiveInfo, handleInboundWhatsAppMessage } from "./whatsapp/inbound.ts";
export type { InboundMessageOutcome } from "./whatsapp/inbound.ts";
export { createRestaurantesMessagingOutboxPort } from "./whatsapp/outbox-adapter.ts";
export { acknowledgeOnlyTurnHandler } from "./whatsapp/turn-handler.ts";
export type { WhatsAppTurnHandler } from "./whatsapp/turn-handler.ts";

export { createLlmWhatsAppTurnHandler, FALLBACK_CONFIG, getAgentConfig, TOOLS, TONE_INSTRUCTIONS, enforceBistecPackNotice, saludoSegunHora, providerFailureReply } from "./whatsapp/llm-turn-handler.ts";
export type { WhatsAppLlmAgentConfig, WhatsAppLlmAgentOptions, WhatsAppToneStyle } from "./whatsapp/llm-turn-handler.ts";

export {
  STATS_PERIODS,
  isStatsPeriod,
  buildTrendBuckets,
  buildComparisonPeriods,
  periodLabel,
  getSalesKpis,
  getSalesTrendKpis,
  getChannelKpis,
  computeChannelKpis,
  getCustomerKpis,
  computeCustomerKpis,
} from "./kpis.ts";
export type { StatsPeriod, TrendBucket, ComparisonPeriods, SalesSummary, SalesTrendPoint, ChannelKpis, CustomerKpis } from "./kpis.ts";
