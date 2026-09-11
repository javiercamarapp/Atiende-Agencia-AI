// InMemoryHotelesRepository — implementación real (no un mock) de `HotelesRepository`,
// con las mismas restricciones de integridad/idempotencia que las migraciones SQL de
// migrations/001-002 (índice único parcial `charge_folio_stay_date_hospedaje_idx`,
// `idempotency_key` por (organizationId, scope, key) con detección de conflicto).
// Sirve para tests determinísticos y como fallback dev/CI sin Postgres real — mismo
// rol que InMemoryRestaurantesRepository.
import { createHash, randomUUID } from "node:crypto";
import type { HotelesRepository, IdempotencyParams, IdempotentResult } from "./repository.ts";
import type {
  FnbOrderRecord,
  FolioRecord,
  GuestIdentity,
  NewChargeInput,
  NewFnbOrderInput,
  NewPaymentInput,
  NightlyRateRecord,
  ChargeRecord,
  PaymentRecord,
  TaxConfigRecord,
} from "./types.ts";
import { IdempotencyConflictError } from "./errors.ts";

/** Serializa operaciones por clave — equivalente en memoria de
 *  `pg_advisory_xact_lock`/row lock de Postgres. */
class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.chains.set(
      key,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface StoredFolio {
  id: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  status: "abierto" | "cerrado";
  label: string;
  isPrimary: boolean;
  closedAt: string | null;
  closeReason: "saldo_cero" | "cuenta_por_cobrar" | null;
  arApprovedBy: string | null;
}

interface StoredCharge extends Omit<ChargeRecord, "reversedBy"> {
  organizationId: string;
  propertyId: string;
  stayDate: string | null;
  reversedBy: string | null;
}

interface StoredIdempotencyRow {
  requestHash: string;
  response: IdempotentResult<unknown> | null;
}

interface StoredStaffMember {
  propertyId: string;
  userId: string;
  isAdmin: boolean;
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export class InMemoryHotelesRepository implements HotelesRepository {
  private readonly folios = new Map<string, StoredFolio>();
  private readonly charges = new Map<string, StoredCharge>();
  private readonly payments = new Map<string, PaymentRecord & { propertyId: string }>();
  private readonly guestIdentityByReservation = new Map<string, GuestIdentity>();
  private readonly staff: StoredStaffMember[] = [];
  private readonly taxConfigByProperty = new Map<string, TaxConfigRecord>();
  private readonly fnbOrders = new Map<string, FnbOrderRecord & { propertyId: string; organizationId: string }>();
  private readonly roomTypes = new Map<string, { id: string; propertyId: string }>();
  private readonly nightlyRates = new Map<string, NightlyRateRecord[]>(); // key: propertyId:roomTypeId
  private readonly idempotencyKeys = new Map<string, StoredIdempotencyRow>(); // key: organizationId:scope:key

  private readonly idempotencyLock = new KeyedMutex();

  // ---- seeding (equivalente a INSERT manual contra las migraciones SQL) ----

  seedFolio(folio: StoredFolio): void {
    this.folios.set(folio.id, folio);
  }

  seedGuestIdentity(reservationId: string, identity: GuestIdentity): void {
    this.guestIdentityByReservation.set(reservationId, identity);
  }

  seedStaff(entry: StoredStaffMember): void {
    this.staff.push(entry);
  }

  seedTaxConfig(propertyId: string, config: TaxConfigRecord): void {
    this.taxConfigByProperty.set(propertyId, config);
  }

  seedRoomType(propertyId: string, roomTypeId: string): void {
    this.roomTypes.set(roomTypeId, { id: roomTypeId, propertyId });
  }

  seedNightlyRates(propertyId: string, roomTypeId: string, rates: readonly NightlyRateRecord[]): void {
    this.nightlyRates.set(`${propertyId}:${roomTypeId}`, [...rates]);
  }

  private chargesByFolio(folioId: string): StoredCharge[] {
    return [...this.charges.values()].filter((c) => c.folioId === folioId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  private paymentsByFolio(folioId: string): PaymentRecord[] {
    return [...this.payments.values()].filter((p) => p.folioId === folioId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  private toFolioRecord(stored: StoredFolio): FolioRecord {
    return {
      id: stored.id,
      organizationId: stored.organizationId,
      propertyId: stored.propertyId,
      reservationId: stored.reservationId,
      status: stored.status,
      label: stored.label,
      isPrimary: stored.isPrimary,
      closedAt: stored.closedAt,
      closeReason: stored.closeReason,
      arApprovedBy: stored.arApprovedBy,
      charges: this.chargesByFolio(stored.id),
      payments: this.paymentsByFolio(stored.id),
    };
  }

  // ---- HotelesRepository: folios/cargos ----

  async findFolio(propertyId: string, folioId: string): Promise<FolioRecord | null> {
    const stored = this.folios.get(folioId);
    if (!stored || stored.propertyId !== propertyId) return null;
    return this.toFolioRecord(stored);
  }

  async listFoliosByReservation(propertyId: string, reservationId: string): Promise<readonly FolioRecord[]> {
    return [...this.folios.values()]
      .filter((f) => f.propertyId === propertyId && f.reservationId === reservationId)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((f) => this.toFolioRecord(f));
  }

  async loadFolioGuestIdentity(reservationId: string): Promise<GuestIdentity> {
    return this.guestIdentityByReservation.get(reservationId) ?? { lastName: null, phoneLast4: null };
  }

  async isAdminStaff(propertyId: string, userId: string): Promise<boolean> {
    return this.staff.some((s) => s.propertyId === propertyId && s.userId === userId && s.isAdmin);
  }

  async loadTaxConfig(propertyId: string): Promise<TaxConfigRecord> {
    const config = this.taxConfigByProperty.get(propertyId);
    if (!config) throw new Error(`No hay hoteles.tax_config sembrado para property "${propertyId}"`);
    return config;
  }

  async insertCharge(input: NewChargeInput): Promise<{ id: string; createdAt: string }> {
    if (input.amount < 0 && !["descuento", "reverso"].includes(input.concept)) {
      throw new Error("charge_amount_check: un cargo real no admite monto negativo.");
    }
    // Espejo del índice único parcial `charge_folio_stay_date_hospedaje_idx`: el
    // night-audit nunca postea dos veces el cargo de hospedaje de la misma noche del
    // mismo folio. Los reversos (reversesChargeId set) no llevan stayDate real, así
    // que nunca chocan contra este índice — mismo criterio que el SQL real.
    if (input.concept === "hospedaje" && input.stayDate && !input.reversesChargeId) {
      const clash = [...this.charges.values()].some(
        (c) => c.folioId === input.folioId && c.concept === "hospedaje" && c.stayDate === input.stayDate && c.reversesChargeId == null,
      );
      if (clash) {
        throw new Error(
          `charge_folio_stay_date_hospedaje_idx: ya existe un cargo de hospedaje para el folio ${input.folioId} en la noche ${input.stayDate}.`,
        );
      }
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const record: StoredCharge = {
      id,
      folioId: input.folioId,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      description: input.description,
      amount: input.amount,
      taxAmount: input.taxAmount,
      concept: input.concept,
      reversedBy: null,
      reversesChargeId: input.reversesChargeId ?? null,
      transferredFromChargeId: input.transferredFromChargeId ?? null,
      discountAuthorizedBy: input.discountAuthorizedBy ?? null,
      stayDate: input.stayDate ?? null,
      createdAt,
    };
    this.charges.set(id, record);
    return { id, createdAt };
  }

  async findCharge(folioId: string, chargeId: string) {
    const charge = this.charges.get(chargeId);
    if (!charge || charge.folioId !== folioId) return null;
    return {
      id: charge.id,
      description: charge.description,
      amount: charge.amount,
      taxAmount: charge.taxAmount,
      concept: charge.concept,
      reversedBy: charge.reversedBy,
    };
  }

  async markChargeReversed(chargeId: string, reversalChargeId: string): Promise<void> {
    const charge = this.charges.get(chargeId);
    if (!charge || charge.reversedBy != null) {
      throw new Error(`reverso_invalido: el cargo ${chargeId} no existe o ya fue reversado`);
    }
    charge.reversedBy = reversalChargeId;
  }

  async insertPayment(input: NewPaymentInput): Promise<{ id: string; createdAt: string }> {
    if (input.tokenRef && /^[0-9]{12,19}$/.test(input.tokenRef)) {
      throw new Error("payment_token_ref_not_pan: token_ref no puede parecer un PAN.");
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.payments.set(id, {
      id,
      folioId: input.folioId,
      propertyId: input.propertyId,
      amount: input.amount,
      method: input.method,
      status: input.status,
      externalRef: input.externalRef ?? null,
      tokenRef: input.tokenRef ?? null,
      createdAt,
    });
    return { id, createdAt };
  }

  async createFolio(propertyId: string, organizationId: string, reservationId: string, label: string): Promise<{ id: string }> {
    const id = randomUUID();
    this.folios.set(id, {
      id,
      organizationId,
      propertyId,
      reservationId,
      status: "abierto",
      label,
      isPrimary: false,
      closedAt: null,
      closeReason: null,
      arApprovedBy: null,
    });
    return { id };
  }

  async closeFolio(folioId: string, reason: "saldo_cero" | "cuenta_por_cobrar", arApprovedBy: string | null): Promise<void> {
    const folio = this.folios.get(folioId);
    if (!folio) throw new Error(`Folio ${folioId} no encontrado.`);
    folio.status = "cerrado";
    folio.closedAt = new Date().toISOString();
    folio.closeReason = reason;
    folio.arApprovedBy = arApprovedBy;
  }

  // ---- HotelesRepository: F&B ----

  async listFnbOrders(propertyId: string): Promise<readonly FnbOrderRecord[]> {
    return [...this.fnbOrders.values()]
      .filter((o) => o.propertyId === propertyId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async findFnbOrder(propertyId: string, orderId: string): Promise<FnbOrderRecord | null> {
    const order = this.fnbOrders.get(orderId);
    if (!order || order.propertyId !== propertyId) return null;
    return order;
  }

  async insertFnbOrder(input: NewFnbOrderInput): Promise<FnbOrderRecord> {
    const id = randomUUID();
    const record = {
      id,
      propertyId: input.propertyId,
      organizationId: input.organizationId,
      roomId: input.roomId,
      items: input.items,
      notes: input.notes,
      allergyDeclared: input.allergyDeclared,
      allergyDeclaredVia: input.allergyDeclaredVia,
      kitchenConfirmedBy: null,
      kitchenConfirmedAt: null,
      kitchenConfirmationNote: null,
      safetyAssuranceSentBy: null,
      safetyAssuranceSentAt: null,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.fnbOrders.set(id, record);
    return record;
  }

  async confirmFnbKitchen(propertyId: string, orderId: string, userId: string, note: string | null): Promise<FnbOrderRecord | null> {
    const order = this.fnbOrders.get(orderId);
    if (!order || order.propertyId !== propertyId) return null;
    const updated = { ...order, kitchenConfirmedBy: userId, kitchenConfirmedAt: new Date().toISOString(), kitchenConfirmationNote: note };
    this.fnbOrders.set(orderId, updated);
    return updated;
  }

  async assureFnbSafety(propertyId: string, orderId: string, userId: string): Promise<FnbOrderRecord | null> {
    const order = this.fnbOrders.get(orderId);
    if (!order || order.propertyId !== propertyId) return null;
    const updated = { ...order, safetyAssuranceSentBy: userId, safetyAssuranceSentAt: new Date().toISOString() };
    this.fnbOrders.set(orderId, updated);
    return updated;
  }

  // ---- HotelesRepository: quotes ----

  async findRoomType(propertyId: string, roomTypeId: string): Promise<{ id: string } | null> {
    const rt = this.roomTypes.get(roomTypeId);
    if (!rt || rt.propertyId !== propertyId) return null;
    return { id: rt.id };
  }

  async loadNightlyRates(propertyId: string, roomTypeId: string, checkInDate: string, checkOutDate: string): Promise<readonly NightlyRateRecord[]> {
    const rates = this.nightlyRates.get(`${propertyId}:${roomTypeId}`) ?? [];
    return rates.filter((r) => r.date >= checkInDate && r.date <= checkOutDate);
  }

  // ---- HotelesRepository: idempotencia ----

  async withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>> {
    const requestHash = hashBody(params.body);
    const key = `${params.organizationId}:${params.scope}:${params.key}`;
    return this.idempotencyLock.run(key, async () => {
      const existing = this.idempotencyKeys.get(key);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();
        if (existing.response == null) {
          throw new Error("La solicitud original con este Idempotency-Key aún no terminó de procesarse.");
        }
        return existing.response as IdempotentResult<T>;
      }
      this.idempotencyKeys.set(key, { requestHash, response: null });
      const result = await run();
      this.idempotencyKeys.set(key, { requestHash, response: result });
      return result;
    });
  }
}
