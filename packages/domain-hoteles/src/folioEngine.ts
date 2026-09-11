// Port ~literal de hoteles/packages/domain-hotel/src/folioEngine.ts (H5). Motor
// determinista de folio (REQ-REC-004/012, REQ-BO-001): cálculo de cargos por concepto
// (hospedaje/A&B/extras/ajuste/propina/descuento), redondeo centralizado y reglas de
// autorización de descuentos y cierre de folio. NINGÚN LLM invoca estas funciones con
// un monto propio — siempre reciben montos ya calculados desde tarifas/POS reales
// (mismo principio que taxes.ts).
import { roundCurrency } from "./money.ts";
import { applyTaxes, type TaxConfig } from "./taxes.ts";

export const CHARGE_CONCEPTS = [
  "hospedaje",
  "ab",
  "extras",
  "ajuste",
  "propina",
  "descuento",
  "reverso",
  "otro",
] as const;
export type ChargeConcept = (typeof CHARGE_CONCEPTS)[number];

/** Conceptos que NUNCA llevan IVA/ISH (la propina es del huésped al personal, no
 *  contraprestación del hotel; REQ-BO-001 exige "propina excluida del CFDI"). */
const UNTAXED_CONCEPTS: ReadonlySet<ChargeConcept> = new Set(["propina", "descuento", "reverso"]);

/** El ISH grava SOLO la contraprestación por hospedaje — A&B/extras/ajuste/otro sí
 *  llevan IVA (son contraprestación gravada), pero NUNCA ISH — un concepto fuera de
 *  este set usa una tasa de ISH efectiva de 0%, sin importar lo que diga
 *  `taxConfig.ishRate` de la property. */
const ISH_APPLICABLE_CONCEPTS: ReadonlySet<ChargeConcept> = new Set(["hospedaje"]);

export interface ChargeCalcInput {
  concept: ChargeConcept;
  /** Monto neto (antes de impuestos) del concepto. */
  netAmount: number;
  taxConfig: TaxConfig;
}

export interface ChargeCalcResult {
  netAmount: number;
  taxAmount: number;
  totalAmount: number;
}

/** Único punto donde un concepto de cargo decide si le aplica IVA+ISH — determinista,
 *  sin excepciones ad hoc fuera de `UNTAXED_CONCEPTS`. */
export function computeChargeAmounts(input: ChargeCalcInput): ChargeCalcResult {
  if (input.netAmount < 0) {
    throw new RangeError("netAmount de un cargo real no puede ser negativo (usa descuento/reverso para montos negativos).");
  }
  if (UNTAXED_CONCEPTS.has(input.concept)) {
    const net = roundCurrency(input.netAmount);
    return { netAmount: net, taxAmount: 0, totalAmount: net };
  }
  const effectiveTaxConfig = ISH_APPLICABLE_CONCEPTS.has(input.concept)
    ? input.taxConfig
    : { ivaRate: input.taxConfig.ivaRate, ishRate: 0 };
  const breakdown = applyTaxes(input.netAmount, effectiveTaxConfig);
  return {
    netAmount: breakdown.netAmount,
    taxAmount: roundCurrency(breakdown.ivaAmount + breakdown.ishAmount),
    totalAmount: breakdown.totalAmount,
  };
}

// ---------------------------------------------------------------------------
// Descuentos: requieren autorización de un rol administrativo cuando superan el
// umbral configurado por property (`hoteles.tax_config.discount_threshold`) — nunca
// un número fijo en código.
// ---------------------------------------------------------------------------
export interface DiscountAuthorizationInput {
  amount: number;
  thresholdAmount: number;
  actorHasAdminRole: boolean;
  authorizedByAdminUserId?: string | null;
}

export interface DiscountAuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/** El propio actor con rol administrativo (owner/gm) puede aplicar cualquier
 *  descuento; un rol sin ese privilegio (p.ej. frontdesk) solo puede aplicar un
 *  descuento por encima del umbral si trae la autorización de alguien que SÍ lo tiene
 *  (`authorizedByAdminUserId`, verificado por el llamador contra `core.membership`
 *  ANTES de invocar esta función — este motor nunca decide identidad, solo aplica la
 *  regla de negocio con la autorización ya verificada). */
export function evaluateDiscountAuthorization(input: DiscountAuthorizationInput): DiscountAuthorizationResult {
  if (input.amount < 0) throw new RangeError("El monto de un descuento se expresa siempre como valor positivo.");
  if (input.amount <= input.thresholdAmount) return { allowed: true };
  if (input.actorHasAdminRole) return { allowed: true };
  if (input.authorizedByAdminUserId) return { allowed: true };
  return {
    allowed: false,
    reason: `El descuento (${input.amount}) supera el umbral (${input.thresholdAmount}) y no tiene autorización de un rol administrativo (owner/gm).`,
  };
}

// ---------------------------------------------------------------------------
// REQ-AB-012 (P1/NF): doble verificación de identidad para un cargo que representa
// "un rol de dinero afirma que EL HUÉSPED de esta habitación consumió/solicitó algo"
// (fraude clásico: "cárguelo al 304" sin ser huésped de esa habitación) — SIN tarjeta
// presente y SIN ninguna otra autorización estructural propia.
//
// LECCIÓN DE DOS INTENTOS FALLIDOS ANTERIORES (heredada de hoteles): la primera
// versión de este control solo se activaba cuando el cargo se declaraba con
// concept='ab', y un segundo intento de arreglo solo protegió ese mismo valor del
// enum de forma más estrecha — en ambos casos, declarar CUALQUIER OTRO concepto
// (`extras`, u omitirlo -> `otro`) para el MISMO hecho económico evadía el control por
// completo, porque `concept` lo elige libremente el mismo actor que hace la petición.
// La guarda NUNCA debe depender de qué concepto se declaró — debe aplicarse por el
// HECHO ECONÓMICO (¿es un cargo de consumo/servicio genérico sin tarjeta presente y
// sin su propia autorización?), evaluado ANTES de mirar el campo `concepto`.
export const ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY: ReadonlySet<ChargeConcept> = new Set(["ab", "extras", "otro"]);

export interface RoomChargeIdentityClaim {
  /** Apellido declarado por quien pide el cargo (nunca el nombre completo — basta con
   *  que coincida CON el apellido real del huésped en archivo). */
  readonly declaredLastName: string;
  /** Últimos 4 dígitos del teléfono declarado. */
  readonly declaredPhoneLast4: string;
}

export interface RoomChargeIdentityVerificationInput {
  readonly concept: ChargeConcept;
  /** Reclamo de identidad presentado por quien pide el cargo, o `null` si no se
   *  presentó ninguno (nunca se infiere/adivina). */
  readonly claim: RoomChargeIdentityClaim | null;
  /** Datos reales del huésped titular de la reserva de este folio, o `null` si el
   *  folio no tiene huésped identificado todavía. */
  readonly guestLastName: string | null;
  readonly guestPhoneLast4: string | null;
  /** true si el actor de la petición tiene rol administrativo (owner/gm) — puede
   *  autorizar la excepción cuando falta el reclamo, NUNCA cuando el reclamo
   *  presentado no coincide (una discrepancia activa jamás es overridable). */
  readonly actorHasAdminRole: boolean;
  readonly authorizedByAdminUserId?: string | null;
}

export interface RoomChargeIdentityVerificationResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

function normalizeForCompare(value: string): string {
  return value.trim().toLocaleLowerCase("es-MX").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** Fail-closed real: una DISCREPANCIA activa (el apellido o teléfono declarado NO
 *  coincide con el del huésped real) nunca es overridable por ningún rol — es la señal
 *  más fuerte de que quien pide el cargo no es el huésped. La AUSENCIA de reclamo
 *  (nadie lo presentó) o de dato del huésped (folio sin huésped aún) solo se supera
 *  con autorización administrativa YA verificada por el llamador contra
 *  `core.membership` (mismo patrón que `evaluateDiscountAuthorization`) — este motor
 *  nunca decide identidad de staff, solo aplica la regla con la autorización dada. */
export function assertRoomChargeIdentityVerified(
  input: RoomChargeIdentityVerificationInput,
): RoomChargeIdentityVerificationResult {
  if (!ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY.has(input.concept)) return { allowed: true };

  const hasAdminOverride = input.actorHasAdminRole || Boolean(input.authorizedByAdminUserId);

  if (input.claim && input.guestLastName != null && input.guestPhoneLast4 != null) {
    const lastNameMatches = normalizeForCompare(input.claim.declaredLastName) === normalizeForCompare(input.guestLastName);
    const phoneMatches = input.claim.declaredPhoneLast4.trim() === input.guestPhoneLast4.trim();
    if (lastNameMatches && phoneMatches) return { allowed: true };
    return {
      allowed: false,
      reason: "El apellido/teléfono declarado no coincide con el huésped titular de esta habitación -- discrepancia activa, nunca overridable.",
    };
  }

  if (hasAdminOverride) return { allowed: true };

  return {
    allowed: false,
    reason:
      "Este cargo representa un consumo/servicio sin tarjeta presente cobrado a la habitación de un huésped -- " +
      "requiere verificar apellido+teléfono contra el huésped titular, o autorización de un rol administrativo (owner/gm).",
  };
}

// ---------------------------------------------------------------------------
// Cierre de folio: saldo cero (tolerancia de redondeo) o cuenta por cobrar autorizada
// por un rol administrativo.
// ---------------------------------------------------------------------------
export type FolioCloseReason = "saldo_cero" | "cuenta_por_cobrar";

export interface FolioCloseInput {
  balance: number;
  reason: FolioCloseReason;
  actorHasAdminRole: boolean;
}

export interface FolioCloseResult {
  allowed: boolean;
  reason?: string;
}

/** Tolerancia de redondeo: dos centavos por el acumulado de impuestos con redondeo
 *  por línea (mismo principio documentado en money.ts). */
const ZERO_BALANCE_TOLERANCE = 0.01;

export function evaluateFolioClose(input: FolioCloseInput): FolioCloseResult {
  const isZero = Math.abs(input.balance) <= ZERO_BALANCE_TOLERANCE;

  if (input.reason === "saldo_cero") {
    if (!isZero) {
      return { allowed: false, reason: `El folio tiene saldo ${input.balance}, no puede cerrarse como "saldo_cero".` };
    }
    return { allowed: true };
  }

  // cuenta_por_cobrar: un saldo distinto de cero SOLO puede cerrarse así con
  // autorización de un rol administrativo (owner/gm) — nunca de forma implícita.
  if (isZero) {
    return { allowed: false, reason: "El folio ya tiene saldo cero: ciérralo como saldo_cero, no como cuenta_por_cobrar." };
  }
  if (!input.actorHasAdminRole) {
    return { allowed: false, reason: "Cerrar con saldo pendiente como cuenta por cobrar requiere un rol administrativo (owner/gm)." };
  }
  return { allowed: true };
}
