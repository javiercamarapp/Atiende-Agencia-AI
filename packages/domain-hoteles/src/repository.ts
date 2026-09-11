// Puerto de acceso a datos de domain-hoteles — mismo patrón dual de adaptador que
// domain-restaurantes/src/repository.ts: un puerto TS explícito, con un adaptador real
// en memoria (tests determinísticos) y un adaptador real de Postgres (sobre
// TenantDbSession, contra las migraciones de migrations/001-003). Ninguna función de
// negocio de las rutas de apps/api toca SQL directamente — todas pasan por aquí.
import type { FnbOrderRecord, FolioRecord, GuestIdentity, NewChargeInput, NewFnbOrderInput, NewPaymentInput, NightlyRateRecord, TaxConfigRecord } from "./types.ts";

export interface IdempotencyParams {
  readonly organizationId: string;
  readonly scope: string;
  readonly key: string;
  readonly body: unknown;
}

export interface IdempotentResult<T> {
  readonly status: number;
  readonly body: T;
}

export interface HotelesRepository {
  // ---- Folios/cargos (flujo 1) ----
  findFolio(propertyId: string, folioId: string): Promise<FolioRecord | null>;
  listFoliosByReservation(propertyId: string, reservationId: string): Promise<readonly FolioRecord[]>;
  loadFolioGuestIdentity(reservationId: string): Promise<GuestIdentity>;
  /** true si `userId` pertenece al staff de `propertyId` con un rol administrativo
   *  (owner/gm) — usado para autorizar un descuento/identidad/cuenta-por-cobrar
   *  aplicado por OTRO actor (p.ej. frontdesk trae la autorización de un gm que no
   *  está logueado en esta sesión). Nunca confía en un id que venga del cuerpo de la
   *  solicitud sin verificarlo contra `core.membership`. */
  isAdminStaff(propertyId: string, userId: string): Promise<boolean>;
  loadTaxConfig(propertyId: string): Promise<TaxConfigRecord>;
  insertCharge(input: NewChargeInput): Promise<{ id: string; createdAt: string }>;
  findCharge(folioId: string, chargeId: string): Promise<
    | { id: string; description: string; amount: number; taxAmount: number; concept: NewChargeInput["concept"]; reversedBy: string | null }
    | null
  >;
  /** Marca el cargo original como reversado — equivalente a
   *  `hoteles.mark_charge_reversed()` (SECURITY DEFINER). Lanza si el cargo no existe
   *  o ya fue reversado. */
  markChargeReversed(chargeId: string, reversalChargeId: string): Promise<void>;
  insertPayment(input: NewPaymentInput): Promise<{ id: string; createdAt: string }>;
  createFolio(propertyId: string, organizationId: string, reservationId: string, label: string): Promise<{ id: string }>;
  closeFolio(folioId: string, reason: "saldo_cero" | "cuenta_por_cobrar", arApprovedBy: string | null): Promise<void>;

  // ---- F&B (flujo 2) ----
  listFnbOrders(propertyId: string): Promise<readonly FnbOrderRecord[]>;
  findFnbOrder(propertyId: string, orderId: string): Promise<FnbOrderRecord | null>;
  insertFnbOrder(input: NewFnbOrderInput): Promise<FnbOrderRecord>;
  confirmFnbKitchen(propertyId: string, orderId: string, userId: string, note: string | null): Promise<FnbOrderRecord | null>;
  assureFnbSafety(propertyId: string, orderId: string, userId: string): Promise<FnbOrderRecord | null>;

  // ---- Quotes (flujo 3) — SOLO lectura, ninguna escritura de precio ----
  findRoomType(propertyId: string, roomTypeId: string): Promise<{ id: string } | null>;
  loadNightlyRates(propertyId: string, roomTypeId: string, checkInDate: string, checkOutDate: string): Promise<readonly NightlyRateRecord[]>;

  // ---- Idempotencia (transversal a folios y F&B) ----
  withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>>;
}

export type { FolioRecord, ChargeRecord, PaymentRecord, NewChargeInput, NewPaymentInput, FnbOrderRecord, NewFnbOrderInput, NightlyRateRecord, TaxConfigRecord, GuestIdentity } from "./types.ts";
