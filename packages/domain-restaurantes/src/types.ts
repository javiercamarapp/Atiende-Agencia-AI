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
}

export interface Order {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly customerId: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress: string | null;
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
