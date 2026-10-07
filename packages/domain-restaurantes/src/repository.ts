// Puerto de acceso a datos de domain-restaurantes — mismo patrón dual de adaptador
// que ya usa @atiende/core-conversation (InMemoryStateStore/RedisLockStore
// implementando cada uno su propio puerto, StateStore/LockStore): un puerto TS
// explícito, con un adaptador real en memoria (tests determinísticos, sin depender
// de que packages/db tenga ya un motor de conexión) y un adaptador real de Postgres
// (sobre TenantDbSession, contra las migraciones de migrations/001-004). Ninguna
// función de negocio de customers.ts/orders.ts/whatsapp/* toca SQL directamente —
// todas pasan por aquí, así que el mismo código de negocio corre igual en tests y
// en producción.
import type { VoiceSecretMatch, VoiceToolAuditInput } from "./types.ts";
import type { ClaveContadorAgente } from "./whatsapp/contadores-agente.ts";
import type { ConocimientoEntrada, ConocimientoLectura, ConocimientoPatch, NuevaConocimientoEntrada } from "./conocimiento/types.ts";
import type { OrderFlowContext, OrderFlowSnapshot, OrderFlowState, OrderFlowWriteResult } from "./agent-tools/order-flow.ts";
import type {
  CustomerAddressChanges,
  CustomerFicha,
  CustomerMemory,
  CustomerPolicy,
  CustomerProfilePatch,
  OrderClosureInput,
  PreferenceAction,
} from "./cliente-360/types.ts";
import type {
  Branch,
  BranchHoursException,
  CanalPedido,
  BranchPolicy,
  WhatsAppAgentConfigAccion,
  WhatsAppAgentConfigHistorialEntry,
  NewBranchHoursExceptionInput,
  OrderPickupInfo,
  OrderScheduleInfo,
  WhatsAppAgentConfigInput,
  WhatsAppAgentConfigRow,
  BranchProductState,
  BranchSummary,
  BranchTimezoneConfig,
  CallbackRequest,
  CallbackRequestInput,
  Category,
  CategoryPatch,
  Customer,
  CustomerAddress,
  CustomerListFilter,
  CarteraKpis,
  CustomerListPage,
  FilaImportacionCliente,
  ResultadoImportacionClientes,
  CustomerTier,
  ColoniasReferenciaLectura,
  KnownZone,
  NearestBranchMatch,
  NewCategoryInput,
  NewKnownZoneInput,
  NoDomicilioMarks,
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
  RegistrarAuditoriaInput,
  RestaurantesAuditLogFiltro,
  RestaurantesAuditLogPagina,
  RestaurantesAuditLogPaginacion,
  WhatsAppChannelResolution,
  WhatsappBranchChannel,
  StorefrontMarca,
  StorefrontMarcaInput,
  WhatsappChannelConfig,
  StorefrontCatalogRow,
  StorefrontTrackingResult,
} from "./types.ts";

export interface SearchableProduct {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly categoryName: string | null;
  readonly searchKeywords: readonly string[];
  readonly price: number;
  readonly isAvailable: boolean;
  /** Producto o categoria marcados "no se vende a domicilio" (migracion 023). */
  readonly noDomicilio?: boolean;
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
  /** Migracion 031: canal, propina y hora prometida de recogida. `create_order_idempotent` viejo
   * ignora estas llaves del jsonb, asi que mandarlas es seguro contra la base sin migrar. */
  readonly canal?: CanalPedido | null;
  readonly propina?: number | null;
  readonly horaRecogida?: string | null;
  /** Migracion 034: hora (ISO 8601) para la que se programo el pedido. Con valor, `create_order_idempotent`
   * lo crea en estado `programado`. El create_order_idempotent VIEJO ignora la llave y lo crearia inmediato:
   * `createOrder` por eso verifica `supportsScheduledOrders()` antes de mandarla. */
  readonly programadoPara?: string | null;
}

export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** Solo en el mensaje del asistente de un turno que dejo un pedido creado: marca el limite entre un pedido y el siguiente
   * (el pin o link de Maps de antes de esa marca ya no pertenece al pedido en curso). Es metadato del historial: no se manda al modelo. */
  readonly pedidoCreado?: true;
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
  /** Clientes ÚNICOS por `customer_id` dentro del tramo (R-30: antes se contaba por
   * nombre, y dos personas con el mismo nombre eran una). `revenue`/`orderCount` ya NO
   * incluyen pedidos cancelados (ventas netas, migración 036). */
  readonly customerCount: number;
}

export interface ChannelStatsRow {
  /** R-30: `true` = las cifras están acotadas al periodo pedido (migración 036); `false` = TODO el
   * histórico (se pidió "histórico", o la base aún no tiene `orders_channel_stats_periodo`). El panel
   * rotula el periodo según este campo, nunca según lo que pidió. */
  readonly acotadoAPeriodo: boolean;
  readonly totalOrders: number;
  /** Ventas SIN pedidos cancelados (los conteos de pedidos sí los incluyen y los reportan en `cancelled`). */
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
  /** R-09: menu publico de la sucursal INCLUYENDO los productos de hoy no disponibles
   * (para mostrarlos como "hoy no hay"). Precio y disponibilidad salen de `branch_products`. */
  listStorefrontCatalog(propertyId: string): Promise<readonly StorefrontCatalogRow[]>;
  /** R-09: lectura publica y acotada de un pedido (migracion 032). Base sin migrar ->
   * `{ disponible: false, pedido: null }` (SAVEPOINT + 42883). Nunca expone datos personales. */
  findStorefrontOrderTracking(organizationId: string, orderId: string): Promise<StorefrontTrackingResult>;

  findCustomerByPhone(organizationId: string, phone: string): Promise<Customer | null>;
  /** Insert-or-update race-safe: nunca sobreescribe un nombre ya conocido con uno
   * posiblemente mal escuchado (mismo comportamiento que upsertCustomer del origen,
   * incluida la recuperación de la carrera de INSERT concurrente real, UNIQUE
   * (organization_id, phone)). */
  upsertCustomer(organizationId: string, phone: string, name: string): Promise<Customer>;
  /** `organizationId` es obligatorio: la escritura real (funcion solo-sistema de la migracion 048) exige que el cliente pertenezca a esa organizacion. */
  addCustomerAddressIfNew(customerId: string, address: string, organizationId: string): Promise<void>;
  listCustomerAddresses(customerId: string): Promise<readonly CustomerAddress[]>;
  /** Historial de pedidos ELEGIBLES para memoria/recomendación (pending/preparando/
   * en_camino/entregado/completado — nunca cancelado/problema), orden desc. */
  listEligibleOrderHistory(customerId: string): Promise<ReadonlyArray<{ items: readonly PersistedOrderItem[]; createdAt: string }>>;
  calcCustomerTier(organizationId: string, customerId: string): Promise<CustomerTier | null>;

  // ---- Cliente 360 (migracion 049, ver cliente-360/) ----
  /** Memoria del cliente por telefono de 10 digitos: domicilios, pedidos anteriores, gustos y reincidencia. `null` = cliente
   * nuevo; `undefined` = la base todavia no la ofrece (migracion 049 sin aplicar): el llamador cae al camino anterior. */
  getCustomerMemory(organizationId: string, phone: string): Promise<CustomerMemory | null | undefined>;
  /** Cierre del ciclo tras crear un pedido (domicilio y gustos). Idempotente por pedido. `undefined` = base sin migrar. */
  registerOrderClosure(input: OrderClosureInput): Promise<{ readonly applied: boolean } | undefined>;
  /** Ficha del cliente para el staff. `null` si no existe en la organizacion. Lanza `ClienteMemoriaNoDisponibleError` sin la 049. */
  getCustomerFicha(organizationId: string, customerId: string): Promise<Omit<CustomerFicha, "tier"> | null>;
  updateCustomerProfile(organizationId: string, customerId: string, patch: CustomerProfilePatch): Promise<void>;
  /** Alta (`addressId` null) o edicion de un domicilio del cliente. Devuelve el id. */
  saveCustomerAddress(organizationId: string, customerId: string, addressId: string | null, changes: CustomerAddressChanges): Promise<string>;
  deleteCustomerAddress(organizationId: string, customerId: string, addressId: string): Promise<boolean>;
  applyCustomerPreferenceAction(
    organizationId: string,
    customerId: string,
    action: PreferenceAction,
    args: { readonly prefId?: string | null; readonly kind?: string | null; readonly value?: string | null },
  ): Promise<string>;
  /** Marca o desmarca un pedido como falso (cuenta para la reincidencia). */
  markOrderFake(organizationId: string, orderId: string, falso: boolean): Promise<boolean>;
  exportCustomerData(organizationId: string, customerId: string): Promise<Record<string, unknown> | null>;
  deleteCustomerMemory(organizationId: string, customerId: string): Promise<{ readonly domiciliosBorrados: number; readonly gustosBorrados: number }>;
  /** Politica de reincidencia; sin la 049 devuelve los valores por omision (2 en 90 dias). */
  getCustomerPolicy(organizationId: string): Promise<CustomerPolicy>;
  saveCustomerPolicy(organizationId: string, policy: CustomerPolicy): Promise<CustomerPolicy>;

  /** Equivalente a create_order_idempotent: dos niveles de idempotencia
   * (idempotencyKey explícito y dedupeFingerprint automático de 5 min sobre pedidos
   * `pending`), serializados — nunca dos filas reales por una sola intención real de
   * pedido. */
  createOrderIdempotent(order: NewOrderRecord, dedupeFingerprint: string, idempotencyKey: string | null): Promise<Order>;

  createCallbackRequest(input: CallbackRequestInput): Promise<CallbackRequest>;

  consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean>;

  resolveOrganizationByPhoneNumberId(phoneNumberId: string): Promise<string | null>;
  /** Contadores DETERMINISTAS del agente por conversacion de WhatsApp ("no entiendo" y "colonia no reconocida" seguidos, migracion 047). Devuelve el
   * contador resultante, o `null` si no hay donde llevarlo (base sin migrar o conversacion inexistente): el llamador degrada, nunca falla. */
  contadorAgenteWhatsApp(organizationId: string, phone: string, clave: ClaveContadorAgente, accion: "incrementar" | "reiniciar"): Promise<number | null>;
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
  /** Re-revisión de PR #158 (r3, blocker) — `executeToolCall` (whatsapp/llm-turn-
   * handler.ts) corre DENTRO de la misma transacción de `withAppSession` que abre el
   * webhook completo (apps/api/src/production/deps.ts) y ya envuelve toda tool call
   * en un `try/catch` que traga CUALQUIER error, incluido un error real de Postgres
   * (una tool contra una función/tabla/columna que la migración pendiente todavía no
   * creó, o cualquier código de negocio como `PT409` de `createOrderIdempotent` sin
   * SAVEPOINT propio). Sin aislar cada tool call, ese error deja ABORTADA la
   * transacción del turno completo: hoy (sin la defensa del motor) el commit final
   * se silencia a un ROLLBACK y el cliente de WhatsApp igual recibe su respuesta;
   * con la defensa (`AbortedTransactionCommitError`, `managed-postgres-engine.ts`)
   * ese mismo commit LANZA, el webhook responde 500 a Meta, Meta reintenta sin tope
   * y cada reintento re-corre el turno LLM completo sin que el cliente reciba
   * respuesta jamás. Mismo patrón/mismo helper que
   * `PostgresCitasRepository.runWithRowSavepoint` (`@atiende/domain-citas`, ver su
   * comentario de cabecera para el diseño completo del helper): aísla el cuerpo de
   * UNA tool call con un SAVEPOINT propio -- si falla, `ROLLBACK TO SAVEPOINT` deja
   * la transacción del turno utilizable de nuevo (el commit final SÍ corre como
   * `COMMIT` real) y el mismo error se repropaga tal cual al `catch` de
   * `executeToolCall`, que ya lo convierte en una respuesta de error normal para el
   * cliente -- nunca enmascara el fallo, solo evita que tumbe el resto del turno.
   * No-op en `InMemoryRestaurantesRepository` (sin transacción real que aislar). */
  runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T>;

  // ---- Voz: secretos por sucursal y bitacora (migracion 026) ----
  /** Busca el secreto presentado (ya hasheado con sha256) entre los secretos vigentes por sucursal de
   * ESTA organizacion (el anterior sigue valido durante la ventana de gracia de una rotacion). */
  verifyVoiceBranchSecret(organizationId: string, secretHash: string): Promise<VoiceSecretMatch>;
  /** Rota el secreto de voz de una sucursal (solo staff owner/admin: lo aplica la funcion SQL). Lanza
   * `RestaurantesConfigUnavailableError` en una base sin migrar. */
  rotateVoiceBranchSecret(organizationId: string, propertyId: string, secretHash: string, secretHint: string, graceSeconds: number): Promise<{ readonly rotatedAt: string }>;
  /** Bitacora de herramientas de voz. Best-effort: nunca lanza ni deja abortada la transaccion. */
  recordVoiceToolAudit(input: VoiceToolAuditInput): Promise<void>;

  // ---- Estado del pedido en el servidor (agent-tools/order-flow.ts, migracion 026) ----
  /** Lee el estado de la maquina de estados del pedido. `null` = no disponible todavia (la
   * base no tiene `restaurantes.order_flow_state`: SQLSTATE 42883/42P01/42703, atrapado con
   * SAVEPOINT) -- el llamador cae al camino anterior (sin exigir cotizacion/confirmacion).
   * Fila inexistente o vencida = `{ state: null, context: null, version: 0 }`. */
  readOrderFlow(organizationId: string, flowKey: string): Promise<OrderFlowSnapshot | null>;
  /** Escritura compare-and-swap por `expectedVersion` (0 = crear). `conflict` = otro proceso
   * escribio primero (no se aplico nada); `unavailable` = base sin migrar. */
  writeOrderFlow(
    organizationId: string,
    flowKey: string,
    expectedVersion: number,
    next: { readonly state: OrderFlowState; readonly context: OrderFlowContext },
    ttlSeconds: number,
  ): Promise<OrderFlowWriteResult>;

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
  /** `range` ausente = todo el histórico. Con `range`, contra la base sin la migración 036 cae (SAVEPOINT) al
   * histórico y lo declara con `acotadoAPeriodo: false`. */
  getChannelStats(organizationId: string, propertyIds: readonly string[] | null, range?: KpiDateRange): Promise<ChannelStatsRow>;
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
  /** `detalle` (wamid y tipo de envio) llega del despachador: con la migracion 066 se guarda para que los `statuses` de Meta encuentren el
   *  mensaje; contra una base sin ella se cierra como siempre, sin wamid. */
  markMessagingOutboxSent(id: string, detalle?: { readonly providerMessageId: string; readonly enviadoComo?: "texto" | "plantilla" | "botones" | "ubicacion" }): Promise<void>;
  /** Avanza el estado de entrega (migracion 066) de un mensaje saliente por su wamid. Solo sesion de sistema (el webhook). Contra una base sin
   *  la migracion NO lanza ni aborta la transaccion: devuelve `resultado: "no_disponible"`. */
  registrarEstadoEntregaWhatsapp(organizationId: string, estado: EstadoEntregaEntrante): Promise<RegistroEstadoEntrega>;
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
   * nunca lanzar. Modelo PM: con `propertyId`, el numero de ESA sucursal tiene prioridad
   * sobre el numero por defecto de la organizacion (migracion 023). */
  resolveActiveWhatsAppPhoneNumberId(organizationId: string, propertyId?: string | null): Promise<string | null>;

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
  /** `propertyIds` (opcional) acota el reconocimiento a las sucursales visibles del staff DENTRO de la propia escritura
   * (QA-restaurantes-R1-features-08: antes se verificaba con un listado de 500 filas, que dejaba fuera las viejas). */
  acknowledgeStaffOrderNotification(organizationId: string, notificationId: string, actorId: string, propertyIds?: readonly string[] | null): Promise<StaffOrderNotificationRecord>;

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
  /** Solo `is_available` de una fila YA existente de `branch_products` (agotado/disponible, PL-23): nunca toca el precio ni da de alta.
   *  `null` cuando el producto no esta dado de alta en esa sucursal. Es lo unico que puede escribir un `staff`. */
  setBranchProductAvailability(propertyId: string, productId: string, isAvailable: boolean): Promise<BranchProductState | null>;

  findOrderById(organizationId: string, orderId: string): Promise<Order | null>;
  /** Pedido MAS RECIENTE (no cancelado) de un telefono (10 digitos, `normalizePhone`) creado desde `sinceIso`, o null. Para "¿ya salio?". */
  findLatestOrderByPhone(organizationId: string, customerPhone: string, sinceIso: string): Promise<Order | null | undefined>;
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
  /** `incidentNote` (opcional): nota libre de la incidencia; solo se guarda cuando `toStatus === "problema"`
   * (columna `incident_note`, migracion 008: no requiere SQL nuevo). */
  updateOrderStatus(organizationId: string, orderId: string, fromStatus: OrderStatus, toStatus: OrderStatus, incidentNote?: string | null): Promise<Order | null>;

  findCustomerById(organizationId: string, customerId: string): Promise<Customer | null>;
  listCustomers(organizationId: string, filter: CustomerListFilter): Promise<CustomerListPage>;
  /** Migracion 054. Sin ella: `{ disponible: false }` (nunca un error). */
  getCarteraKpis(organizationId: string): Promise<CarteraKpis>;
  /**
   * Migracion 054: importa la cartera (filas ya normalizadas, hasta 5,000), upsert por (organizacion, telefono) que NO pisa el nombre ni la nota
   * conocidos, SIN crear pedidos y SIN mandar mensajes. Idempotente por `huella` (sha-256 hex del archivo). Sin la migracion: `{ disponible: false }`.
   */
  importarClientes(organizationId: string, huella: string, filas: readonly FilaImportacionCliente[]): Promise<ResultadoImportacionClientes>;
  /** Nota interna del cliente (migracion 054, columna `notes`); `null` si no hay o la base aun no la tiene. */
  getCustomerNotes(organizationId: string, customerId: string): Promise<string | null>;

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
  /** R-15: pedidos de ESTE repartidor entregados el dia local `fechaLocal` (YYYY-MM-DD) en `zonaHoraria` (IANA), por `delivered_at` (columna de la
   * 001, existe en cualquier base), mas recientes primero, con `deliveredAt` poblado. Tope 200. Nunca los de otro repartidor. */
  listDeliveredOrdersForRepartidor(organizationId: string, repartidorId: string, fechaLocal: string, zonaHoraria: string): Promise<readonly Order[]>;
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
  /** QA R2 features-07: codigo de compensacion («Descuento en el proximo pedido», GRACIAS-XXXXXXXX) que el dueno emitio a ESTE telefono y que
   * sigue vigente y sin usar; `null` si no hay. Solo la sesion de sistema (agentes): el modelo nunca lo dicta. Contra la base sin migrar
   * (funcion de la migracion 077 ausente) devuelve `null` dentro de un SAVEPOINT, nunca aborta la transaccion de la request. */
  findCompensationCode(organizationId: string, phone: string): Promise<string | null>;
  /** Promociones ACTIVAS con `auto_apply` (migracion 031) para aplicarlas sin codigo. `[]` contra la base
   * sin migrar (SAVEPOINT): nunca lanza ni deja la transaccion abortada. */
  listAutoApplyPromotions(organizationId: string): Promise<readonly Promotion[]>;
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

  // ---- FASE 3 (producto) — bitácora de auditoría del staff, ver
  // migrations/019_restaurantes_audit_log.sql. Mismo contrato exacto que
  // `RentasRepository.registrarAuditoria`/`listAuditoria`
  // (@atiende/domain-rentas) — ver el comentario de cabecera de esa migración
  // para el porqué del patrón copiado.

  /** Nunca lanza -- best-effort real. Un fallo al registrar (base sin migrar,
   *  o cualquier error inesperado de Postgres) NUNCA revierte ni tumba la
   *  acción de negocio que ya se completó en la MISMA transacción del request;
   *  ver `PostgresRestaurantesRepository.registrarAuditoria`. */
  registrarAuditoria(input: RegistrarAuditoriaInput): Promise<void>;

  /** `disponible: false` (nunca lanza) cuando `restaurantes.audit_log`/
   *  `restaurantes.record_audit_log` todavía no existen en esta base (SQLSTATE
   *  42883/42P01/42703) -- ver
   *  `PostgresRestaurantesRepository.registrarAuditoria`. */
  listAuditoria(organizationId: string, filtro: RestaurantesAuditLogFiltro, paginacion: RestaurantesAuditLogPaginacion): Promise<RestaurantesAuditLogPagina>;

  // ---- FASE 3 (producto) -- configuración editable del panel (owner/admin),
  // ver migrations/021_restaurantes_config_editable_y_search_path_fix.sql. Ambas
  // tablas YA EXISTÍAN sin ninguna ruta de escritura -- ver el comentario de
  // cabecera de esa migración.

  /** `{ phoneNumberId: null }` cuando la organización nunca conectó WhatsApp --
   *  nunca lanza por "no configurado todavía" (mismo criterio "honesto" que
   *  `resolveActiveWhatsAppPhoneNumberId`). */
  getWhatsappChannelConfig(organizationId: string): Promise<WhatsappChannelConfig>;
  /** Alta o reemplazo del número conectado (`ON CONFLICT` por `organization_id`,
   *  primary key de la tabla) -- nunca dos filas por organización. */
  upsertWhatsappChannelConfig(organizationId: string, phoneNumberId: string): Promise<WhatsappChannelConfig>;

  // ---- R-38 (migración 062): marca pública del storefront ----

  /** Marca de la organización; `null` si nunca se guardó O si la base aún no tiene la migración 062 (la portada pública cae a una
   *  genérica con el nombre del restaurante). Nunca lanza por tabla/columna ausente. */
  findStorefrontMarca(organizationId: string): Promise<StorefrontMarca | null>;
  /** Alta o reemplazo completo de la marca (owner/admin por RLS). Lanza `RestaurantesConfigUnavailableError` si la base aún no tiene
   *  la migración 062 (la ruta responde 503, nunca 500). */
  upsertStorefrontMarca(organizationId: string, input: StorefrontMarcaInput): Promise<StorefrontMarca>;

  /** Más reciente primero -- orden total (ver `created_at desc, id desc`, mismo
   *  criterio de desempate que `restaurantes.audit_log` para paginación estable). */
  listKnownZones(organizationId: string): Promise<readonly KnownZone[]>;
  createKnownZone(organizationId: string, input: NewKnownZoneInput): Promise<KnownZone>;
  /** Colonias con la referencia del piloto original (migracion 056) para el reporte de colonias ambiguas. Contra la base sin migrar
   *  devuelve `{ disponible: false, zonas: [] }` (con SAVEPOINT: nunca aborta la transaccion del request). */
  listColoniasReferencia(organizationId: string): Promise<ColoniasReferenciaLectura>;
  /** `true` si borró una zona de ESTA organización; `false` si no existía o
   *  pertenecía a otra organización (nunca lanza por "no encontrado" -- el
   *  caller decide el 404, mismo contrato que `revokeStaffInvite`). */
  deleteKnownZone(organizationId: string, zoneId: string): Promise<boolean>;

  // ---- FASE 3 (producto) -- zona horaria por negocio (migración 022,
  // `restaurantes.branch_detail.zona_horaria`). A diferencia de whatsapp_channel_
  // config/known_zone (organization-scoped), esto es POR SUCURSAL -- mismo grano
  // que el resto de `branch_detail`. ----

  /** `{ zonaHoraria: null }` cuando la sucursal nunca configuró una zona real
   *  todavía -- nunca lanza por "no configurado" (mismo criterio "honesto" que
   *  `getWhatsappChannelConfig`), NI cuando la base todavía no tiene la
   *  migración 022 (degrada a `null`, ver
   *  `PostgresRestaurantesRepository.findBranchZonaHoraria`). */
  findBranchZonaHoraria(propertyId: string): Promise<BranchTimezoneConfig>;
  /** UPDATE real (la fila de `branch_detail` de una property SIEMPRE existe --
   *  es la misma fila que resuelve `findBranch`, nunca un upsert). Lanza
   *  `RestaurantesConfigUnavailableError` (503 honesto vía la ruta HTTP) si la
   *  base todavía no tiene la migración 022 aplicada. */
  upsertBranchZonaHoraria(propertyId: string, zonaHoraria: string | null): Promise<BranchTimezoneConfig>;

  // ---- Agente de WhatsApp por organizacion/sucursal (migracion 029) ----
  /** Config del agente para esa sucursal; si no tiene fila propia, la de la organizacion (property_id
   * null); `null` si no hay ninguna o la base todavia no tiene la migracion (SAVEPOINT + 42P01/42703/42501/
   * 42883): el llamador cae al agente generico. */
  findWhatsAppAgentConfig(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null>;
  /** Alta o reemplazo de la config de la organizacion (`propertyId` null) o de una sucursal. Lanza
   * `RestaurantesConfigUnavailableError` en una base sin migrar. */
  upsertWhatsAppAgentConfig(organizationId: string, propertyId: string | null, config: WhatsAppAgentConfigInput): Promise<WhatsAppAgentConfigRow>;
  /** Fila EXACTA de ese alcance (organizacion si `propertyId` es null; si no, la de esa sucursal) sin la precedencia
   * sucursal > organizacion de `findWhatsAppAgentConfig`. Incluye filas apagadas. `null` si no existe o la base no esta migrada. */
  findWhatsAppAgentConfigExacta(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null>;
  /** Guarda la config (migracion 033) con control de version y deja una entrada en el historial en la MISMA transaccion.
   * `versionEsperada`: la version que la pantalla vio (0 = "no habia fila"); `null` = sin control. Si ya no es la
   * vigente lanza `WhatsAppAgentConfigConflictError`. Sin la migracion 033 cae al guardado de 029 solo cuando no se usan
   * campos nuevos (sin historial); con campos nuevos lanza `RestaurantesConfigUnavailableError`. */
  guardarWhatsAppAgentConfig(
    organizationId: string,
    propertyId: string | null,
    config: WhatsAppAgentConfigInput,
    meta: { readonly accion: WhatsAppAgentConfigAccion; readonly actorUserId: string; readonly versionEsperada: number | null },
  ): Promise<WhatsAppAgentConfigRow>;
  /** Historial de cambios de ese alcance, mas reciente primero. Base sin migrar: lista vacia. */
  listWhatsAppAgentConfigHistorial(organizationId: string, propertyId: string | null, limit: number): Promise<readonly WhatsAppAgentConfigHistorialEntry[]>;

  // ---- Modelo PM (migracion 023): politica por sucursal, cobertura de entrega,
  // WhatsApp por sucursal y marcas no_domicilio. Toda LECTURA degrada a "sin
  // configurar" con SAVEPOINT cuando la base todavia no tiene la migracion (42P01/
  // 42703/42883) -- nunca lanza ni deja la transaccion abortada; toda ESCRITURA lanza
  // `RestaurantesConfigUnavailableError` en ese caso (503 honesto en la ruta). ----

  /** `EMPTY_BRANCH_POLICY` cuando la sucursal no tiene politica o la base no esta migrada. */
  findBranchPolicy(propertyId: string): Promise<BranchPolicy>;

  // ---- Conocimiento del negocio e interruptor del agente de WhatsApp (migracion 053). Toda LECTURA degrada con SAVEPOINT a
  // "sin conocimiento" / "agente encendido" contra la base sin migrar; toda ESCRITURA lanza `RestaurantesConfigUnavailableError`. ----

  /** Todas las entradas de la organizacion (borradores incluidos) para el panel; `disponible: false` contra la base sin migrar. */
  listarConocimiento(organizationId: string): Promise<ConocimientoLectura>;
  /** Entradas publicadas y activas que aplican a la sucursal (generales + las suyas). La vigencia por fecha la decide `listarConocimientoVigente`. */
  listarConocimientoPublicado(organizationId: string, propertyId: string | null): Promise<readonly ConocimientoEntrada[]>;
  crearConocimiento(organizationId: string, actorId: string, input: NuevaConocimientoEntrada): Promise<ConocimientoEntrada>;
  /** `null` si no existe o es de otra organizacion. */
  actualizarConocimiento(organizationId: string, actorId: string, id: string, patch: ConocimientoPatch): Promise<ConocimientoEntrada | null>;
  borrarConocimiento(organizationId: string, id: string): Promise<boolean>;
  /** `false` solo si la sucursal tiene el agente de WhatsApp APAGADO; sin fila o con la base sin migrar es `true` (como hasta hoy). */
  findAgenteWhatsappActivo(propertyId: string): Promise<boolean>;
  /** Sucursales con el agente de WhatsApp apagado; `disponible: false` contra la base sin migrar. */
  listarAgentesWhatsappApagados(organizationId: string): Promise<{ readonly disponible: boolean; readonly propertyIdsApagados: readonly string[] }>;
  fijarAgenteWhatsappActivo(organizationId: string, propertyId: string, actorId: string, activo: boolean): Promise<void>;

  // ---- Puentes (migracion 031): horario por fecha. La LECTURA degrada a [] contra la base sin migrar
  // (SAVEPOINT); la ESCRITURA lanza `RestaurantesConfigUnavailableError`. ----

  /** Excepciones de la sucursal que se traslapan con [fechaDesde, fechaHasta] (YYYY-MM-DD, inclusive). */
  listBranchHoursExceptions(propertyId: string, fechaDesde: string, fechaHasta: string): Promise<readonly BranchHoursException[]>;
  /** Excepciones de TODAS las sucursales de la organizacion que terminan hoy o despues (para el panel). */
  listUpcomingBranchHoursExceptions(organizationId: string, desdeFecha: string): Promise<readonly BranchHoursException[]>;
  createBranchHoursException(organizationId: string, input: NewBranchHoursExceptionInput): Promise<BranchHoursException>;
  deleteBranchHoursException(organizationId: string, exceptionId: string): Promise<boolean>;

  /** Canal, propina y hora de recogida (migracion 031) de varios pedidos. `[]` contra la base sin migrar:
   * los listados de pedidos NO seleccionan esas columnas para no romperse sin migrar. */
  listOrderPickupInfo(organizationId: string, orderIds: readonly string[]): Promise<readonly OrderPickupInfo[]>;

  // ---- Pedidos programados (migracion 034). Toda LECTURA degrada contra la base sin migrar (SAVEPOINT) a
  // "no disponible aun" sin lanzar; nunca se crea un pedido programado contra una base vieja. ----

  /** `true` si la base ya tiene la migracion 034 (columna `orders.programado_para`). */
  supportsScheduledOrders(): Promise<boolean>;
  /** Programacion de varios pedidos. `[]` contra la base sin migrar. */
  listOrderScheduleInfo(organizationId: string, orderIds: readonly string[]): Promise<readonly OrderScheduleInfo[]>;
  /** Pedidos en estado `programado`, el mas proximo primero. `disponible:false` contra la base sin migrar. */
  listScheduledOrders(organizationId: string, filter: { readonly propertyIds: readonly string[] | null; readonly limit: number }): Promise<ScheduledOrdersResult>;
  /** Promueve a `pending` los programados cuya hora cae dentro de `anticipacionMin` minutos (o ya paso).
   * Idempotente: solo toca filas en `programado` (un pedido cancelado nunca se promueve) y cada pedido se
   * promueve UNA vez. `organizationId: null` = barrido de TODAS las organizaciones (solo sesion de sistema).
   * `disponible:false` contra la base sin migrar. */
  promoteDueScheduledOrders(
    organizationId: string | null,
    options: { readonly now: Date; readonly anticipacionMin: number; readonly propertyIds?: readonly string[] | null },
  ): Promise<PromotedScheduledOrdersResult>;
  /** Pedidos ya promovidos a cocina en las ultimas `hours` horas (estado `pending` o `preparando`) cuya
   * comanda no esta en el outbox del POS, de organizaciones con SoftRestaurant en sombra/activo (QA-restaurantes-R1-
   * automatizacion-02). Solo sesion de sistema. `[]` contra la base sin migrar (la 046). El repositorio en memoria no
   * conoce el outbox del POS: devuelve todos los promovidos recientes (reencolar es idempotente). */
  listPromotedOrdersWithoutComanda(options: { readonly hours: number; readonly limit: number }): Promise<readonly Order[]>;
  /** Reemplaza la politica completa de la sucursal (upsert por property_id). */
  upsertBranchPolicy(organizationId: string, propertyId: string, policy: BranchPolicy): Promise<BranchPolicy>;
  /** Ids de `known_zone` que cubre la sucursal para entregas; [] = sin cobertura
   * configurada (no restringe) o base sin migrar. */
  listBranchDeliveryZoneIds(propertyId: string): Promise<readonly string[]>;
  /** Reemplaza el conjunto de zonas de la sucursal (todo o nada dentro de la misma
   * sesion). */
  replaceBranchDeliveryZones(organizationId: string, propertyId: string, zoneIds: readonly string[]): Promise<readonly string[]>;
  /** Resuelve el numero que recibio un mensaje: primero el numero de una sucursal, luego
   * el numero por defecto de la organizacion. `null` si ninguno lo reconoce. */
  resolveWhatsAppChannel(phoneNumberId: string): Promise<WhatsAppChannelResolution | null>;
  listWhatsappBranchChannels(organizationId: string): Promise<readonly WhatsappBranchChannel[]>;
  upsertWhatsappBranchChannel(organizationId: string, propertyId: string, phoneNumberId: string): Promise<WhatsappBranchChannel>;
  /** `true` si borro el numero de ESA sucursal de ESTA organizacion. */
  deleteWhatsappBranchChannel(organizationId: string, propertyId: string): Promise<boolean>;
  listNoDomicilioMarks(organizationId: string): Promise<NoDomicilioMarks>;
  /** `false` si el producto/categoria no existe en la organizacion. */
  setProductNoDomicilio(organizationId: string, productId: string, noDomicilio: boolean): Promise<boolean>;
  setCategoryNoDomicilio(organizationId: string, categoryId: string, noDomicilio: boolean): Promise<boolean>;
}

export interface ScheduledOrdersResult {
  readonly disponible: boolean;
  readonly orders: readonly Order[];
}

export interface PromotedScheduledOrdersResult {
  readonly disponible: boolean;
  readonly promoted: readonly Order[];
}

/** Lanzado por `upsertWhatsappChannelConfig`/`createKnownZone`/`deleteKnownZone`
 *  cuando la migración `021_restaurantes_config_editable_y_search_path_fix.sql`
 *  todavía no se aplicó a esta base (SQLSTATE 42501 -- la tabla YA EXISTE desde
 *  Fase 1, así que a diferencia de `restaurantes.audit_log` esto nunca es
 *  42883/42P01/42703: es un GRANT/policy de escritura que esta fase agrega sobre
 *  una tabla vieja, no un objeto nuevo). El caller HTTP (`admin-config.ts`) lo
 *  traduce a un 503 honesto, nunca un 500 -- ver el comentario de cabecera de
 *  `PostgresRestaurantesRepository.upsertWhatsappChannelConfig`. */
export class RestaurantesConfigUnavailableError extends Error {
  constructor() {
    super("Esta configuración todavía no se puede editar en esta base de datos.");
    this.name = "RestaurantesConfigUnavailableError";
  }
}

/** Un status de Meta ya filtrado por el extractor: solo lo necesario, sin telefono ni texto. */
export interface EstadoEntregaEntrante {
  readonly wamid: string;
  readonly status: "sent" | "delivered" | "read" | "failed";
  readonly errorCode: number | null;
  readonly errorTitle: string | null;
}

export type MotivoFalloEntregaGuardado = "fuera_de_ventana" | "fuera_de_ventana_plantilla_sin_usar" | "numero_no_entregable" | "plantilla" | "limite_marketing" | "otro";

/** Resultado de `registrarEstadoEntregaWhatsapp`. `desconocido` = ningun mensaje de ESTA organizacion con ese wamid; `no_disponible` = base sin la
 *  migracion 066 (el webhook sigue respondiendo 200). */
export interface RegistroEstadoEntrega {
  readonly resultado: "actualizado" | "sin_cambio" | "desconocido" | "no_disponible";
  readonly outboxId: string | null;
  readonly estado: "sent" | "delivered" | "read" | "failed" | null;
  readonly eventType: string | null;
  readonly motivoFallo: MotivoFalloEntregaGuardado | null;
  /** Solo si el mensaje era un aviso de estado de pedido. */
  readonly orderId: string | null;
  readonly orderStatus: string | null;
  /** Mensajes de la organizacion con entrega fallida en la ultima hora (incluye este). */
  readonly fallidasUltimaHora: number;
  /** Datos del pedido para el respaldo por correo: SOLO cuando este status hace pasar un aviso de pedido a `failed` y el cliente dejo correo (la
   *  sesion de sistema no puede leer `orders`, asi que los entrega la funcion SQL ya acotada por organizacion). */
  readonly respaldoCorreo: { readonly to: string; readonly clienteNombre: string; readonly sucursal: string | null; readonly total: number } | null;
}

/** Fila de `restaurantes.messaging_outbox` reclamada para despacho real — mismo
 * shape que `@atiende/domain-citas::MessagingOutboxRow` (ver
 * @atiende/whatsapp-gateway::MessagingOutboxPort). */
export interface MessagingOutboxRow {
  readonly id: string;
  readonly attempts: number;
  readonly payload: unknown;
  /** Organizacion duena del mensaje (PL-16: medidor mensual de mensajes por plan). */
  readonly organizationId?: string;
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

/** Los 4 eventos reales que dispara `order-notifications.ts` — mismo CHECK que
 * `restaurantes.staff_order_notification.event_type` (migrations/009). */
export type StaffOrderNotificationEventType = "order.created" | "order.problema" | "order.assigned_repartidor" | "order.programado_promovido";

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
