// PostgresRestaurantesRepository — adaptador de producción de `RestaurantesRepository`
// sobre `TenantDbSession` (el mismo contrato genérico que ya define
// @atiende/core-tenancy y consume core-auth/src/middleware.ts). Ejecuta las queries y
// RPCs reales contra `restaurantes.*` (migrations/001-004) y `core.organization`/
// `core.property` (packages/db/migrations/0001_core_schema.sql).
//
// Se abre siempre vía `TenancyEngine.withAppSession({ userId: null }, ...)` para las
// 3 rutas públicas/de sistema (create-order, customer-lookup, whatsapp-webhook) — no
// hay `auth.uid()` real en esos canales (ver diseño Fase 1 §3: ninguno de los 3 usa
// Supabase Auth de usuario, el "service role" original se traduce aquí a una sesión
// de sistema con userId:null + policies RLS explícitas para esa sesión).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { OrderConflictError } from "./errors.ts";
import type {
  Branch,
  BranchProductState,
  BranchSummary,
  CallbackRequest,
  CallbackRequestInput,
  Category,
  CategoryPatch,
  Customer,
  CustomerAddress,
  CustomerListFilter,
  CustomerListPage,
  CustomerTier,
  NearestBranchMatch,
  NewCategoryInput,
  NewProductInput,
  NewPromotionInput,
  Order,
  OrderListFilter,
  OrderListPage,
  OrderStatus,
  PersistedOrderItem,
  Product,
  ProductPatch,
  Promotion,
  PromotionPatch,
} from "./types.ts";
import type {
  ChannelStatsRow,
  ConversationMessage,
  CustomerOverviewRow,
  EmailOutboxJobRow,
  KpiDateRange,
  MessagingOutboxRow,
  NewOrderRecord,
  RestaurantesRepository,
  SalesBucketRow,
  SearchableProduct,
  StaffOrderNotificationEventType,
  StaffOrderNotificationRecord,
  TierDistributionMetric,
  TierDistributionRow,
  WhatsAppConversationStatsRow,
} from "./repository.ts";

interface BranchRow {
  readonly property_id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "inactive";
  readonly phone: string | null;
  readonly address: string | null;
  readonly lat: string | number | null;
  readonly lng: string | number | null;
}

function mapBranch(row: BranchRow): Branch {
  return {
    propertyId: row.property_id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    phone: row.phone,
    address: row.address,
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
  };
}

interface NearestBranchRow extends BranchRow {
  readonly distance_km: string | number;
  readonly recognized_zone_name: string;
}

interface ProductRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category_name: string | null;
  readonly search_keywords: readonly string[];
  readonly price: string;
  readonly is_available: boolean;
}

interface CustomerRow {
  readonly id: string;
  readonly organization_id: string;
  readonly phone: string;
  readonly name: string | null;
  readonly order_count: number;
}

function mapCustomer(row: CustomerRow): Customer {
  return { id: row.id, organizationId: row.organization_id, phone: row.phone, name: row.name, orderCount: row.order_count };
}

interface OrderRow {
  readonly id: string;
  readonly organization_id: string;
  readonly property_id: string;
  readonly customer_id: string | null;
  readonly customer_name: string;
  readonly customer_phone: string;
  readonly customer_address: string | null;
  readonly customer_email: string | null;
  readonly branch: string | null;
  readonly total: string;
  readonly status: Order["status"];
  readonly items: readonly PersistedOrderItem[];
  readonly source: Order["source"];
  readonly notes: string | null;
  readonly payment_method: Order["paymentMethod"];
  readonly call_transcript: string | null;
  readonly call_recording_url: string | null;
  readonly dedupe_fingerprint: string | null;
  readonly idempotency_key: string | null;
  readonly created_at: string;
  readonly assigned_repartidor_id: string | null;
  readonly estimated_delivery_at: string | null;
  readonly incident_note: string | null;
}

function mapOrder(row: OrderRow): Order {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    customerEmail: row.customer_email,
    branch: row.branch,
    total: Number(row.total),
    status: row.status,
    items: row.items,
    source: row.source,
    notes: row.notes,
    paymentMethod: row.payment_method,
    callTranscript: row.call_transcript,
    callRecordingUrl: row.call_recording_url,
    dedupeFingerprint: row.dedupe_fingerprint,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    // Fase 8 — `create_order_idempotent()` (migrations/003) devuelve `to_jsonb(v_order)`
    // de `restaurantes.orders%rowtype`, así que estas 3 columnas nuevas ya viajan solas
    // (null) en CUALQUIER OrderRow, incluido el de creación de pedido — nunca hace falta
    // tocar esa función SQL para que este mapeo sea correcto.
    assignedRepartidorId: row.assigned_repartidor_id,
    estimatedDeliveryAt: row.estimated_delivery_at,
    incidentNote: row.incident_note,
  };
}

const ORDER_COLUMNS =
  "id, organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, customer_email, branch, total, status, items, source, notes, payment_method, call_transcript, call_recording_url, dedupe_fingerprint, idempotency_key, created_at, assigned_repartidor_id, estimated_delivery_at, incident_note";

interface CategoryRow {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly slug: string;
  readonly display_order: number;
}

function mapCategory(row: CategoryRow): Category {
  return { id: row.id, organizationId: row.organization_id, name: row.name, slug: row.slug, displayOrder: row.display_order };
}

interface AdminProductRow {
  readonly id: string;
  readonly organization_id: string;
  readonly category_id: string | null;
  readonly category_name: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly price: string;
  readonly image_url: string | null;
  readonly is_popular: boolean;
  readonly is_available: boolean;
  readonly display_order: number;
  readonly search_keywords: readonly string[];
}

function mapAdminProduct(row: AdminProductRow): Product {
  return {
    id: row.id,
    organizationId: row.organization_id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    imageUrl: row.image_url,
    isPopular: row.is_popular,
    isAvailable: row.is_available,
    displayOrder: row.display_order,
    searchKeywords: row.search_keywords,
  };
}

const ADMIN_PRODUCT_COLUMNS = `pr.id, pr.organization_id, pr.category_id, c.name as category_name, pr.name, pr.description, pr.price, pr.image_url, pr.is_popular, pr.is_available, pr.display_order, pr.search_keywords`;
const ADMIN_PRODUCT_FROM = `from restaurantes.products pr left join restaurantes.categories c on c.id = pr.category_id`;

interface PromotionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: "percentage" | "fixed";
  readonly value: string;
  readonly min_order_total: string | null;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly days_of_week: readonly number[] | null;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly max_uses: number | null;
  readonly times_used: number;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/** `start_time`/`end_time` vuelven de Postgres como "HH:MM:SS" (tipo `time`) —
 * se recorta a "HH:MM" para que coincida exactamente con el formato que ya usa
 * `Promotion.startTime`/`endTime` y `promotions.ts::minutesSinceMidnight`. */
function toHhMm(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

function mapPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    organizationId: row.organization_id,
    code: row.code,
    name: row.name,
    description: row.description,
    type: row.type,
    value: Number(row.value),
    minOrderTotal: row.min_order_total === null ? null : Number(row.min_order_total),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    daysOfWeek: row.days_of_week,
    startTime: toHhMm(row.start_time),
    endTime: toHhMm(row.end_time),
    maxUses: row.max_uses,
    timesUsed: row.times_used,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROMOTION_COLUMNS =
  "id, organization_id, code, name, description, type, value, min_order_total, starts_at, ends_at, days_of_week, start_time, end_time, max_uses, times_used, is_active, created_at, updated_at";

interface BranchProductRow {
  readonly property_id: string;
  readonly product_id: string;
  readonly price: string;
  readonly is_available: boolean;
}

function mapBranchProductState(row: BranchProductRow): BranchProductState {
  return { propertyId: row.property_id, productId: row.product_id, price: Number(row.price), isAvailable: row.is_available };
}

export class PostgresRestaurantesRepository implements RestaurantesRepository {
  constructor(private readonly db: TenantDbSession) {}

  async findOrganizationBySlug(slug: string): Promise<{ id: string; slug: string; name: string } | null> {
    const { rows } = await this.db.query<{ id: string; slug: string; name: string }>(
      `select id, slug, name from core.organization where slug = $1 and vertical = 'restaurantes';`,
      [slug],
    );
    return rows[0] ?? null;
  }

  async findBranch(organizationId: string, selector: { slug?: string; name?: string }): Promise<Branch | null> {
    const column = selector.slug !== undefined ? "bd.slug" : "p.name";
    const value = selector.slug !== undefined ? selector.slug : selector.name;
    const { rows } = await this.db.query<BranchRow>(
      `select p.id as property_id, p.organization_id, p.name, bd.slug, p.status, bd.phone, bd.address, bd.lat, bd.lng
       from core.property p
       join restaurantes.branch_detail bd on bd.property_id = p.id
       where p.organization_id = $1 and ${column} = $2
       limit 1;`,
      [organizationId, value],
    );
    return rows[0] ? mapBranch(rows[0]) : null;
  }

  async listBranchesForOrganization(organizationId: string): Promise<readonly BranchSummary[]> {
    const { rows } = await this.db.query<{ property_id: string; name: string; slug: string; address: string | null }>(
      `select p.id as property_id, p.name, bd.slug, bd.address
       from core.property p
       join restaurantes.branch_detail bd on bd.property_id = p.id
       where p.organization_id = $1 and p.status = 'active'
       order by bd.display_order asc, p.name asc;`,
      [organizationId],
    );
    return rows.map((row) => ({ propertyId: row.property_id, name: row.name, slug: row.slug, address: row.address }));
  }

  async findNearestBranchByColonia(organizationId: string, colonia: string): Promise<NearestBranchMatch | null> {
    // restaurantes.nearest_branch_by_colonia (ver migrations/005) — port de
    // sucursal_mas_cercana() del origen, generalizado por organización: cero
    // filas cuando la colonia no matchea ninguna zona conocida de ESTA
    // organización — nunca se inventa/adivina una sucursal.
    const { rows } = await this.db.query<NearestBranchRow>(`select * from restaurantes.nearest_branch_by_colonia($1, $2);`, [organizationId, colonia]);
    const row = rows[0];
    if (!row) return null;
    return {
      branch: mapBranch(row),
      distanceKm: Number(row.distance_km),
      recognizedZoneName: row.recognized_zone_name,
    };
  }

  async listAvailableProductsForBranch(propertyId: string): Promise<readonly SearchableProduct[]> {
    const { rows } = await this.db.query<ProductRow>(
      `select pr.id, pr.name, pr.description, c.name as category_name, pr.search_keywords, bp.price, bp.is_available
       from restaurantes.branch_products bp
       join restaurantes.products pr on pr.id = bp.product_id
       left join restaurantes.categories c on c.id = pr.category_id
       where bp.property_id = $1 and bp.is_available = true
       limit 400;`,
      [propertyId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      categoryName: row.category_name,
      searchKeywords: row.search_keywords,
      price: Number(row.price),
      isAvailable: row.is_available,
    }));
  }

  async findCustomerByPhone(organizationId: string, phone: string): Promise<Customer | null> {
    const { rows } = await this.db.query<CustomerRow>(
      `select id, organization_id, phone, name, order_count from restaurantes.customers where organization_id = $1 and phone = $2;`,
      [organizationId, phone],
    );
    return rows[0] ? mapCustomer(rows[0]) : null;
  }

  async upsertCustomer(organizationId: string, phone: string, name: string): Promise<Customer> {
    // Port literal de upsertCustomer() del origen: intenta insertar, y si pierde la
    // carrera del UNIQUE(organization_id, phone) real (23505), relee y actualiza en
    // vez de propagar el error — nunca sobreescribe un nombre ya conocido.
    const { rows: existingRows } = await this.db.query<CustomerRow>(
      `select id, organization_id, phone, name, order_count from restaurantes.customers where organization_id = $1 and phone = $2;`,
      [organizationId, phone],
    );
    if (existingRows[0]) {
      const existing = existingRows[0];
      const { rows: updated } = await this.db.query<CustomerRow>(
        `update restaurantes.customers set name = coalesce(name, $3), updated_at = now()
         where id = $1 and organization_id = $2
         returning id, organization_id, phone, name, order_count;`,
        [existing.id, organizationId, name],
      );
      return mapCustomer(updated[0] ?? existing);
    }
    try {
      const { rows: created } = await this.db.query<CustomerRow>(
        `insert into restaurantes.customers (organization_id, phone, name, order_count)
         values ($1, $2, $3, 0)
         returning id, organization_id, phone, name, order_count;`,
        [organizationId, phone, name],
      );
      return mapCustomer(created[0]!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/unique|duplicate/i.test(message)) throw err;
      const { rows: race } = await this.db.query<CustomerRow>(
        `select id, organization_id, phone, name, order_count from restaurantes.customers where organization_id = $1 and phone = $2;`,
        [organizationId, phone],
      );
      const winner = race[0];
      if (!winner) throw err;
      const { rows: updated } = await this.db.query<CustomerRow>(
        `update restaurantes.customers set name = coalesce(name, $3), updated_at = now()
         where id = $1 and organization_id = $2
         returning id, organization_id, phone, name, order_count;`,
        [winner.id, organizationId, name],
      );
      return mapCustomer(updated[0] ?? winner);
    }
  }

  async addCustomerAddressIfNew(customerId: string, address: string): Promise<void> {
    const { rows: countRows } = await this.db.query<{ count: string }>(
      `select count(*)::text as count from restaurantes.customer_addresses where customer_id = $1;`,
      [customerId],
    );
    const isFirst = Number(countRows[0]?.count ?? "0") === 0;
    await this.db.query(
      `insert into restaurantes.customer_addresses (customer_id, address, is_default)
       values ($1, $2, $3)
       on conflict (customer_id, address) do nothing;`,
      [customerId, address, isFirst],
    );
  }

  async listCustomerAddresses(customerId: string): Promise<readonly CustomerAddress[]> {
    const { rows } = await this.db.query<{ address: string; label: string | null; is_default: boolean }>(
      `select address, label, is_default from restaurantes.customer_addresses where customer_id = $1 order by is_default desc;`,
      [customerId],
    );
    return rows.map((row) => ({ address: row.address, label: row.label, isDefault: row.is_default }));
  }

  async listEligibleOrderHistory(customerId: string): Promise<ReadonlyArray<{ items: readonly PersistedOrderItem[]; createdAt: string }>> {
    const { rows } = await this.db.query<{ items: readonly PersistedOrderItem[]; created_at: string }>(
      `select items, created_at from restaurantes.orders
       where customer_id = $1
         and status in ('pending', 'preparando', 'en_camino', 'entregado', 'completado')
       order by created_at desc;`,
      [customerId],
    );
    return rows.map((row) => ({ items: row.items, createdAt: row.created_at }));
  }

  async calcCustomerTier(organizationId: string, customerId: string): Promise<CustomerTier | null> {
    const { rows } = await this.db.query<{ tier: CustomerTier | null }>(
      `select (restaurantes.calc_customer_tier($1, $2)->>'tier') as tier;`,
      [organizationId, customerId],
    );
    return rows[0]?.tier ?? null;
  }

  async createOrderIdempotent(order: NewOrderRecord, dedupeFingerprint: string, idempotencyKey: string | null): Promise<Order> {
    // restaurantes.create_order_idempotent (ver migrations/003) lanza sqlstate PT409
    // cuando la misma idempotency_key se reutiliza con un dedupe_fingerprint distinto
    // (pedido con contenido materialmente diferente) — port literal de
    // `insertError?.code === "PT409"` en create-order-core.ts del origen: se traduce
    // aquí, en el punto real donde llega el error crudo de Postgres, al
    // OrderConflictError tipado que ya consume apps/api/src/routes/verticals/restaurantes/public.ts.
    try {
      const { rows } = await this.db.query<{ create_order_idempotent: OrderRow }>(
        `select restaurantes.create_order_idempotent($1::jsonb, $2, $3) as create_order_idempotent;`,
        [
          JSON.stringify({
            organization_id: order.organizationId,
            property_id: order.propertyId,
            customer_id: order.customerId,
            customer_name: order.customerName,
            customer_phone: order.customerPhone,
            customer_address: order.customerAddress,
            customer_email: order.customerEmail,
            branch: order.branch,
            total: order.total,
            items: order.items,
            source: order.source,
            notes: order.notes,
            payment_method: order.paymentMethod,
            call_transcript: order.callTranscript,
            call_recording_url: order.callRecordingUrl,
          }),
          dedupeFingerprint,
          idempotencyKey,
        ],
      );
      return mapOrder(rows[0]!.create_order_idempotent);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "PT409") {
        throw new OrderConflictError("Este intento de pedido ya fue procesado con datos diferentes. Revisa el pedido existente antes de crear otro.");
      }
      throw err;
    }
  }

  async createCallbackRequest(input: CallbackRequestInput): Promise<CallbackRequest> {
    const { rows } = await this.db.query<{ id: string; resolved: boolean; created_at: string }>(
      `insert into restaurantes.callback_requests (organization_id, property_id, customer_name, customer_phone, reason, message, source)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, resolved, created_at;`,
      [input.organizationId, input.propertyId ?? null, input.customerName, input.customerPhone, input.reason ?? null, input.message ?? null, input.source],
    );
    const row = rows[0]!;
    return { ...input, id: row.id, resolved: row.resolved, createdAt: row.created_at };
  }

  async consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const { rows } = await this.db.query<{ consume_api_rate_limit: boolean }>(
      `select restaurantes.consume_api_rate_limit($1, $2, $3, $4) as consume_api_rate_limit;`,
      [scope, actorHash, maxRequests, windowSeconds],
    );
    return rows[0]?.consume_api_rate_limit === true;
  }

  async resolveOrganizationByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ organization_id: string }>(
      `select organization_id from restaurantes.whatsapp_channel_config where phone_number_id = $1;`,
      [phoneNumberId],
    );
    return rows[0]?.organization_id ?? null;
  }

  async claimWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string): Promise<boolean> {
    const { rows } = await this.db.query<{ claim_whatsapp_message: boolean }>(
      `select restaurantes.claim_whatsapp_message($1, $2, $3) as claim_whatsapp_message;`,
      [organizationId, messageId, phoneHash],
    );
    return rows[0]?.claim_whatsapp_message === true;
  }

  async claimWhatsAppConversation(organizationId: string, phoneHash: string, messageId: string, leaseSeconds: number): Promise<boolean> {
    const { rows } = await this.db.query<{ claim_whatsapp_conversation: boolean }>(
      `select restaurantes.claim_whatsapp_conversation($1, $2, $3, $4) as claim_whatsapp_conversation;`,
      [organizationId, phoneHash, messageId, leaseSeconds],
    );
    return rows[0]?.claim_whatsapp_conversation === true;
  }

  async appendWhatsAppUserMessageOnce(organizationId: string, phone: string, message: ConversationMessage): Promise<readonly ConversationMessage[]> {
    const { rows } = await this.db.query<{ append_whatsapp_user_message_once: ConversationMessage[] }>(
      `select restaurantes.append_whatsapp_user_message_once($1, $2, $3, $4::jsonb) as append_whatsapp_user_message_once;`,
      [organizationId, `msg:${phone}:${Date.now()}`, phone, JSON.stringify(message)],
    );
    return rows[0]?.append_whatsapp_user_message_once ?? [message];
  }

  async whatsappAppendTurn(
    organizationId: string,
    phone: string,
    newMessages: readonly ConversationMessage[],
    status: "active" | "completed" | "abandoned" | null,
    orderId: string | null,
    propertyId: string | null,
  ): Promise<readonly ConversationMessage[]> {
    const { rows } = await this.db.query<{ whatsapp_append_turn: ConversationMessage[] }>(
      `select restaurantes.whatsapp_append_turn($1, $2, $3::jsonb, $4, $5, $6) as whatsapp_append_turn;`,
      [organizationId, phone, JSON.stringify(newMessages), status, orderId, propertyId],
    );
    return rows[0]?.whatsapp_append_turn ?? [];
  }

  async finishWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string, status: "processed" | "failed", errorClass: string | null): Promise<void> {
    await this.db.query(`select restaurantes.finish_whatsapp_message($1, $2, $3, $4, $5);`, [organizationId, messageId, phoneHash, status, errorClass]);
  }

  async markInboundEventFailed(organizationId: string, messageId: string, errorClass: string): Promise<void> {
    await this.db.query(
      `update restaurantes.whatsapp_inbound_events set status = 'failed', last_error_class = $3
       where message_id = $2 and organization_id = $1;`,
      [organizationId, messageId, errorClass],
    );
  }

  // ---- Dispatcher real de messaging_outbox (migrations/007) ----

  async enqueueMessagingOutbox(organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    await this.db.query(`select restaurantes.enqueue_messaging_outbox($1, $2, $3, $4, $5::jsonb);`, [organizationId, channel, eventType, dedupeKey, JSON.stringify(payload)]);
  }

  async claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]> {
    const { rows } = await this.db.query<{ id: string; attempts: number; payload: unknown }>(`select id, attempts, payload from restaurantes.claim_messaging_outbox_batch($1, $2);`, [limit, leaseSeconds]);
    return rows.map((r) => ({ id: r.id, attempts: r.attempts, payload: r.payload }));
  }

  async markMessagingOutboxSent(id: string): Promise<void> {
    await this.db.query(`select restaurantes.complete_messaging_outbox_sent($1);`, [id]);
  }

  async markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
    await this.db.query(`select restaurantes.complete_messaging_outbox_retry($1, $2, $3, $4);`, [id, attempts, errorClass, nextAttemptAtIso]);
  }

  async markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void> {
    await this.db.query(`select restaurantes.complete_messaging_outbox_dead($1, $2, $3);`, [id, attempts, errorClass]);
  }

  // ============================================================================
  // Dispatcher real de correo (ver migrations/011_email_outbox_dispatch.sql) —
  // mismo patrón exacto que @atiende/domain-citas::PostgresCitasRepository, sobre
  // la columna real de este dominio (`last_error_class`, ver `complete_error` más
  // abajo de restaurantes.messaging_outbox).
  // ============================================================================

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const { rows } = await this.db.query<{ id: string; organization_id: string; attempts: number; payload: Record<string, unknown> }>(`select id, organization_id, attempts, payload from restaurantes.claim_email_outbox_batch($1);`, [limit]);
    return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, attempts: r.attempts, payload: r.payload ?? {} }));
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    await this.db.query(`select restaurantes.complete_email_outbox_job($1, $2, $3);`, [id, status, error]);
  }

  // Fase 9 — sentido SALIENTE de `restaurantes.whatsapp_channel_config`
  // (migrations/001, `organization_id` es su PK real: un solo `phone_number_id` por
  // organización) — ver comentario completo en repository.ts.
  async resolveActiveWhatsAppPhoneNumberId(organizationId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ phone_number_id: string }>(`select phone_number_id from restaurantes.whatsapp_channel_config where organization_id = $1;`, [organizationId]);
    return rows[0]?.phone_number_id ?? null;
  }

  // ---- Fase 9 — bandeja de notificaciones internas al staff (ver
  // order-notifications.ts, migrations/009_order_notifications.sql) ----

  async createStaffOrderNotification(
    organizationId: string,
    propertyId: string,
    orderId: string,
    eventType: StaffOrderNotificationEventType,
    message: string,
  ): Promise<StaffOrderNotificationRecord> {
    const { rows } = await this.db.query<{
      id: string;
      created_at: string;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
    }>(`select id, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by from restaurantes.enqueue_staff_order_notification($1, $2, $3, $4, $5);`, [
      organizationId,
      propertyId,
      orderId,
      eventType,
      message,
    ]);
    const row = rows[0]!;
    return { id: row.id, organizationId, propertyId, orderId, eventType, message, createdAt: row.created_at, acknowledgedAt: row.acknowledged_at, acknowledgedBy: row.acknowledged_by };
  }

  async listStaffOrderNotifications(
    organizationId: string,
    propertyIds: readonly string[] | null,
    options?: { readonly unacknowledgedOnly?: boolean; readonly limit?: number },
  ): Promise<readonly StaffOrderNotificationRecord[]> {
    const limit = options?.limit ?? 50;
    const { rows } = await this.db.query<{
      id: string;
      property_id: string;
      order_id: string;
      event_type: StaffOrderNotificationEventType;
      message: string;
      created_at: string;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
    }>(
      `select id, property_id, order_id, event_type, message, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by
       from restaurantes.staff_order_notification
       where organization_id = $1
         and ($2::uuid[] is null or property_id = any($2::uuid[]))
         and ($3::boolean is false or acknowledged_at is null)
       order by created_at desc
       limit $4;`,
      [organizationId, propertyIds !== null ? propertyIds : null, options?.unacknowledgedOnly ?? false, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      organizationId,
      propertyId: r.property_id,
      orderId: r.order_id,
      eventType: r.event_type,
      message: r.message,
      createdAt: r.created_at,
      acknowledgedAt: r.acknowledged_at,
      acknowledgedBy: r.acknowledged_by,
    }));
  }

  async acknowledgeStaffOrderNotification(organizationId: string, notificationId: string, actorId: string): Promise<StaffOrderNotificationRecord> {
    const { rows } = await this.db.query<{
      property_id: string;
      order_id: string;
      event_type: StaffOrderNotificationEventType;
      message: string;
      created_at: string;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
    }>(
      `update restaurantes.staff_order_notification set acknowledged_at = now(), acknowledged_by = $1
       where organization_id = $2 and id = $3
       returning property_id, order_id, event_type, message, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by;`,
      [actorId, organizationId, notificationId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Notificación "${notificationId}" no encontrada para la organización "${organizationId}".`);
    return {
      id: notificationId,
      organizationId,
      propertyId: row.property_id,
      orderId: row.order_id,
      eventType: row.event_type,
      message: row.message,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
    };
  }

  // ---- KPIs de admin (Fase 3 — ver migrations/006_kpi_aggregates.sql) ----

  async getSalesBucketedStats(organizationId: string, propertyIds: readonly string[] | null, buckets: readonly KpiDateRange[]): Promise<readonly SalesBucketRow[]> {
    if (buckets.length === 0) return [];
    const { rows } = await this.db.query<{ idx: number; revenue: string; order_count: string; customer_count: string }>(
      `select idx, revenue, order_count, customer_count
       from restaurantes.orders_bucketed_stats($1, $2::uuid[], $3::timestamptz[], $4::timestamptz[]);`,
      [organizationId, propertyIds ? [...propertyIds] : null, buckets.map((b) => b.start.toISOString()), buckets.map((b) => b.end.toISOString())],
    );
    const byIdx = new Map(rows.map((row) => [Number(row.idx), { revenue: Number(row.revenue), orderCount: Number(row.order_count), customerCount: Number(row.customer_count) }]));
    return buckets.map((_, i) => byIdx.get(i + 1) ?? { revenue: 0, orderCount: 0, customerCount: 0 });
  }

  async getFirstOrderCreatedAt(organizationId: string, propertyIds: readonly string[] | null): Promise<Date | null> {
    const { rows } = await this.db.query<{ min: string | null }>(
      `select min(created_at) as min from restaurantes.orders where organization_id = $1 and ($2::uuid[] is null or property_id = any($2::uuid[]));`,
      [organizationId, propertyIds ? [...propertyIds] : null],
    );
    const min = rows[0]?.min ?? null;
    return min === null ? null : new Date(min);
  }

  async getChannelStats(organizationId: string, propertyIds: readonly string[] | null): Promise<ChannelStatsRow> {
    const { rows } = await this.db.query<{
      total_orders: string;
      total_revenue: string;
      voice_orders: string;
      voice_completed: string;
      voice_cancelled: string;
      voice_revenue: string;
      whatsapp_orders: string;
      whatsapp_completed: string;
      whatsapp_cancelled: string;
      whatsapp_revenue: string;
    }>(`select * from restaurantes.orders_channel_stats($1, $2::uuid[]);`, [organizationId, propertyIds ? [...propertyIds] : null]);
    const row = rows[0];
    if (!row) return { totalOrders: 0, totalRevenue: 0, voice: { orders: 0, completed: 0, cancelled: 0, revenue: 0 }, whatsapp: { orders: 0, completed: 0, cancelled: 0, revenue: 0 } };
    return {
      totalOrders: Number(row.total_orders),
      totalRevenue: Number(row.total_revenue),
      voice: { orders: Number(row.voice_orders), completed: Number(row.voice_completed), cancelled: Number(row.voice_cancelled), revenue: Number(row.voice_revenue) },
      whatsapp: { orders: Number(row.whatsapp_orders), completed: Number(row.whatsapp_completed), cancelled: Number(row.whatsapp_cancelled), revenue: Number(row.whatsapp_revenue) },
    };
  }

  async getWhatsappConversationStats(organizationId: string, propertyIds: readonly string[] | null): Promise<WhatsAppConversationStatsRow> {
    const { rows } = await this.db.query<{ total: string; with_order: string; average_messages: string }>(
      `select total, with_order, average_messages from restaurantes.whatsapp_conversation_stats($1, $2::uuid[]);`,
      [organizationId, propertyIds ? [...propertyIds] : null],
    );
    const row = rows[0];
    if (!row) return { total: 0, withOrder: 0, averageMessages: 0 };
    return { total: Number(row.total), withOrder: Number(row.with_order), averageMessages: Number(row.average_messages) };
  }

  async getCustomerOverviewKpis(organizationId: string): Promise<CustomerOverviewRow> {
    const { rows } = await this.db.query<{
      total_customers: string;
      average_order_value: string | null;
      customers_with_orders: string;
      recurring_customers: string;
      top_customer_id: string | null;
      top_customer_name: string | null;
      top_customer_phone: string | null;
      top_customer_order_count: number | null;
      avg_days_since_last_order: string | null;
    }>(`select * from restaurantes.get_customer_overview_kpis($1);`, [organizationId]);
    const row = rows[0];
    if (!row) {
      return { totalCustomers: 0, averageOrderValue: null, customersWithOrders: 0, recurringCustomers: 0, topCustomer: null, avgDaysSinceLastOrder: null };
    }
    return {
      totalCustomers: Number(row.total_customers),
      averageOrderValue: row.average_order_value === null ? null : Number(row.average_order_value),
      customersWithOrders: Number(row.customers_with_orders),
      recurringCustomers: Number(row.recurring_customers),
      topCustomer:
        row.top_customer_id === null
          ? null
          : { id: row.top_customer_id, name: row.top_customer_name, phone: row.top_customer_phone ?? "", orderCount: row.top_customer_order_count ?? 0 },
      avgDaysSinceLastOrder: row.avg_days_since_last_order === null ? null : Number(row.avg_days_since_last_order),
    };
  }

  async getCustomerTierDistribution(organizationId: string): Promise<TierDistributionRow> {
    const { rows } = await this.db.query<{ metric: TierDistributionMetric; black: string; platinum: string; gold: string; blue: string; without_tier: string }>(
      `select metric, black, platinum, gold, blue, without_tier from restaurantes.calc_customer_tier_distribution($1);`,
      [organizationId],
    );
    const row = rows[0];
    if (!row) return { metric: "sin_datos", black: 0, platinum: 0, gold: 0, blue: 0, withoutTier: 0 };
    return {
      metric: row.metric,
      black: Number(row.black),
      platinum: Number(row.platinum),
      gold: Number(row.gold),
      blue: Number(row.blue),
      withoutTier: Number(row.without_tier),
    };
  }

  // ---- Fase 5 — back-office CORE (ver migrations/007_admin_backoffice_grants_and_policies.sql) ----

  async findBranchById(organizationId: string, propertyId: string): Promise<Branch | null> {
    const { rows } = await this.db.query<BranchRow>(
      `select p.id as property_id, p.organization_id, p.name, bd.slug, p.status, bd.phone, bd.address, bd.lat, bd.lng
       from core.property p
       join restaurantes.branch_detail bd on bd.property_id = p.id
       where p.organization_id = $1 and p.id = $2
       limit 1;`,
      [organizationId, propertyId],
    );
    return rows[0] ? mapBranch(rows[0]) : null;
  }

  async listBranchesForOrganizationAdmin(organizationId: string): Promise<readonly Branch[]> {
    const { rows } = await this.db.query<BranchRow>(
      `select p.id as property_id, p.organization_id, p.name, bd.slug, p.status, bd.phone, bd.address, bd.lat, bd.lng
       from core.property p
       join restaurantes.branch_detail bd on bd.property_id = p.id
       where p.organization_id = $1
       order by bd.display_order asc, p.name asc;`,
      [organizationId],
    );
    return rows.map(mapBranch);
  }

  async updateBranchDetail(
    organizationId: string,
    propertyId: string,
    patch: { readonly phone?: string | null; readonly address?: string | null; readonly lat?: number | null; readonly lng?: number | null; readonly slug?: string; readonly displayOrder?: number },
  ): Promise<Branch | null> {
    // Solo escribe `restaurantes.branch_detail` — `core.property.status`/`name` no
    // tienen GRANT de escritura para `authenticated` (ver comentario de
    // `RestaurantesRepository.updateBranchDetail`), así que ni se intentan tocar
    // aquí. `coalesce` deja intacto cualquier campo que el caller no mandó.
    const { rows } = await this.db.query<{ exists: boolean }>(`select exists(select 1 from core.property where id = $1 and organization_id = $2) as exists;`, [propertyId, organizationId]);
    if (!rows[0]?.exists) return null;

    await this.db.query(
      `update restaurantes.branch_detail
       set phone = case when $3::boolean then $4 else phone end,
           address = case when $5::boolean then $6 else address end,
           lat = case when $7::boolean then $8 else lat end,
           lng = case when $9::boolean then $10 else lng end,
           slug = coalesce($11, slug),
           display_order = coalesce($12, display_order)
       where property_id = $1 and organization_id = $2;`,
      [
        propertyId,
        organizationId,
        patch.phone !== undefined,
        patch.phone ?? null,
        patch.address !== undefined,
        patch.address ?? null,
        patch.lat !== undefined,
        patch.lat ?? null,
        patch.lng !== undefined,
        patch.lng ?? null,
        patch.slug ?? null,
        patch.displayOrder ?? null,
      ],
    );
    return this.findBranchById(organizationId, propertyId);
  }

  async listCategories(organizationId: string): Promise<readonly Category[]> {
    const { rows } = await this.db.query<CategoryRow>(
      `select id, organization_id, name, slug, display_order from restaurantes.categories where organization_id = $1 order by display_order asc, name asc;`,
      [organizationId],
    );
    return rows.map(mapCategory);
  }

  async createCategory(organizationId: string, input: NewCategoryInput): Promise<Category> {
    const { rows } = await this.db.query<CategoryRow>(
      `insert into restaurantes.categories (organization_id, name, slug, display_order)
       values ($1, $2, $3, $4)
       returning id, organization_id, name, slug, display_order;`,
      [organizationId, input.name, input.slug, input.displayOrder ?? 0],
    );
    return mapCategory(rows[0]!);
  }

  async updateCategory(organizationId: string, categoryId: string, patch: CategoryPatch): Promise<Category | null> {
    const { rows } = await this.db.query<CategoryRow>(
      `update restaurantes.categories
       set name = coalesce($3, name), slug = coalesce($4, slug), display_order = coalesce($5, display_order)
       where id = $1 and organization_id = $2
       returning id, organization_id, name, slug, display_order;`,
      [categoryId, organizationId, patch.name ?? null, patch.slug ?? null, patch.displayOrder ?? null],
    );
    return rows[0] ? mapCategory(rows[0]) : null;
  }

  async listProducts(organizationId: string): Promise<readonly Product[]> {
    const { rows } = await this.db.query<AdminProductRow>(
      `select ${ADMIN_PRODUCT_COLUMNS} ${ADMIN_PRODUCT_FROM} where pr.organization_id = $1 order by pr.display_order asc, pr.name asc;`,
      [organizationId],
    );
    return rows.map(mapAdminProduct);
  }

  async findProduct(organizationId: string, productId: string): Promise<Product | null> {
    const { rows } = await this.db.query<AdminProductRow>(`select ${ADMIN_PRODUCT_COLUMNS} ${ADMIN_PRODUCT_FROM} where pr.organization_id = $1 and pr.id = $2;`, [organizationId, productId]);
    return rows[0] ? mapAdminProduct(rows[0]) : null;
  }

  async createProduct(organizationId: string, input: NewProductInput): Promise<Product> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into restaurantes.products (organization_id, category_id, name, description, price, image_url, is_popular, is_available, display_order, search_keywords)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id;`,
      [
        organizationId,
        input.categoryId ?? null,
        input.name,
        input.description ?? null,
        input.price,
        input.imageUrl ?? null,
        input.isPopular ?? false,
        input.isAvailable ?? true,
        input.displayOrder ?? 0,
        input.searchKeywords ? [...input.searchKeywords] : [],
      ],
    );
    return (await this.findProduct(organizationId, rows[0]!.id))!;
  }

  async updateProduct(organizationId: string, productId: string, patch: ProductPatch): Promise<Product | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `update restaurantes.products
       set category_id = case when $3::boolean then $4::uuid else category_id end,
           name = coalesce($5, name),
           description = case when $6::boolean then $7 else description end,
           price = coalesce($8, price),
           image_url = case when $9::boolean then $10 else image_url end,
           is_popular = coalesce($11, is_popular),
           is_available = coalesce($12, is_available),
           display_order = coalesce($13, display_order),
           search_keywords = coalesce($14, search_keywords),
           updated_at = now()
       where id = $1 and organization_id = $2
       returning id;`,
      [
        productId,
        organizationId,
        patch.categoryId !== undefined,
        patch.categoryId ?? null,
        patch.name ?? null,
        patch.description !== undefined,
        patch.description ?? null,
        patch.imageUrl !== undefined,
        patch.imageUrl ?? null,
        patch.price ?? null,
        patch.isPopular ?? null,
        patch.isAvailable ?? null,
        patch.displayOrder ?? null,
        patch.searchKeywords ? [...patch.searchKeywords] : null,
      ],
    );
    if (!rows[0]) return null;
    return this.findProduct(organizationId, rows[0].id);
  }

  // ---- Fase 11 — promociones/marketing (ver promotions.ts, migrations/010) ----

  async listPromotions(organizationId: string): Promise<readonly Promotion[]> {
    const { rows } = await this.db.query<PromotionRow>(
      `select ${PROMOTION_COLUMNS} from restaurantes.promotions where organization_id = $1 order by created_at desc;`,
      [organizationId],
    );
    return rows.map(mapPromotion);
  }

  async findPromotion(organizationId: string, promotionId: string): Promise<Promotion | null> {
    const { rows } = await this.db.query<PromotionRow>(`select ${PROMOTION_COLUMNS} from restaurantes.promotions where organization_id = $1 and id = $2;`, [organizationId, promotionId]);
    return rows[0] ? mapPromotion(rows[0]) : null;
  }

  async findPromotionByCode(organizationId: string, code: string): Promise<Promotion | null> {
    const { rows } = await this.db.query<PromotionRow>(`select ${PROMOTION_COLUMNS} from restaurantes.promotions where organization_id = $1 and code = $2;`, [organizationId, code]);
    return rows[0] ? mapPromotion(rows[0]) : null;
  }

  async createPromotion(organizationId: string, input: NewPromotionInput): Promise<Promotion> {
    const { rows } = await this.db.query<PromotionRow>(
      `insert into restaurantes.promotions
         (organization_id, code, name, description, type, value, min_order_total, starts_at, ends_at, days_of_week, start_time, end_time, max_uses, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::smallint[], $11::time, $12::time, $13, $14)
       returning ${PROMOTION_COLUMNS};`,
      [
        organizationId,
        input.code,
        input.name,
        input.description ?? null,
        input.type,
        input.value,
        input.minOrderTotal ?? null,
        input.startsAt ?? null,
        input.endsAt ?? null,
        input.daysOfWeek ? [...input.daysOfWeek] : null,
        input.startTime ?? null,
        input.endTime ?? null,
        input.maxUses ?? null,
        input.isActive ?? true,
      ],
    );
    return mapPromotion(rows[0]!);
  }

  async updatePromotion(organizationId: string, promotionId: string, patch: PromotionPatch): Promise<Promotion | null> {
    const { rows } = await this.db.query<PromotionRow>(
      `update restaurantes.promotions
       set code = coalesce($3, code),
           name = coalesce($4, name),
           description = case when $5::boolean then $6 else description end,
           type = coalesce($7, type),
           value = coalesce($8, value),
           min_order_total = case when $9::boolean then $10 else min_order_total end,
           starts_at = case when $11::boolean then $12::timestamptz else starts_at end,
           ends_at = case when $13::boolean then $14::timestamptz else ends_at end,
           days_of_week = case when $15::boolean then $16::smallint[] else days_of_week end,
           start_time = case when $17::boolean then $18::time else start_time end,
           end_time = case when $19::boolean then $20::time else end_time end,
           max_uses = case when $21::boolean then $22 else max_uses end,
           is_active = coalesce($23, is_active),
           updated_at = now()
       where id = $1 and organization_id = $2
       returning ${PROMOTION_COLUMNS};`,
      [
        promotionId,
        organizationId,
        patch.code ?? null,
        patch.name ?? null,
        patch.description !== undefined,
        patch.description ?? null,
        patch.type ?? null,
        patch.value ?? null,
        patch.minOrderTotal !== undefined,
        patch.minOrderTotal ?? null,
        patch.startsAt !== undefined,
        patch.startsAt ?? null,
        patch.endsAt !== undefined,
        patch.endsAt ?? null,
        patch.daysOfWeek !== undefined,
        patch.daysOfWeek ? [...patch.daysOfWeek] : null,
        patch.startTime !== undefined,
        patch.startTime ?? null,
        patch.endTime !== undefined,
        patch.endTime ?? null,
        patch.maxUses !== undefined,
        patch.maxUses ?? null,
        patch.isActive ?? null,
      ],
    );
    return rows[0] ? mapPromotion(rows[0]) : null;
  }

  /** `restaurantes.increment_promotion_uses` (ver migrations/010) es SECURITY
   * DEFINER — mismo patrón exacto que `create_order_idempotent` (migrations/003):
   * el UPDATE atómico re-verifica `is_active`/`max_uses` server-side, así dos
   * pedidos casi-simultáneos con el mismo código nunca lo rebasan, sin depender de
   * que el caller haya validado en memoria un momento antes. */
  async incrementPromotionUses(organizationId: string, promotionId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ increment_promotion_uses: PromotionRow | null }>(
      `select restaurantes.increment_promotion_uses($1, $2) as increment_promotion_uses;`,
      [organizationId, promotionId],
    );
    return rows[0]?.increment_promotion_uses != null;
  }

  async getBranchProductState(propertyId: string, productId: string): Promise<BranchProductState | null> {
    const { rows } = await this.db.query<BranchProductRow>(`select property_id, product_id, price, is_available from restaurantes.branch_products where property_id = $1 and product_id = $2;`, [
      propertyId,
      productId,
    ]);
    return rows[0] ? mapBranchProductState(rows[0]) : null;
  }

  async upsertBranchProductState(propertyId: string, productId: string, price: number, isAvailable: boolean): Promise<BranchProductState> {
    const { rows } = await this.db.query<BranchProductRow>(
      `insert into restaurantes.branch_products (property_id, product_id, price, is_available)
       values ($1, $2, $3, $4)
       on conflict (property_id, product_id) do update set price = excluded.price, is_available = excluded.is_available, updated_at = now()
       returning property_id, product_id, price, is_available;`,
      [propertyId, productId, price, isAvailable],
    );
    return mapBranchProductState(rows[0]!);
  }

  async findOrderById(organizationId: string, orderId: string): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `select ${ORDER_COLUMNS}
       from restaurantes.orders where id = $1 and organization_id = $2;`,
      [orderId, organizationId],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async listOrders(organizationId: string, filter: OrderListFilter): Promise<OrderListPage> {
    const conditions: string[] = [`organization_id = $1`];
    const params: unknown[] = [organizationId];

    if (filter.propertyIds !== null) {
      params.push([...filter.propertyIds]);
      conditions.push(`property_id = any($${params.length}::uuid[])`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.dateFrom !== undefined) {
      params.push(filter.dateFrom.toISOString());
      conditions.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (filter.dateTo !== undefined) {
      params.push(filter.dateTo.toISOString());
      conditions.push(`created_at < $${params.length}::timestamptz`);
    }

    const cursor = decodeCursor(filter.cursor);
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }

    params.push(filter.limit + 1);
    const { rows } = await this.db.query<OrderRow>(
      `select ${ORDER_COLUMNS}
       from restaurantes.orders
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${params.length};`,
      params,
    );

    const hasMore = rows.length > filter.limit;
    const page = rows.slice(0, filter.limit).map(mapOrder);
    const nextCursor = hasMore ? encodeCursor(page[page.length - 1]!) : null;
    return { orders: page, nextCursor };
  }

  async updateOrderStatus(organizationId: string, orderId: string, status: OrderStatus): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `update restaurantes.orders
       set status = $3, delivered_at = case when $3 = 'entregado' then now() else delivered_at end
       where id = $1 and organization_id = $2
       returning ${ORDER_COLUMNS};`,
      [orderId, organizationId, status],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  // ---- Fase 8 — superficie real del rol "repartidor" (ver repository.ts para el
  // contrato completo de cada método). ----

  async assignRepartidorToOrder(organizationId: string, orderId: string, repartidorId: string, estimatedDeliveryAt: string | null): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `update restaurantes.orders
       set assigned_repartidor_id = $3, estimated_delivery_at = $4
       where id = $1 and organization_id = $2
       returning ${ORDER_COLUMNS};`,
      [orderId, organizationId, repartidorId, estimatedDeliveryAt],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async listOrdersForRepartidor(organizationId: string, repartidorId: string): Promise<readonly Order[]> {
    const { rows } = await this.db.query<OrderRow>(
      `select ${ORDER_COLUMNS}
       from restaurantes.orders
       where organization_id = $1 and assigned_repartidor_id = $2
       order by created_at desc
       limit 200;`,
      [organizationId, repartidorId],
    );
    return rows.map(mapOrder);
  }

  async findAssignedOrderById(organizationId: string, repartidorId: string, orderId: string): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `select ${ORDER_COLUMNS}
       from restaurantes.orders
       where id = $1 and organization_id = $2 and assigned_repartidor_id = $3;`,
      [orderId, organizationId, repartidorId],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async updateAssignedOrderStatus(organizationId: string, repartidorId: string, orderId: string, status: OrderStatus, incidentNote: string | null): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `update restaurantes.orders
       set status = $4,
           delivered_at = case when $4 = 'entregado' then now() else delivered_at end,
           incident_note = case when $4 = 'problema' then $5 else incident_note end
       where id = $1 and organization_id = $2 and assigned_repartidor_id = $3
       returning ${ORDER_COLUMNS};`,
      [orderId, organizationId, repartidorId, status, incidentNote],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async findCustomerById(organizationId: string, customerId: string): Promise<Customer | null> {
    const { rows } = await this.db.query<CustomerRow>(
      `select id, organization_id, phone, name, order_count from restaurantes.customers where organization_id = $1 and id = $2;`,
      [organizationId, customerId],
    );
    return rows[0] ? mapCustomer(rows[0]) : null;
  }

  async listCustomers(organizationId: string, filter: CustomerListFilter): Promise<CustomerListPage> {
    const conditions: string[] = [`organization_id = $1`];
    const params: unknown[] = [organizationId];

    const search = filter.search?.trim();
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(name ilike $${params.length} or phone ilike $${params.length})`);
    }
    if (filter.cursor) {
      params.push(filter.cursor);
      conditions.push(`id > $${params.length}`);
    }

    params.push(filter.limit + 1);
    const { rows } = await this.db.query<CustomerRow>(
      `select id, organization_id, phone, name, order_count from restaurantes.customers
       where ${conditions.join(" and ")}
       order by id asc
       limit $${params.length};`,
      params,
    );

    const hasMore = rows.length > filter.limit;
    const page = rows.slice(0, filter.limit).map(mapCustomer);
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;
    return { customers: page, nextCursor };
  }
}

interface OrderCursorBoundary {
  readonly createdAt: string;
  readonly id: string;
}

function encodeCursor(order: Order): string {
  return Buffer.from(`${order.createdAt}|${order.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): OrderCursorBoundary | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separatorIndex = decoded.lastIndexOf("|");
    if (separatorIndex === -1) return null;
    return { createdAt: decoded.slice(0, separatorIndex), id: decoded.slice(separatorIndex + 1) };
  } catch {
    return null;
  }
}
