// Puerto de acceso a datos de domain-restaurantes — mismo patrón dual de adaptador
// que ya usa @atiende/core-conversation (InMemoryStateStore/PostgresStateStore
// implementando el mismo StateStore): un puerto TS explícito, con un adaptador real
// en memoria (tests determinísticos, sin depender de que packages/db tenga ya un
// motor de conexión) y un adaptador real de Postgres (sobre TenantDbSession, contra
// las migraciones de migrations/001-004). Ninguna función de negocio de
// customers.ts/orders.ts/whatsapp/* toca SQL directamente — todas pasan por aquí,
// así que el mismo código de negocio corre igual en tests y en producción.
import type { Branch, BranchSummary, CallbackRequest, CallbackRequestInput, Customer, CustomerAddress, CustomerTier, NearestBranchMatch, Order, PersistedOrderItem } from "./types.ts";

export interface SearchableProduct {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly categoryName: string | null;
  readonly searchKeywords: readonly string[];
  readonly price: number;
  readonly isAvailable: boolean;
}

export interface NewOrderRecord {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly customerId: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress: string | null;
  readonly branch: string | null;
  readonly total: number;
  readonly items: readonly PersistedOrderItem[];
  readonly source: "web" | "voice" | "whatsapp" | "admin";
  readonly notes: string | null;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
  readonly callTranscript: string | null;
  readonly callRecordingUrl: string | null;
}

export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

// ---- KPIs de admin (Fase 3, ver diseño §2) ----

/** Un tramo de fecha [start, end) — mismo shape que usa kpis.ts para pedir agregados
 * por tramo (tendencia) o por ventana única (periodo actual/anterior de comparación),
 * en una sola llamada al repositorio (ver comentario en kpis.ts sobre por qué se piden
 * juntos: evita N round-trips, mismo patrón que `orders_bucketed_stats` del origen). */
export interface KpiDateRange {
  readonly start: Date;
  readonly end: Date;
}

export interface SalesBucketRow {
  readonly revenue: number;
  readonly orderCount: number;
  /** Clientes ÚNICOS por `customer_name` dentro del tramo — mismo criterio (no
   * `customer_id`) que `orders_bucketed_stats` del origen, preservado literal porque
   * pedidos sin cliente vinculado (customer_id null) siguen contando por nombre. */
  readonly customerCount: number;
}

export interface ChannelStatsRow {
  readonly totalOrders: number;
  readonly totalRevenue: number;
  readonly voice: { readonly orders: number; readonly completed: number; readonly cancelled: number; readonly revenue: number };
  readonly whatsapp: { readonly orders: number; readonly completed: number; readonly cancelled: number; readonly revenue: number };
}

export interface WhatsAppConversationStatsRow {
  readonly total: number;
  readonly withOrder: number;
  /** 0 cuando `total` es 0 (mismo `coalesce(avg(...), 0)` que el origen — cero
   * conversaciones es un cero real, no un "sin datos"). */
  readonly averageMessages: number;
}

export interface TopCustomerRow {
  readonly id: string;
  readonly name: string | null;
  readonly phone: string;
  readonly orderCount: number;
}

export interface CustomerOverviewRow {
  readonly totalCustomers: number;
  /** null cuando la organización no tiene NINGÚN pedido todavía — nunca un $0
   * fingido (ver diseño §2: "cualquier métrica no calculable responde null"). */
  readonly averageOrderValue: number | null;
  readonly customersWithOrders: number;
  readonly recurringCustomers: number;
  readonly topCustomer: TopCustomerRow | null;
  readonly avgDaysSinceLastOrder: number | null;
}

export type TierDistributionMetric = "gasto" | "frecuencia" | "sin_datos";

export interface TierDistributionRow {
  readonly metric: TierDistributionMetric;
  readonly black: number;
  readonly platinum: number;
  readonly gold: number;
  readonly blue: number;
  readonly withoutTier: number;
}

export interface RestaurantesRepository {
  findOrganizationBySlug(slug: string): Promise<{ id: string; slug: string; name: string } | null>;
  findBranch(organizationId: string, selector: { slug?: string; name?: string }): Promise<Branch | null>;
  /** Bloque dinámico "SUCURSALES REALES" del prompt de WhatsApp (Fase 2,
   * generalización obligatoria por multi-tenancy — ver diseño §2.2): nombre,
   * slug y dirección de cada sucursal activa, nunca hardcodeado en texto fijo. */
  listBranchesForOrganization(organizationId: string): Promise<readonly BranchSummary[]>;
  /** buscar_sucursal_cercana real (Fase 2, §1.1.1): empareja la colonia/zona
   * contra `restaurantes.known_zone` de ESTA organización (normalizando
   * acentos/espacios/puntuación de ambos lados, fix real del 4-sep-2026) y
   * calcula distancia Haversine real contra las sucursales activas con
   * lat/lng. null si ninguna zona conocida matchea — nunca se inventa/adivina
   * una sucursal ante un cero-match. */
  findNearestBranchByColonia(organizationId: string, colonia: string): Promise<NearestBranchMatch | null>;
  /** Catálogo disponible de la sucursal, con los campos necesarios tanto para
   * búsqueda de texto (searchProducts) como para resolución/cotización de renglones
   * de pedido (resolveOrderItemsAgainstProducts + buildOrderQuoteFromProducts). */
  listAvailableProductsForBranch(propertyId: string): Promise<readonly SearchableProduct[]>;

  findCustomerByPhone(organizationId: string, phone: string): Promise<Customer | null>;
  /** Insert-or-update race-safe: nunca sobreescribe un nombre ya conocido con uno
   * posiblemente mal escuchado (mismo comportamiento que upsertCustomer del origen,
   * incluida la recuperación de la carrera de INSERT concurrente real, UNIQUE
   * (organization_id, phone)). */
  upsertCustomer(organizationId: string, phone: string, name: string): Promise<Customer>;
  addCustomerAddressIfNew(customerId: string, address: string): Promise<void>;
  listCustomerAddresses(customerId: string): Promise<readonly CustomerAddress[]>;
  /** Historial de pedidos ELEGIBLES para memoria/recomendación (pending/preparando/
   * en_camino/entregado/completado — nunca cancelado/problema), orden desc. */
  listEligibleOrderHistory(customerId: string): Promise<ReadonlyArray<{ items: readonly PersistedOrderItem[]; createdAt: string }>>;
  calcCustomerTier(organizationId: string, customerId: string): Promise<CustomerTier | null>;

  /** Equivalente a create_order_idempotent: dos niveles de idempotencia
   * (idempotencyKey explícito y dedupeFingerprint automático de 5 min sobre pedidos
   * `pending`), serializados — nunca dos filas reales por una sola intención real de
   * pedido. */
  createOrderIdempotent(order: NewOrderRecord, dedupeFingerprint: string, idempotencyKey: string | null): Promise<Order>;

  createCallbackRequest(input: CallbackRequestInput): Promise<CallbackRequest>;

  consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean>;

  resolveOrganizationByPhoneNumberId(phoneNumberId: string): Promise<string | null>;
  claimWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string): Promise<boolean>;
  claimWhatsAppConversation(organizationId: string, phoneHash: string, messageId: string, leaseSeconds: number): Promise<boolean>;
  appendWhatsAppUserMessageOnce(organizationId: string, phone: string, message: ConversationMessage): Promise<readonly ConversationMessage[]>;
  whatsappAppendTurn(
    organizationId: string,
    phone: string,
    newMessages: readonly ConversationMessage[],
    status: "active" | "completed" | "abandoned" | null,
    orderId: string | null,
    propertyId: string | null,
  ): Promise<readonly ConversationMessage[]>;
  finishWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string, status: "processed" | "failed", errorClass: string | null): Promise<void>;
  markInboundEventFailed(organizationId: string, messageId: string, errorClass: string): Promise<void>;

  // ---- KPIs de admin (Fase 3 — ver diseño §2, únicas rutas de staff autenticado de
  // este vertical hasta ahora). `propertyIds`: null = sin restricción (agrega TODA la
  // organización — owner/admin con membership org-wide); un arreglo acota la consulta a
  // esas properties exactas — nunca a toda la organización — para no filtrar datos de
  // sucursales fuera del alcance real de la membership del caller (ver
  // apps/api/src/routes/verticals/restaurantes/admin-kpis.ts, que resuelve ese
  // alcance vía @atiende/db::CoreRepository.findMembershipsByUserId, nunca confiando en
  // el claim del JWT). `buckets` se piden TODOS en una sola llamada (tramos de
  // tendencia + ventana actual + ventana previa de comparación) — mismo motivo que
  // `orders_bucketed_stats` del origen: evita N round-trips y agrega en Postgres en vez
  // de bajar cada pedido al llamador.
  getSalesBucketedStats(organizationId: string, propertyIds: readonly string[] | null, buckets: readonly KpiDateRange[]): Promise<readonly SalesBucketRow[]>;
  /** `created_at` del primer pedido real de la organización (acotado al mismo alcance
   * de properties que el resto de KPIs de ventas) — MIN(created_at) directo en
   * Postgres, nunca bajando pedidos para calcularlo. Alimenta la granularidad
   * adaptativa de 'historico' en buildTrendBuckets (kpis.ts) — null si la organización
   * (o el alcance filtrado) todavía no tiene ningún pedido. */
  getFirstOrderCreatedAt(organizationId: string, propertyIds: readonly string[] | null): Promise<Date | null>;
  getChannelStats(organizationId: string, propertyIds: readonly string[] | null): Promise<ChannelStatsRow>;
  getWhatsappConversationStats(organizationId: string, propertyIds: readonly string[] | null): Promise<WhatsAppConversationStatsRow>;
  /** Sin `propertyIds`: la memoria de cliente es por-organización, nunca por-sucursal
   * (mismo criterio que `customers`/`calc_customer_tier` — ver diseño §2, la lista de
   * métodos del repositorio omite `propertyIds` aquí a propósito). */
  getCustomerOverviewKpis(organizationId: string): Promise<CustomerOverviewRow>;
  getCustomerTierDistribution(organizationId: string): Promise<TierDistributionRow>;
}
