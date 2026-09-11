// Puerto de acceso a datos de domain-restaurantes — mismo patrón dual de adaptador
// que ya usa @atiende/core-conversation (InMemoryStateStore/PostgresStateStore
// implementando el mismo StateStore): un puerto TS explícito, con un adaptador real
// en memoria (tests determinísticos, sin depender de que packages/db tenga ya un
// motor de conexión) y un adaptador real de Postgres (sobre TenantDbSession, contra
// las migraciones de migrations/001-004). Ninguna función de negocio de
// customers.ts/orders.ts/whatsapp/* toca SQL directamente — todas pasan por aquí,
// así que el mismo código de negocio corre igual en tests y en producción.
import type { Branch, CallbackRequest, CallbackRequestInput, Customer, CustomerAddress, CustomerTier, Order, PersistedOrderItem } from "./types.ts";

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

export interface RestaurantesRepository {
  findOrganizationBySlug(slug: string): Promise<{ id: string; slug: string; name: string } | null>;
  findBranch(organizationId: string, selector: { slug?: string; name?: string }): Promise<Branch | null>;
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
}
