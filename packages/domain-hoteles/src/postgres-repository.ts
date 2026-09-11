// PostgresHotelesRepository — adaptador de producción de `HotelesRepository`, sobre
// el `TenantDbSession` genérico de `@atiende/core-tenancy` (mismo contrato que
// consume `core-auth/src/middleware.ts`). Ejecuta las queries reales contra el
// esquema `hoteles` de migrations/001-003 (RLS real vía
// `core.has_property_access`/`hoteles.can_access_money`).
import { createHash } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { IdempotencyConflictError } from "./errors.ts";
import type { HotelesRepository, IdempotencyParams, IdempotentResult } from "./repository.ts";
import type {
  FnbOrderItem,
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

// Ventana de protección contra reintento de un Idempotency-Key — mismo criterio que
// hoteles/apps/api/src/lib/idempotency.ts (migración 0022): 7 días cubre un
// reintento manual/de integración externa real sin ser indefinido.
const IDEMPOTENCY_KEY_TTL_DAYS = 7;

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

interface ChargeRawRow {
  id: string;
  folio_id: string;
  description: string;
  amount: string;
  tax_amount: string;
  concept: ChargeRecord["concept"];
  reversed_by: string | null;
  reverses_charge_id: string | null;
  transferred_from_charge_id: string | null;
  discount_authorized_by: string | null;
  created_at: string;
}

interface PaymentRawRow {
  id: string;
  folio_id: string;
  amount: string;
  method: PaymentRecord["method"];
  status: PaymentRecord["status"];
  external_ref: string | null;
  token_ref: string | null;
  created_at: string;
}

interface FolioRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  reservation_id: string;
  status: FolioRecord["status"];
  label: string;
  is_primary: boolean;
  closed_at: string | null;
  close_reason: FolioRecord["closeReason"];
  ar_approved_by: string | null;
}

function mapCharge(row: ChargeRawRow): ChargeRecord {
  return {
    id: row.id,
    folioId: row.folio_id,
    description: row.description,
    amount: Number(row.amount),
    taxAmount: Number(row.tax_amount),
    concept: row.concept,
    reversedBy: row.reversed_by,
    reversesChargeId: row.reverses_charge_id,
    transferredFromChargeId: row.transferred_from_charge_id,
    discountAuthorizedBy: row.discount_authorized_by,
    createdAt: row.created_at,
  };
}

function mapPayment(row: PaymentRawRow): PaymentRecord {
  return {
    id: row.id,
    folioId: row.folio_id,
    amount: Number(row.amount),
    method: row.method,
    status: row.status,
    externalRef: row.external_ref,
    tokenRef: row.token_ref,
    createdAt: row.created_at,
  };
}

interface FnbOrderRawRow {
  id: string;
  property_id: string;
  room_id: string | null;
  items: unknown;
  notes: string | null;
  allergy_declared: boolean;
  allergy_declared_via: FnbOrderRecord["allergyDeclaredVia"];
  kitchen_confirmed_by: string | null;
  kitchen_confirmed_at: string | null;
  kitchen_confirmation_note: string | null;
  safety_assurance_sent_by: string | null;
  safety_assurance_sent_at: string | null;
  created_by: string | null;
  created_at: string;
}

function mapFnbOrder(row: FnbOrderRawRow): FnbOrderRecord {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomId: row.room_id,
    items: (row.items as FnbOrderItem[]) ?? [],
    notes: row.notes,
    allergyDeclared: row.allergy_declared,
    allergyDeclaredVia: row.allergy_declared_via,
    kitchenConfirmedBy: row.kitchen_confirmed_by,
    kitchenConfirmedAt: row.kitchen_confirmed_at,
    kitchenConfirmationNote: row.kitchen_confirmation_note,
    safetyAssuranceSentBy: row.safety_assurance_sent_by,
    safetyAssuranceSentAt: row.safety_assurance_sent_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const FNB_ORDER_COLUMNS = `id, property_id, room_id, items, notes, allergy_declared, allergy_declared_via,
       kitchen_confirmed_by, kitchen_confirmed_at::text as kitchen_confirmed_at,
       kitchen_confirmation_note, safety_assurance_sent_by,
       safety_assurance_sent_at::text as safety_assurance_sent_at, created_by, created_at::text as created_at`;

export class PostgresHotelesRepository implements HotelesRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async loadCharges(folioId: string): Promise<ChargeRecord[]> {
    const { rows } = await this.db.query<ChargeRawRow>(
      `select id, folio_id, description, amount, tax_amount, concept, reversed_by, reverses_charge_id,
              transferred_from_charge_id, discount_authorized_by, created_at::text as created_at
       from hoteles.charge where folio_id = $1 order by created_at asc;`,
      [folioId],
    );
    return rows.map(mapCharge);
  }

  private async loadPayments(folioId: string): Promise<PaymentRecord[]> {
    const { rows } = await this.db.query<PaymentRawRow>(
      `select id, folio_id, amount, method, status, external_ref, token_ref, created_at::text as created_at
       from hoteles.payment where folio_id = $1 order by created_at asc;`,
      [folioId],
    );
    return rows.map(mapPayment);
  }

  private async toFolioRecord(row: FolioRawRow): Promise<FolioRecord> {
    const [charges, payments] = await Promise.all([this.loadCharges(row.id), this.loadPayments(row.id)]);
    return {
      id: row.id,
      organizationId: row.organization_id,
      propertyId: row.property_id,
      reservationId: row.reservation_id,
      status: row.status,
      label: row.label,
      isPrimary: row.is_primary,
      closedAt: row.closed_at,
      closeReason: row.close_reason,
      arApprovedBy: row.ar_approved_by,
      charges,
      payments,
    };
  }

  async findFolio(propertyId: string, folioId: string): Promise<FolioRecord | null> {
    const { rows } = await this.db.query<FolioRawRow>(
      `select id, organization_id, property_id, reservation_id, status, label, is_primary,
              closed_at::text as closed_at, close_reason, ar_approved_by
       from hoteles.folio where id = $1 and property_id = $2;`,
      [folioId, propertyId],
    );
    const row = rows[0];
    return row ? this.toFolioRecord(row) : null;
  }

  async listFoliosByReservation(propertyId: string, reservationId: string): Promise<readonly FolioRecord[]> {
    const { rows } = await this.db.query<FolioRawRow>(
      `select id, organization_id, property_id, reservation_id, status, label, is_primary,
              closed_at::text as closed_at, close_reason, ar_approved_by
       from hoteles.folio where reservation_id = $1 and property_id = $2 order by is_primary desc, id asc;`,
      [reservationId, propertyId],
    );
    return Promise.all(rows.map((row) => this.toFolioRecord(row)));
  }

  async loadFolioGuestIdentity(reservationId: string): Promise<GuestIdentity> {
    const { rows } = await this.db.query<{ full_name: string | null; phone: string | null }>(
      `select g.full_name, g.phone
       from hoteles.reservation r
       join hoteles.guest g on g.id = r.guest_id
       where r.id = $1;`,
      [reservationId],
    );
    const row = rows[0];
    if (!row) return { lastName: null, phoneLast4: null };
    const nameParts = (row.full_name ?? "").trim().split(/\s+/).filter(Boolean);
    const lastName = nameParts.length > 0 ? nameParts[nameParts.length - 1]! : null;
    const phoneLast4 = row.phone && row.phone.length >= 4 ? row.phone.slice(-4) : null;
    return { lastName, phoneLast4 };
  }

  async isAdminStaff(propertyId: string, userId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ vertical_role: string }>(
      `select m.vertical_role
       from core.membership m
       join core.property p on p.organization_id = m.organization_id
       where p.id = $1 and m.user_id = $2 and (m.property_ids is null or p.id = any(m.property_ids));`,
      [propertyId, userId],
    );
    return rows.length > 0 && ["owner", "gm"].includes(rows[0]!.vertical_role);
  }

  async loadTaxConfig(propertyId: string): Promise<TaxConfigRecord> {
    const { rows } = await this.db.query<{ iva_rate: string; ish_rate: string; discount_threshold: string }>(
      `select iva_rate, ish_rate, discount_threshold from hoteles.tax_config where property_id = $1;`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) throw new Error(`No hay hoteles.tax_config configurado para property "${propertyId}".`);
    return { ivaRate: Number(row.iva_rate), ishRate: Number(row.ish_rate), discountThreshold: Number(row.discount_threshold) };
  }

  async insertCharge(input: NewChargeInput): Promise<{ id: string; createdAt: string }> {
    const { rows } = await this.db.query<{ id: string; created_at: string }>(
      `insert into hoteles.charge
         (organization_id, property_id, folio_id, description, amount, tax_amount, concept,
          reverses_charge_id, transferred_from_charge_id, discount_authorized_by, stay_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, created_at::text as created_at;`,
      [
        input.organizationId,
        input.propertyId,
        input.folioId,
        input.description,
        input.amount,
        input.taxAmount,
        input.concept,
        input.reversesChargeId ?? null,
        input.transferredFromChargeId ?? null,
        input.discountAuthorizedBy ?? null,
        input.stayDate ?? null,
      ],
    );
    return { id: rows[0]!.id, createdAt: rows[0]!.created_at };
  }

  async findCharge(folioId: string, chargeId: string) {
    const { rows } = await this.db.query<ChargeRawRow>(
      `select id, folio_id, description, amount, tax_amount, concept, reversed_by, reverses_charge_id,
              transferred_from_charge_id, discount_authorized_by, created_at::text as created_at
       from hoteles.charge where id = $1 and folio_id = $2;`,
      [chargeId, folioId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      description: row.description,
      amount: Number(row.amount),
      taxAmount: Number(row.tax_amount),
      concept: row.concept,
      reversedBy: row.reversed_by,
    };
  }

  async markChargeReversed(chargeId: string, reversalChargeId: string): Promise<void> {
    await this.db.query("select hoteles.mark_charge_reversed($1, $2);", [chargeId, reversalChargeId]);
  }

  async insertPayment(input: NewPaymentInput): Promise<{ id: string; createdAt: string }> {
    const { rows } = await this.db.query<{ id: string; created_at: string }>(
      `insert into hoteles.payment (organization_id, property_id, folio_id, amount, method, status, external_ref, token_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, created_at::text as created_at;`,
      [input.organizationId, input.propertyId, input.folioId, input.amount, input.method, input.status, input.externalRef ?? null, input.tokenRef ?? null],
    );
    return { id: rows[0]!.id, createdAt: rows[0]!.created_at };
  }

  async createFolio(propertyId: string, organizationId: string, reservationId: string, label: string): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into hoteles.folio (organization_id, property_id, reservation_id, label, is_primary)
       values ($1, $2, $3, $4, false)
       returning id;`,
      [organizationId, propertyId, reservationId, label],
    );
    return rows[0]!;
  }

  async closeFolio(folioId: string, reason: "saldo_cero" | "cuenta_por_cobrar", arApprovedBy: string | null): Promise<void> {
    await this.db.query(
      `update hoteles.folio set status = 'cerrado', closed_at = now(), close_reason = $1, ar_approved_by = $2, updated_at = now()
       where id = $3;`,
      [reason, arApprovedBy, folioId],
    );
  }

  async listFnbOrders(propertyId: string): Promise<readonly FnbOrderRecord[]> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `select ${FNB_ORDER_COLUMNS} from hoteles.fnb_order where property_id = $1 order by created_at desc;`,
      [propertyId],
    );
    return rows.map(mapFnbOrder);
  }

  async findFnbOrder(propertyId: string, orderId: string): Promise<FnbOrderRecord | null> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `select ${FNB_ORDER_COLUMNS} from hoteles.fnb_order where id = $1 and property_id = $2;`,
      [orderId, propertyId],
    );
    const row = rows[0];
    return row ? mapFnbOrder(row) : null;
  }

  async insertFnbOrder(input: NewFnbOrderInput): Promise<FnbOrderRecord> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `insert into hoteles.fnb_order
         (organization_id, property_id, room_id, items, notes, allergy_declared, allergy_declared_via, created_by)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       returning ${FNB_ORDER_COLUMNS};`,
      [input.organizationId, input.propertyId, input.roomId, JSON.stringify(input.items), input.notes, input.allergyDeclared, input.allergyDeclaredVia, input.createdBy],
    );
    return mapFnbOrder(rows[0]!);
  }

  async confirmFnbKitchen(propertyId: string, orderId: string, userId: string, note: string | null): Promise<FnbOrderRecord | null> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `update hoteles.fnb_order
       set kitchen_confirmed_by = $1, kitchen_confirmed_at = now(), kitchen_confirmation_note = $2, updated_at = now()
       where id = $3 and property_id = $4
       returning ${FNB_ORDER_COLUMNS};`,
      [userId, note, orderId, propertyId],
    );
    const row = rows[0];
    return row ? mapFnbOrder(row) : null;
  }

  async assureFnbSafety(propertyId: string, orderId: string, userId: string): Promise<FnbOrderRecord | null> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `update hoteles.fnb_order
       set safety_assurance_sent_by = $1, safety_assurance_sent_at = now(), updated_at = now()
       where id = $2 and property_id = $3
       returning ${FNB_ORDER_COLUMNS};`,
      [userId, orderId, propertyId],
    );
    const row = rows[0];
    return row ? mapFnbOrder(row) : null;
  }

  async findRoomType(propertyId: string, roomTypeId: string): Promise<{ id: string } | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `select id from hoteles.room_type where id = $1 and property_id = $2;`,
      [roomTypeId, propertyId],
    );
    return rows[0] ?? null;
  }

  async loadNightlyRates(propertyId: string, roomTypeId: string, checkInDate: string, checkOutDate: string): Promise<readonly NightlyRateRecord[]> {
    const { rows } = await this.db.query<{
      date: string;
      price: string;
      min_stay: number;
      closed_to_arrival: boolean;
      closed_to_departure: boolean;
    }>(
      `select date::text as date, price, min_stay, closed_to_arrival, closed_to_departure
       from hoteles.rate_plan
       where property_id = $1 and room_type_id = $2 and date >= $3 and date <= $4
       order by date asc;`,
      [propertyId, roomTypeId, checkInDate, checkOutDate],
    );
    return rows.map((r) => ({
      date: r.date,
      price: Number(r.price),
      minStay: r.min_stay,
      closedToArrival: r.closed_to_arrival,
      closedToDeparture: r.closed_to_departure,
    }));
  }

  async withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>> {
    const requestHash = hashBody(params.body);

    // Una llave ya EXPIRADA se reclama de nuevo atómicamente vía
    // `DO UPDATE ... WHERE expires_at < now()` — mismo patrón que
    // hoteles/apps/api/src/lib/idempotency.ts.
    const claim = await this.db.query<{ id: string }>(
      `insert into hoteles.idempotency_key (organization_id, scope, key, request_hash, expires_at)
       values ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
       on conflict (organization_id, scope, key) do update
         set request_hash = excluded.request_hash,
             response = null,
             created_at = now(),
             expires_at = excluded.expires_at
         where hoteles.idempotency_key.expires_at < now()
       returning id;`,
      [params.organizationId, params.scope, params.key, requestHash, String(IDEMPOTENCY_KEY_TTL_DAYS)],
    );

    if (claim.rows.length === 0) {
      const existing = await this.db.query<{ request_hash: string; response: IdempotentResult<T> | null }>(
        `select request_hash, response from hoteles.idempotency_key
         where organization_id = $1 and scope = $2 and key = $3;`,
        [params.organizationId, params.scope, params.key],
      );
      const row = existing.rows[0];
      if (!row) {
        // La fila que causó el conflicto se revirtió (rollback) entre el INSERT y
        // este SELECT: trátese como si nunca hubiera existido, reintenta una sola vez.
        return this.withIdempotency(params, run);
      }
      if (row.request_hash !== requestHash) throw new IdempotencyConflictError();
      if (row.response == null) {
        throw new Error("La solicitud original con este Idempotency-Key aún no terminó de procesarse.");
      }
      return row.response;
    }

    const result = await run();

    await this.db.query(`update hoteles.idempotency_key set response = $1 where organization_id = $2 and scope = $3 and key = $4;`, [
      JSON.stringify(result),
      params.organizationId,
      params.scope,
      params.key,
    ]);

    return result;
  }
}
