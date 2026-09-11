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
