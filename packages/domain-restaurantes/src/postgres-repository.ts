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
import type { Branch, BranchSummary, CallbackRequest, CallbackRequestInput, Customer, CustomerAddress, CustomerTier, NearestBranchMatch, Order, PersistedOrderItem } from "./types.ts";
import type {
  ChannelStatsRow,
  ConversationMessage,
  CustomerOverviewRow,
  KpiDateRange,
  MessagingOutboxRow,
  NewOrderRecord,
  RestaurantesRepository,
  SalesBucketRow,
  SearchableProduct,
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
  };
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
}
