// Puerto de acceso a datos de domain-restaurantes — mismo patrón dual de adaptador
// que ya usa @atiende/core-conversation (InMemoryStateStore/PostgresStateStore
// implementando el mismo StateStore): un puerto TS explícito, con un adaptador real
// en memoria (tests determinísticos, sin depender de que packages/db tenga ya un
// motor de conexión) y un adaptador real de Postgres (sobre TenantDbSession, contra
// las migraciones de migrations/001-004). Ninguna función de negocio de
// customers.ts/orders.ts/whatsapp/* toca SQL directamente — todas pasan por aquí,
// así que el mismo código de negocio corre igual en tests y en producción.
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
  /** Fase de correo — ver migrations/011_email_outbox_dispatch.sql: solo el
   * canal `web` lo captura hoy (validateCreateOrderPayload en orders.ts); voz/
   * WhatsApp siguen sin capturarlo, `null` en ese caso, sin que eso rompa nada
   * (el correo de confirmación simplemente no se encola, ver
   * order-notifications.ts::notifyCustomerOrderConfirmationEmailCore). */
  readonly customerEmail: string | null;
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

  // ---- Dispatcher real de messaging_outbox (migrations/007) — restaurantes NO
  // tenía NINGÚN concepto de outbox antes de este cambio (a diferencia de citas,
  // que ya lo tenía desde su Fase 1): `outcome.reply` del turn handler de
  // WhatsApp solo se guardaba en `whatsapp_conversations.messages`, nunca se
  // encolaba para envío real (ver @atiende/whatsapp-gateway/README.md). ----
  enqueueMessagingOutbox(organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void>;
  claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]>;
  markMessagingOutboxSent(id: string): Promise<void>;
  markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void>;
  markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void>;
  // ---- Dispatcher real de correo (migrations/011_email_outbox_dispatch.sql) —
  // acotado a channel='email', ver EmailOutboxJobRow arriba. ----
  claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]>;
  completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void>;
  /** Único `phone_number_id` real conectado de la organización (ver
   * `restaurantes.whatsapp_channel_config`, migrations/001) — a diferencia de
   * `resolveOrganizationByPhoneNumberId` (arriba, la ruta INVERSA que usa el webhook
   * de Meta para rutear un mensaje ENTRANTE al tenant dueño), este es el sentido
   * SALIENTE: qué número usar para escribirle al CLIENTE fuera de una conversación
   * entrante (ver order-notifications.ts). `null` cuando la organización nunca
   * conectó WhatsApp — el caller debe tratarlo como "sin este canal disponible",
   * nunca lanzar. */
  resolveActiveWhatsAppPhoneNumberId(organizationId: string): Promise<string | null>;

  // ---- Fase 9 — bandeja de notificaciones internas al staff (ver
  // order-notifications.ts, migrations/009_order_notifications.sql): sin push real
  // disponible en este monorepo, se persiste como registro consultable/reconocible
  // por POLLING del panel admin — mismo criterio "honesto" que
  // `@atiende/domain-licitaciones::tender_change_notification`, nunca finge un canal
  // de envío que no existe. `createStaffOrderNotification` es idempotente por
  // (organizationId, orderId, eventType) — un reintento real del mismo evento nunca
  // duplica la fila. ----
  createStaffOrderNotification(organizationId: string, propertyId: string, orderId: string, eventType: StaffOrderNotificationEventType, message: string): Promise<StaffOrderNotificationRecord>;
  /** Más reciente primero. `propertyIds` null = organización completa (mismo
   * contrato que el resto de rutas admin de este vertical, ver admin-scope.ts). */
  listStaffOrderNotifications(organizationId: string, propertyIds: readonly string[] | null, options?: { readonly unacknowledgedOnly?: boolean; readonly limit?: number }): Promise<readonly StaffOrderNotificationRecord[]>;
  acknowledgeStaffOrderNotification(organizationId: string, notificationId: string, actorId: string): Promise<StaffOrderNotificationRecord>;

  // ---- Fase 5 — back-office CORE (ver diseño §1) ----

  /** Sucursal completa (activa o inactiva) por id — a diferencia de `findBranch`
   * (busca por slug/name, solo usado hoy por el flujo de pedido/agente), esta es
   * la que necesita la ficha de edición del panel: nunca oculta una sucursal
   * inactiva (el staff SÍ necesita poder verla/reactivarla). */
  findBranchById(organizationId: string, propertyId: string): Promise<Branch | null>;
  /** Todas las sucursales de la organización (activas e inactivas) para el listado
   * de administración — a diferencia de `listBranchesForOrganization` (solo
   * activas, para el bloque del prompt del agente). */
  listBranchesForOrganizationAdmin(organizationId: string): Promise<readonly Branch[]>;
  /** Edita SOLO los campos que vive `restaurantes.branch_detail` (teléfono/
   * dirección/coordenadas/slug/orden) — `core.property.status`/`name` no son
   * editables por staff todavía: ese esquema es compartido por TODAS las
   * verticales y hoy solo `service_role` tiene GRANT de escritura sobre él (ver
   * migrations/007, comentario de cabecera). Activar/desactivar una sucursal o
   * crear una nueva requeriría un cambio de política a nivel de `core`, fuera de
   * alcance de esta fase de un solo vertical. */
  updateBranchDetail(
    organizationId: string,
    propertyId: string,
    patch: { readonly phone?: string | null; readonly address?: string | null; readonly lat?: number | null; readonly lng?: number | null; readonly slug?: string; readonly displayOrder?: number },
  ): Promise<Branch | null>;

  listCategories(organizationId: string): Promise<readonly Category[]>;
  createCategory(organizationId: string, input: NewCategoryInput): Promise<Category>;
  updateCategory(organizationId: string, categoryId: string, patch: CategoryPatch): Promise<Category | null>;

  /** Catálogo completo organization-wide (todos los productos, disponibles o no) —
   * para el listado de administración. `listAvailableProductsForBranch` (arriba)
   * sigue siendo la única fuente que consulta el flujo real de pedido/agente. */
  listProducts(organizationId: string): Promise<readonly Product[]>;
  findProduct(organizationId: string, productId: string): Promise<Product | null>;
  createProduct(organizationId: string, input: NewProductInput): Promise<Product>;
  updateProduct(organizationId: string, productId: string, patch: ProductPatch): Promise<Product | null>;

  /** Precio/disponibilidad de un producto en una sucursal específica — `null`
   * cuando el producto nunca se dio de alta ahí. */
  getBranchProductState(propertyId: string, productId: string): Promise<BranchProductState | null>;
  /** Alta/edición real de precio/disponibilidad en `branch_products` — la ÚNICA
   * forma de que un producto aparezca (o deje de aparecer) en
   * `listAvailableProductsForBranch`, y por tanto en búsqueda/cotización real. */
  upsertBranchProductState(propertyId: string, productId: string, price: number, isAvailable: boolean): Promise<BranchProductState>;

  findOrderById(organizationId: string, orderId: string): Promise<Order | null>;
  /** Sirve tanto "pedidos en operación" (filtro por status, sin rango de fechas)
   * como "historial de órdenes" (rango de fechas + paginación) — mismos datos,
   * mismo filtro compuesto, ver diseño §1.3/§1.4: fragmentarlo en dos endpoints
   * solo duplicaría la misma query. */
  listOrders(organizationId: string, filter: OrderListFilter): Promise<OrderListPage>;
  /** Persiste el nuevo estado (y `delivered_at` cuando aplica) — la validación de
   * QUÉ transición es válida vive en el dominio (order-lifecycle.ts), nunca aquí:
   * este método nunca decide reglas de negocio, solo persiste lo que ya se decidió
   * válido. Fix hallazgo auditoría (rubro 3, "máquina de estados de pedidos sin
   * guarda TOCTOU") — el UPDATE SÍ debe reconfirmar `fromStatus` en su propio WHERE,
   * nunca solo id/organización: sin esa guarda, dos requests concurrentes que
   * leyeron el MISMO estado viejo (p.ej. las dos vieron "pending") pueden aplicar
   * dos transiciones incompatibles una tras otra sin que la segunda se entere de
   * que el estado ya cambió (time-of-check-to-time-of-use) — para cuando ese UPDATE
   * corre, la validación de `order-lifecycle.ts` ya evaluó una lectura obsoleta.
   * `null` cuando el pedido no existe/no es de esta organización O cuando su estado
   * real ya NO es `fromStatus` (alguien más lo cambió primero) — el dominio
   * distingue ambos casos con un `findOrderById` de más SOLO en ese camino de
   * error, nunca en el camino feliz. */
  updateOrderStatus(organizationId: string, orderId: string, fromStatus: OrderStatus, toStatus: OrderStatus): Promise<Order | null>;

  findCustomerById(organizationId: string, customerId: string): Promise<Customer | null>;
  listCustomers(organizationId: string, filter: CustomerListFilter): Promise<CustomerListPage>;

  // ---- Fase 8 — superficie real del rol "repartidor" (ver diseño, domain-restaurantes/
  // src/roles.ts::REPARTIDOR_ROLES). Todos estos métodos acotan la consulta a
  // `assigned_repartidor_id` — nunca a la organización completa como MANAGER_ROLES — ver
  // migrations/008_repartidor_order_assignment.sql. ----

  /** Dispatch real (MANAGER_ROLES, ver admin-orders.ts): asigna un repartidor a un pedido
   * y captura `estimated_delivery_at` (ambos escritos por el mismo staff que despacha,
   * nunca por el repartidor). `repartidorId` se valida ANTES de llamar aquí (es
   * `core.staff_user.id` con membership vertical_role='repartidor' de esta organización —
   * ver admin-orders.ts, nunca confiado a ciegas). null en `orderId` inexistente/fuera de
   * la organización, igual que `updateOrderStatus`. */
  assignRepartidorToOrder(organizationId: string, orderId: string, repartidorId: string, estimatedDeliveryAt: string | null): Promise<Order | null>;
  /** Pedidos asignados a ESTE repartidor, más recientes primero — nunca los de otro
   * repartidor ni el resto de la organización. Sin paginación por cursor a propósito: el
   * origen (RepartidorDashboard.tsx) nunca pagina esta lista (es inherentemente pequeña,
   * lo asignado a una sola persona); un límite fijo generoso evita igual un fetch
   * accidentalmente ilimitado. */
  listOrdersForRepartidor(organizationId: string, repartidorId: string): Promise<readonly Order[]>;
  /** Ficha de un pedido — null si no existe, no es de esta organización, O no está
   * asignado a ESTE repartidor (un repartidor NUNCA puede leer el pedido de otro,
   * a diferencia de `findOrderById`, que solo acota por organización/property). */
  findAssignedOrderById(organizationId: string, repartidorId: string, orderId: string): Promise<Order | null>;
  /** Persiste la transición + `incident_note` (la validación de cuál es válida vive en
   * `order-lifecycle.ts::changeAssignedOrderStatus`, nunca aquí). El UPDATE real SIEMPRE
   * acota por `assigned_repartidor_id = repartidorId` (defensa en profundidad, igual que
   * `update_assigned_order_status()` del origen) Y por `status = fromStatus` (mismo fix
   * TOCTOU que `updateOrderStatus`, ver ese comentario) — null si el pedido no existe, no
   * es de esta organización, ya no está asignado a este repartidor, O su estado real ya
   * no es `fromStatus`. */
  updateAssignedOrderStatus(organizationId: string, repartidorId: string, orderId: string, fromStatus: OrderStatus, toStatus: OrderStatus, incidentNote: string | null): Promise<Order | null>;

  // ---- Fase 11 — promociones/marketing (ver promotions.ts, migrations/010). CRUD
  // real de admin + resolución por código para la aplicación real al total de un
  // pedido (ver orders.ts::prepareCreateOrder). ----

  /** Listado de administración — activas e inactivas, más reciente primero (mismo
   * criterio que `listStaffOrderNotifications`: el staff necesita ver también lo
   * desactivado para poder reactivarlo). */
  listPromotions(organizationId: string): Promise<readonly Promotion[]>;
  findPromotion(organizationId: string, promotionId: string): Promise<Promotion | null>;
  /** Resolución por código para la aplicación real a un pedido (orders.ts) — el
   * código YA viene normalizado (mayúsculas, ver promotions.ts::normalizePromotionCode)
   * por el caller. `null` cuando el código no existe EN ESTA organización, sin
   * filtrar por `isActive`/vigencia aquí — esa validación real vive en
   * `promotions.ts::assertPromotionApplicable`, nunca en el repositorio (mismo
   * principio que `updateOrderStatus`: el repositorio solo resuelve datos, nunca
   * decide reglas de negocio). */
  findPromotionByCode(organizationId: string, code: string): Promise<Promotion | null>;
  createPromotion(organizationId: string, input: NewPromotionInput): Promise<Promotion>;
  updatePromotion(organizationId: string, promotionId: string, patch: PromotionPatch): Promise<Promotion | null>;
  /** Incrementa `times_used` de forma atómica DESPUÉS de un pedido creado con éxito
   * — re-verifica `is_active`/`max_uses` en el propio UPDATE (nunca confía en la
   * validación ya hecha en memoria minutos/segundos antes), así dos pedidos casi-
   * simultáneos con el mismo código nunca exceden `max_uses`. Devuelve `false` si
   * la promoción ya no calificaba en el momento exacto del incremento (perdió la
   * carrera o fue desactivada entretanto) — el pedido YA se creó de todos modos,
   * igual que el resto de efectos secundarios best-effort de `createOrder`. */
  incrementPromotionUses(organizationId: string, promotionId: string): Promise<boolean>;
}

/** Fila de `restaurantes.messaging_outbox` reclamada para despacho real — mismo
 * shape que `@atiende/domain-citas::MessagingOutboxRow` (ver
 * @atiende/whatsapp-gateway::MessagingOutboxPort). */
export interface MessagingOutboxRow {
  readonly id: string;
  readonly attempts: number;
  readonly payload: unknown;
}

// ============================================================================
// Fase de correo — dispatcher de correo (ver email-dispatch.ts). Acotado a
// channel='email' de `restaurantes.messaging_outbox` — nunca toca una fila
// channel='whatsapp' (ese dispatcher es `claimMessagingOutboxBatch` de arriba,
// consumido por @atiende/whatsapp-gateway). Mismo shape/patrón exacto que
// @atiende/domain-citas::EmailOutboxJobRow.
// ============================================================================

export interface EmailOutboxJobRow {
  readonly id: string;
  readonly organizationId: string;
  readonly attempts: number;
  readonly payload: Record<string, unknown>;
}

/** Los 3 eventos reales que dispara `order-notifications.ts` — mismo CHECK que
 * `restaurantes.staff_order_notification.event_type` (migrations/009). */
export type StaffOrderNotificationEventType = "order.created" | "order.problema" | "order.assigned_repartidor";

/** Fila de `restaurantes.staff_order_notification` — bandeja interna consultable
 * por polling (ver comentario de `createStaffOrderNotification` arriba). Mismo
 * criterio "honesto, sin canal de envío real" que
 * `@atiende/domain-licitaciones::TenderChangeNotificationRecord`. */
export interface StaffOrderNotificationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderId: string;
  readonly eventType: StaffOrderNotificationEventType;
  readonly message: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
}
