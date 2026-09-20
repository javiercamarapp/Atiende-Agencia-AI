// Tipos de dominio de restaurantes — port de las formas de
// restaurantes/supabase/functions/_shared/create-order-core.ts, renombrando
// restaurant_id -> organizationId y branch_id -> propertyId para integrar con el
// modelo de tenancy de @atiende/core-tenancy (Organization/Property), en vez del
// concepto de tenant aislado (`restaurants`) del origen.

export interface Branch {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "inactive";
  readonly phone: string | null;
  readonly address: string | null;
  /** Ya vivían en `branch_detail` desde Fase 1 (migrations/001) sin usar por
   * ningún caso de negocio — Fase 2 los expone para buscar_sucursal_cercana
   * (ver nearest-branch.ts). null si la sucursal nunca capturó coordenadas. */
  readonly lat: number | null;
  readonly lng: number | null;
}

/** Forma resumida de sucursal para el bloque dinámico "SUCURSALES REALES" del
 * prompt del agente de WhatsApp (ver whatsapp/llm-turn-handler.ts) — nunca
 * hardcodeado por organización, a diferencia del prompt mono-tenant del
 * origen. */
export interface BranchSummary {
  readonly propertyId: string;
  readonly name: string;
  readonly slug: string;
  readonly address: string | null;
}

/** Resultado real de emparejar una colonia/zona contra `known_zone` y
 * calcular distancia Haversine contra las sucursales activas con lat/lng de
 * la organización — ver nearest-branch.ts. */
export interface NearestBranchMatch {
  readonly branch: Branch;
  readonly distanceKm: number;
  readonly recognizedZoneName: string;
}

export type TortillaChoice = "maiz" | "harina";
export type CustomerTier = "BLACK" | "PLATINUM" | "GOLD" | "BLUE";

/**
 * Producto disponible en una sucursal (branch_products join products), tal como lo
 * ve la lógica de cotización — port literal de `ProductoEncontrado` del origen.
 */
export interface ProductoEncontrado {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  /**
   * Cantidad fija de piezas del paquete si el producto se vende como paquete
   * indivisible (ej. 3 para "Tacos de Bistec de Res (orden de 3)"), 1 si se vende
   * individual, null si no aplica esa noción (bebidas, kilos, etc.). Calculado del
   * name+description real, nunca inferido por el LLM.
   */
  readonly packSize: number | null;
  readonly requiresAdultConfirmation: boolean;
}

export interface RequestedOrderItemInput {
  readonly productId?: string;
  /** Nombre exacto devuelto por buscar_producto; permite recuperar un id mal copiado. */
  readonly productName?: string;
  readonly requestedQuantity: number;
  readonly tortilla?: TortillaChoice;
}

export interface QuotedOrderLine {
  readonly productId: string;
  readonly name: string;
  readonly price: number;
  readonly requestedQuantity: number;
  readonly packSize: number | null;
  /** Unidades del catálogo que se cobran/guardan (distinto de requestedQuantity cuando packSize>1). */
  readonly quantity: number;
  readonly tortilla: TortillaChoice | null;
  readonly requiresAdultConfirmation: boolean;
  readonly lineTotal: number;
}

export interface OrderQuote {
  readonly lines: readonly QuotedOrderLine[];
  readonly total: number;
  readonly containsAlcohol: boolean;
}

export type RequestedComplement = "salsa_habanero" | "crema_ajo";
export type DefaultComplement = "salsa_verde" | "salsa_roja" | "limones" | "cebolla";

export interface CustomerAddress {
  readonly address: string;
  readonly label: string | null;
  readonly isDefault: boolean;
}

export interface OrderHistoryItem {
  readonly name: string;
  readonly quantity: number;
}

/**
 * Resultado fusionado de lookupCustomer + vipNote + frase de frequent_items del
 * origen (mismo shape que `customer-lookup`/index.ts devuelve, con agentNotes ya
 * listo para inyectar en un prompt).
 */
export type CustomerLookupResult =
  | { readonly isNew: true }
  | {
      readonly isNew: false;
      readonly name: string | null;
      readonly orderCount: number;
      readonly addresses: readonly CustomerAddress[];
      readonly lastOrderItems: readonly OrderHistoryItem[] | null;
      readonly frequentItems: readonly OrderHistoryItem[];
      readonly tier: CustomerTier | null;
      readonly agentNotes: readonly string[];
    };

export interface CreateOrderItemInput {
  readonly productId?: string;
  readonly productName?: string;
  readonly quantity?: number;
  readonly requestedQuantity?: number;
  readonly tortilla?: TortillaChoice;
}

export interface CreateOrderInput {
  readonly organizationId: string;
  readonly branchSlug?: string;
  readonly branchName?: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress?: string;
  /** Fase de correo — ver migrations/011_email_outbox_dispatch.sql: opcional a
   * propósito (restaurantes es voz/WhatsApp-first, ver validateCreateOrderPayload
   * en orders.ts) — cuando el cliente SÍ lo deja, dispara la confirmación de
   * pedido por correo real (order-notifications.ts). */
  readonly customerEmail?: string;
  readonly items: readonly CreateOrderItemInput[];
  readonly source: "web" | "voice" | "whatsapp" | "admin";
  readonly notes?: string;
  readonly paymentMethod?: "efectivo" | "tarjeta";
  readonly idempotencyKey?: string;
  readonly adultConfirmed?: boolean;
  readonly requestedComplements?: readonly RequestedComplement[];
  readonly omitDefaultComplements?: readonly DefaultComplement[];
  readonly callTranscript?: string;
  readonly callRecordingUrl?: string;
  /** Fase 11 — código de promoción a aplicar al total (ver promotions.ts). Opcional:
   * un pedido sin código nunca pasa por el motor de promociones (mismo criterio que
   * el resto de campos opcionales de este input). */
  readonly promoCode?: string;
}

export interface Order {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly customerId: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress: string | null;
  /** Fase de correo — ver migrations/011_email_outbox_dispatch.sql. `null` para
   * cualquier pedido creado antes de esta migración o por un canal (voz/
   * WhatsApp) que todavía no lo captura. */
  readonly customerEmail: string | null;
  readonly branch: string | null;
  readonly total: number;
  readonly status: OrderStatus;
  readonly items: readonly PersistedOrderItem[];
  readonly source: "web" | "voice" | "whatsapp" | "admin";
  readonly notes: string | null;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
  readonly callTranscript: string | null;
  readonly callRecordingUrl: string | null;
  readonly dedupeFingerprint: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
  // ---- Fase 8 — superficie real del rol "repartidor" (ver roles.ts, migrations/008) ----
  /** `core.staff_user.id` del repartidor despachado a este pedido por un
   * MANAGER_ROLES (nunca lo pone el repartidor mismo) — null hasta que se
   * despache. Puerto de `orders.assigned_repartidor_id` del origen. */
  readonly assignedRepartidorId: string | null;
  /** Capturada al despachar (ver `assignRepartidorToOrder`) — puerto literal de
   * `orders.estimated_delivery_at` del origen, usada ahí para calcular la
   * condición "Demorado" en el panel de repartidor. */
  readonly estimatedDeliveryAt: string | null;
  /** Nota libre de la incidencia que el repartidor reportó (status="problema") —
   * puerto literal de `orders.incident_note` del origen. null salvo cuando el
   * pedido está (o estuvo) en "problema". */
  readonly incidentNote: string | null;
}

export interface PersistedOrderItem {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly quantity: number;
  readonly tortilla?: TortillaChoice;
}

export interface Customer {
  readonly id: string;
  readonly organizationId: string;
  readonly phone: string;
  readonly name: string | null;
  readonly orderCount: number;
}

// ---- Fase 5 — back-office CORE (catálogo/sucursales/pedidos/clientes, ver diseño §1) ----

export interface Category {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly displayOrder: number;
}

export interface NewCategoryInput {
  readonly name: string;
  readonly slug: string;
  readonly displayOrder?: number;
}

export interface CategoryPatch {
  readonly name?: string;
  readonly slug?: string;
  readonly displayOrder?: number;
}

/** Catálogo real de un producto (organization-wide) — NO trae precio/disponibilidad
 * por sucursal (eso vive en `branch_products`, ver `BranchProductState` y
 * product-search.ts): `price` aquí es el precio BASE del producto
 * (`restaurantes.products.price`), el mismo que el origen usa como default al
 * darlo de alta en una sucursal nueva. */
export interface Product {
  readonly id: string;
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly price: number;
  readonly imageUrl: string | null;
  readonly isPopular: boolean;
  readonly isAvailable: boolean;
  readonly displayOrder: number;
  readonly searchKeywords: readonly string[];
}

export interface NewProductInput {
  readonly categoryId?: string | null;
  readonly name: string;
  readonly description?: string | null;
  readonly price: number;
  readonly imageUrl?: string | null;
  readonly isPopular?: boolean;
  readonly isAvailable?: boolean;
  readonly displayOrder?: number;
  readonly searchKeywords?: readonly string[];
}

export interface ProductPatch {
  readonly categoryId?: string | null;
  readonly name?: string;
  readonly description?: string | null;
  readonly price?: number;
  readonly imageUrl?: string | null;
  readonly isPopular?: boolean;
  readonly isAvailable?: boolean;
  readonly displayOrder?: number;
  readonly searchKeywords?: readonly string[];
}

/** Precio/disponibilidad REAL de un producto en UNA sucursal (`branch_products` —
 * fuente de verdad de precio/disponibilidad que ya usa searchProducts/quoteOrder,
 * ver product-search.ts). `null` cuando el producto nunca se dio de alta en esa
 * sucursal (nunca se asume un precio/disponibilidad por defecto). */
export interface BranchProductState {
  readonly propertyId: string;
  readonly productId: string;
  readonly price: number;
  readonly isAvailable: boolean;
}

export type OrderStatus = "pending" | "preparando" | "en_camino" | "entregado" | "cancelado" | "completado" | "problema";

export interface OrderListFilter {
  readonly propertyIds: readonly string[] | null;
  readonly status?: OrderStatus;
  readonly dateFrom?: Date;
  readonly dateTo?: Date;
  readonly limit: number;
  readonly cursor?: string;
}

export interface OrderListPage {
  readonly orders: readonly Order[];
  readonly nextCursor: string | null;
}

export interface CustomerListFilter {
  readonly search?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface CustomerListPage {
  readonly customers: readonly Customer[];
  readonly nextCursor: string | null;
}

export interface CallbackRequestInput {
  readonly organizationId: string;
  readonly propertyId?: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly reason?: string;
  readonly message?: string;
  readonly source: "voice" | "whatsapp" | "web" | "admin";
}

export interface CallbackRequest extends CallbackRequestInput {
  readonly id: string;
  readonly resolved: boolean;
  readonly createdAt: string;
}

// ---- Fase 11 — promociones/marketing: motor real de código de descuento (ver
// promotions.ts). El original (`restaurantes/supabase/migrations/20251204004242_
// remix_migration_from_pg_dump.sql`) solo tenía `public.promos`: un banner
// puramente informativo (title/description/image_url/discount_text libre/
// is_active/display_order) SIN ninguna aplicación real a un pedido — `orders` del
// origen no tiene columna de descuento/promo_id, y `discount_text` es texto libre
// ("2x1", "20% off") que nunca se calcula, solo se muestra (confirmado también en
// `supabase/functions/_shared/whatsapp-agent-core.ts` del origen: el agente solo
// MENCIONA la promo, nunca la aplica). Este módulo es deliberadamente nuevo
// respecto al origen — documentado así a propósito, nunca presentado como port de
// una regla de negocio verificada — porque el gap real auditado pedía la
// aplicación real al total de un pedido, que el origen nunca tuvo. Una sola
// promoción por pedido a propósito: no hay evidencia en el origen de una regla de
// combinabilidad, así que no se inventa una.
export type PromotionType = "percentage" | "fixed";

export interface Promotion {
  readonly id: string;
  readonly organizationId: string;
  /** Siempre en mayúsculas (normalizado al crear/editar) — único por organización. */
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: PromotionType;
  /** Porcentaje (1-100) si type==='percentage', pesos (>0) si type==='fixed'. */
  readonly value: number;
  /** Total mínimo del pedido (antes de descuento) para que el código aplique — null
   * = sin mínimo. */
  readonly minOrderTotal: number | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** 0=domingo..6=sábado (mismo criterio que `Date#getDay()`) — null/vacío = todos
   * los días. */
  readonly daysOfWeek: readonly number[] | null;
  /** "HH:MM" en hora local del servidor — null = sin restricción de hora. */
  readonly startTime: string | null;
  readonly endTime: string | null;
  /** Límite total de usos reales (organization-wide) — null = ilimitado. */
  readonly maxUses: number | null;
  readonly timesUsed: number;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewPromotionInput {
  readonly code: string;
  readonly name: string;
  readonly description?: string | null;
  readonly type: PromotionType;
  readonly value: number;
  readonly minOrderTotal?: number | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly daysOfWeek?: readonly number[] | null;
  readonly startTime?: string | null;
  readonly endTime?: string | null;
  readonly maxUses?: number | null;
  readonly isActive?: boolean;
}

export interface PromotionPatch {
  readonly code?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly type?: PromotionType;
  readonly value?: number;
  readonly minOrderTotal?: number | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly daysOfWeek?: readonly number[] | null;
  readonly startTime?: string | null;
  readonly endTime?: string | null;
  readonly maxUses?: number | null;
  readonly isActive?: boolean;
}

// ---------------------------------------------------------------------------
// FASE 3 (producto) — bitácora de auditoría del staff, ver
// migrations/019_restaurantes_audit_log.sql. Mismo shape exacto que
// domain-rentas/src/types.ts (RegistrarAuditoriaInput/RentasAuditLog*) — copiado
// a propósito para que ambas verticales se lean igual, ver comentario de cabecera
// de esa migración para las 2 correcciones que nacen resueltas aquí (orden total
// desde el día uno, validación de rol). 'configuracion' ya tiene caller real
// desde FASE 3 (producto): `admin-config.ts::PUT .../admin/config/whatsapp` y
// `POST`/`DELETE .../admin/config/zonas` — ver `migrations/
// 021_restaurantes_config_editable_y_search_path_fix.sql`. Horarios de
// atención/configuración de voz siguen sin ruta (ninguna tabla existe todavía
// en el schema base para ninguno de los dos — ver el comentario de cabecera de
// esa migración).
// ---------------------------------------------------------------------------
export type RestaurantesAuditEntityType = "producto" | "promocion" | "pedido" | "repartidor" | "staff" | "configuracion";

export interface RegistrarAuditoriaInput {
  readonly organizationId: string;
  /** Usado SOLO por `InMemoryRestaurantesRepository` (sin `auth.uid()`) para
   *  poblar `actorUserId` en sus fixtures de prueba. `PostgresRestaurantesRepository`
   *  lo IGNORA por completo al armar la llamada SQL -- `restaurantes.record_audit_log`
   *  (security definer) captura el actor real vía `auth.uid()` dentro de la
   *  función, nunca confía en un parámetro de este lado. */
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: RestaurantesAuditEntityType;
  readonly entityId: string | null;
  readonly campo?: string | null;
  readonly antes?: string | null;
  readonly despues?: string | null;
}

export interface RestaurantesAuditLogRow {
  readonly id: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly campo: string | null;
  readonly antes: string | null;
  readonly despues: string | null;
  readonly createdAtMs: number;
}

export interface RestaurantesAuditLogFiltro {
  readonly entityType?: RestaurantesAuditEntityType | null;
  /** `YYYY-MM-DD`, inclusive. */
  readonly desde?: string | null;
  /** `YYYY-MM-DD`, inclusive. */
  readonly hasta?: string | null;
}

export interface RestaurantesAuditLogPaginacion {
  readonly limit?: number;
  readonly offset?: number;
}

export interface RestaurantesAuditLogPagina {
  /** `false` cuando `restaurantes.audit_log`/`restaurantes.record_audit_log`
   *  todavía no existen en esta base (SQLSTATE 42883/42P01/42703, ver
   *  postgres-repository.ts) -- la pantalla debe mostrar "no disponible aún",
   *  nunca confundirlo con una bitácora real pero vacía
   *  (`disponible: true, items: []`). */
  readonly disponible: boolean;
  readonly items: readonly RestaurantesAuditLogRow[];
  readonly total: number;
  readonly nextOffset: number | null;
}

// ---------------------------------------------------------------------------
// FASE 3 (producto) -- configuración editable del panel (owner/admin), ver
// migrations/021_restaurantes_config_editable_y_search_path_fix.sql. Conecta
// tablas que YA EXISTÍAN sin ninguna ruta de escritura -- ver el comentario de
// cabecera de esa migración para el porqué de cada una.
// ---------------------------------------------------------------------------

/** `restaurantes.whatsapp_channel_config` (migrations/001/017) -- `null` cuando
 *  la organización nunca conectó un número (mismo criterio "honesto" que
 *  `resolveActiveWhatsAppPhoneNumberId`: nunca un objeto fingido). */
export interface WhatsappChannelConfig {
  readonly phoneNumberId: string | null;
}

/** `restaurantes.known_zone` (migrations/005/016) -- fila completa para el
 *  listado de administración (a diferencia de `NearestBranchMatch`, que solo
 *  expone el nombre reconocido de la zona que matcheó). */
export interface KnownZone {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly createdAt: string;
}

export interface NewKnownZoneInput {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
}

/** FASE 3 (producto) -- zona horaria por negocio (migración 022,
 * `restaurantes.branch_detail.zona_horaria`). `null` cuando la sucursal nunca
 * configuró una zona real todavía (o la columna aún no existe en la base --
 * ver `PostgresRestaurantesRepository.findBranchZonaHoraria`, degrada a `null`
 * en 42501/42883/42P01/42703, NUNCA lanza) -- el caller SIEMPRE resuelve el
 * default de plataforma vía
 * `@atiende/core-tenancy::resolverZonaHorariaNegocio(config.zonaHoraria)`,
 * nunca hardcodea `"America/Mexico_City"` directo. */
export interface BranchTimezoneConfig {
  readonly zonaHoraria: string | null;
}
