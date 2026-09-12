export {
  CHARGE_CONCEPTS,
  computeChargeAmounts,
  evaluateDiscountAuthorization,
  evaluateFolioClose,
  assertRoomChargeIdentityVerified,
  ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY,
} from "./folioEngine.ts";
export type {
  ChargeConcept,
  ChargeCalcInput,
  ChargeCalcResult,
  DiscountAuthorizationInput,
  DiscountAuthorizationResult,
  RoomChargeIdentityClaim,
  RoomChargeIdentityVerificationInput,
  RoomChargeIdentityVerificationResult,
  FolioCloseReason,
  FolioCloseInput,
  FolioCloseResult,
} from "./folioEngine.ts";

export { applyTaxes, assertValidTaxConfig } from "./taxes.ts";
export type { TaxConfig, TaxBreakdown } from "./taxes.ts";

export { roundCurrency } from "./money.ts";

export {
  looksLikeAllergyDeclaration,
  resolveAllergyDeclared,
  canAssureDishIsSafe,
  assertCanAssureDishIsSafe,
  describeSafetyAssuranceMessage,
  AllergySafetyAssuranceBlockedError,
} from "./fnbAllergyGuard.ts";
export type { AllergyDeclaredVia, ResolveAllergyDeclaredInput, ResolveAllergyDeclaredResult, FnbOrderSafetyState } from "./fnbAllergyGuard.ts";

export { QuoteError, QuoteInputValidationError, parseQuoteInput, computeQuote, nightsBetween } from "./quote.ts";
export type { NightlyRate, QuoteInput, QuoteNightBreakdown, Quote } from "./quote.ts";

export { occupancyPct, effectiveCapacity, canBook } from "./overbooking.ts";
export type { OverbookingConfig } from "./overbooking.ts";

export {
  HOTEL_ROLES,
  isHotelRole,
  MONEY_ROLES,
  ADMIN_ROLES,
  TOMAR_PEDIDO_ROLES,
  CONFIRMAR_COCINA_ROLES,
  PLATFORM_ROLE_BY_VERTICAL_ROLE,
} from "./roles.ts";
export type { HotelRole } from "./roles.ts";

export { IdempotencyConflictError } from "./errors.ts";

export type { PaymentsPort, PaymentChargeInput, PaymentChargeResult } from "./payments-port.ts";
export { InMemoryPaymentsPort } from "./payments-port.ts";

export type {
  FolioStatus,
  FolioCloseReason as FolioRecordCloseReason,
  PaymentMethod,
  PaymentStatus,
  ChargeRecord,
  PaymentRecord,
  FolioRecord,
  NewChargeInput,
  NewPaymentInput,
  FnbOrderItem,
  FnbOrderRecord,
  NewFnbOrderInput,
  TaxConfigRecord,
  NightlyRateRecord,
  GuestIdentity,
} from "./types.ts";

export type { HotelesRepository, IdempotencyParams, IdempotentResult } from "./repository.ts";
export { InMemoryHotelesRepository } from "./in-memory-repository.ts";
export { PostgresHotelesRepository } from "./postgres-repository.ts";

// ---- Fase 2 — Server Tools de voz + agente de WhatsApp con LLM real ----
export type { ConversationMessage, ContactoNoOperativoRecord, ContactoNoOperativoSource, NewContactoNoOperativoInput, VoiceAgentConfig, WhatsAppPropertyRoute } from "./types.ts";

export { actorHash, requestActor, consumeRateLimit } from "./rate-limit.ts";
export { registerContactoNoOperativo } from "./contacto-no-operativo.ts";

export { verifyMetaSignature } from "./whatsapp/meta-signature.ts";
export { extractMetaTextMessages, extractMetaPhoneNumberId, resolvePropertyByPhoneNumberId } from "./whatsapp/channel-config.ts";
export type { MetaTextMessage } from "./whatsapp/channel-config.ts";
export type { HotelesWhatsAppTurnHandler } from "./whatsapp/turn-handler.ts";
export { acknowledgeOnlyTurnHandler } from "./whatsapp/turn-handler.ts";
export { handleInboundWhatsAppMessage, redactSensitiveInfo } from "./whatsapp/inbound.ts";
export type { InboundMessageOutcome } from "./whatsapp/inbound.ts";
export {
  createLlmHotelesWhatsAppTurnHandler,
  TOOLS as WHATSAPP_HOTELES_TOOLS,
  FALLBACK_CONFIG as WHATSAPP_HOTELES_FALLBACK_CONFIG,
  getAgentConfig as getWhatsAppHotelesAgentConfig,
  providerFailureReply as whatsappHotelesProviderFailureReply,
} from "./whatsapp/llm-turn-handler.ts";
export type { WhatsAppHotelesAgentConfig, WhatsAppHotelesLlmAgentOptions } from "./whatsapp/llm-turn-handler.ts";
