// Tipos de registro (fila ya mapeada a camelCase) que HotelesRepository devuelve/recibe
// — ninguna función de negocio de folios.ts/pedidosFnb.ts/quotes.ts en apps/api toca
// una fila cruda de SQL directamente, mismo criterio que domain-restaurantes/src/types.ts.
import type { ChargeConcept } from "./folioEngine.ts";
import type { AllergyDeclaredVia } from "./fnbAllergyGuard.ts";

export type FolioStatus = "abierto" | "cerrado";
export type FolioCloseReason = "saldo_cero" | "cuenta_por_cobrar";
export type PaymentMethod = "efectivo" | "transferencia" | "tarjeta";
export type PaymentStatus = "pendiente" | "autorizado" | "capturado" | "fallido" | "reembolsado" | "expirado";

export interface ChargeRecord {
  readonly id: string;
  readonly folioId: string;
  readonly description: string;
  readonly amount: number;
  readonly taxAmount: number;
  readonly concept: ChargeConcept;
  readonly reversedBy: string | null;
  readonly reversesChargeId: string | null;
  readonly transferredFromChargeId: string | null;
  readonly discountAuthorizedBy: string | null;
  readonly createdAt: string;
}

export interface PaymentRecord {
  readonly id: string;
  readonly folioId: string;
  readonly amount: number;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly externalRef: string | null;
  readonly tokenRef: string | null;
  readonly createdAt: string;
}

export interface FolioRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reservationId: string;
  readonly status: FolioStatus;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly closedAt: string | null;
  readonly closeReason: FolioCloseReason | null;
  readonly arApprovedBy: string | null;
  readonly charges: readonly ChargeRecord[];
  readonly payments: readonly PaymentRecord[];
}

export interface NewChargeInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folioId: string;
  readonly description: string;
  readonly amount: number;
  readonly taxAmount: number;
  readonly concept: ChargeConcept;
  readonly reversesChargeId?: string | null;
  readonly transferredFromChargeId?: string | null;
  readonly discountAuthorizedBy?: string | null;
  readonly stayDate?: string | null;
}

export interface NewPaymentInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folioId: string;
  readonly amount: number;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly externalRef?: string | null;
  readonly tokenRef?: string | null;
}

export interface FnbOrderItem {
  readonly nombre: string;
  readonly notas?: string;
}

export interface FnbOrderRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly roomId: string | null;
  readonly items: readonly FnbOrderItem[];
  readonly notes: string | null;
  readonly allergyDeclared: boolean;
  readonly allergyDeclaredVia: AllergyDeclaredVia | null;
  readonly kitchenConfirmedBy: string | null;
  readonly kitchenConfirmedAt: string | null;
  readonly kitchenConfirmationNote: string | null;
  readonly safetyAssuranceSentBy: string | null;
  readonly safetyAssuranceSentAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface NewFnbOrderInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomId: string | null;
  readonly items: readonly FnbOrderItem[];
  readonly notes: string | null;
  readonly allergyDeclared: boolean;
  readonly allergyDeclaredVia: AllergyDeclaredVia | null;
  readonly createdBy: string;
}

export interface TaxConfigRecord {
  readonly ivaRate: number;
  readonly ishRate: number;
  readonly discountThreshold: number;
}

export interface NightlyRateRecord {
  readonly date: string;
  readonly price: number;
  readonly minStay: number;
  readonly closedToArrival: boolean;
  readonly closedToDeparture: boolean;
}

export interface GuestIdentity {
  readonly lastName: string | null;
  readonly phoneLast4: string | null;
}
