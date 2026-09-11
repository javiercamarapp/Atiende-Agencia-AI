// InMemoryRestaurantesRepository — implementación real (no un mock) de
// `RestaurantesRepository`, con las mismas restricciones de integridad e idempotencia
// que las migraciones SQL de migrations/001-004 (UNIQUE(organization_id, phone),
// serialización tipo pg_advisory_xact_lock, dedupe de mensajes de WhatsApp, leases de
// conversación). Sirve como fixture de seed para tests determinísticos y como
// fallback dev/CI sin Postgres real — mismo rol que InMemoryStateStore en
// @atiende/core-conversation.
import { randomUUID } from "node:crypto";
import type { Branch, CallbackRequest, CallbackRequestInput, Customer, CustomerAddress, CustomerTier, Order, PersistedOrderItem } from "./types.ts";
import type { ConversationMessage, NewOrderRecord, RestaurantesRepository, SearchableProduct } from "./repository.ts";

/** Serializa operaciones por clave — equivalente en memoria de
 * `pg_advisory_xact_lock`/row lock de Postgres: dos llamadas concurrentes con la
 * MISMA clave se ejecutan una tras otra, nunca entrelazadas. */
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

interface StoredOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

interface StoredBranch extends Branch {}

interface StoredCategory {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
}

interface StoredProduct {
  readonly id: string;
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly searchKeywords: readonly string[];
}

interface StoredBranchProduct {
  readonly propertyId: string;
  readonly productId: string;
  price: number;
  isAvailable: boolean;
}

interface StoredOrder extends Order {}

interface StoredWhatsAppEvent {
  status: "processing" | "processed" | "failed";
  attempts: number;
  claimedAt: number;
}

interface StoredLease {
  ownerMessageId: string;
  lockedUntil: number;
}

interface StoredConversation {
  messages: ConversationMessage[];
  status: "active" | "completed" | "abandoned";
  orderId: string | null;
  propertyId: string | null;
}

export class InMemoryRestaurantesRepository implements RestaurantesRepository {
  private readonly organizations = new Map<string, StoredOrganization>();
  private readonly organizationIdBySlug = new Map<string, string>();
  private readonly branches = new Map<string, StoredBranch>();
  private readonly categories = new Map<string, StoredCategory>();
  private readonly products = new Map<string, StoredProduct>();
  private readonly branchProducts: StoredBranchProduct[] = [];
  private readonly customers = new Map<string, Customer>();
  private readonly customerIdByOrgPhone = new Map<string, string>();
  private readonly addresses = new Map<string, CustomerAddress[]>();
  private readonly orders: StoredOrder[] = [];
  private readonly callbackRequests: CallbackRequest[] = [];
  private readonly rateLimits = new Map<string, { windowStartedAt: number; requestCount: number }>();
  private readonly phoneNumberIdToOrg = new Map<string, string>();
  private readonly whatsappEvents = new Map<string, StoredWhatsAppEvent>();
  private readonly whatsappLeases = new Map<string, StoredLease>();
  private readonly whatsappConversations = new Map<string, StoredConversation>();

  private readonly orderLock = new KeyedMutex();
  private readonly customerLock = new KeyedMutex();
  private readonly whatsappLock = new KeyedMutex();

  // ---- seeding (equivalente a INSERT manual contra las migraciones SQL) ----

  seedOrganization(org: StoredOrganization): void {
    this.organizations.set(org.id, org);
    this.organizationIdBySlug.set(org.slug, org.id);
  }

  seedBranch(branch: Branch): void {
    this.branches.set(branch.propertyId, branch);
  }

  seedCategory(category: StoredCategory): void {
    this.categories.set(category.id, category);
  }

  seedProduct(product: StoredProduct): void {
    this.products.set(product.id, product);
  }

  seedBranchProduct(entry: StoredBranchProduct): void {
    this.branchProducts.push({ ...entry });
  }

  seedWhatsAppChannel(organizationId: string, phoneNumberId: string): void {
    this.phoneNumberIdToOrg.set(phoneNumberId, organizationId);
  }

  // ---- RestaurantesRepository ----

  async findOrganizationBySlug(slug: string): Promise<{ id: string; slug: string; name: string } | null> {
    const id = this.organizationIdBySlug.get(slug);
    if (!id) return null;
    return this.organizations.get(id) ?? null;
  }

  async findBranch(organizationId: string, selector: { slug?: string; name?: string }): Promise<Branch | null> {
    for (const branch of this.branches.values()) {
      if (branch.organizationId !== organizationId) continue;
      if (selector.slug !== undefined && branch.slug === selector.slug) return branch;
      if (selector.name !== undefined && branch.name === selector.name) return branch;
    }
    return null;
  }

  async listAvailableProductsForBranch(propertyId: string): Promise<readonly SearchableProduct[]> {
    const result: SearchableProduct[] = [];
    for (const bp of this.branchProducts) {
      if (bp.propertyId !== propertyId || !bp.isAvailable) continue;
      const product = this.products.get(bp.productId);
      if (!product) continue;
      const category = product.categoryId ? this.categories.get(product.categoryId) : undefined;
      result.push({
        id: product.id,
        name: product.name,
        description: product.description,
        categoryName: category?.name ?? null,
        searchKeywords: product.searchKeywords,
        price: bp.price,
        isAvailable: bp.isAvailable,
      });
    }
    return result;
  }

  async findCustomerByPhone(organizationId: string, phone: string): Promise<Customer | null> {
    const id = this.customerIdByOrgPhone.get(`${organizationId}:${phone}`);
    return id ? (this.customers.get(id) ?? null) : null;
  }

  async upsertCustomer(organizationId: string, phone: string, name: string): Promise<Customer> {
    // Serializado por (organizationId, phone) — mismo rol que el UNIQUE real +
    // recuperación de 23505 del origen: dos intentos casi simultáneos del mismo
    // cliente nuevo nunca crean dos filas, el segundo ve al primero ya insertado.
    return this.customerLock.run(`${organizationId}:${phone}`, async () => {
      const key = `${organizationId}:${phone}`;
      const existingId = this.customerIdByOrgPhone.get(key);
      if (existingId) {
        const existing = this.customers.get(existingId)!;
        // Nunca sobreescribe un nombre ya conocido con uno posiblemente mal escuchado.
        const updated: Customer = { ...existing, name: existing.name ?? name };
        this.customers.set(existingId, updated);
        return updated;
      }
      const created: Customer = { id: randomUUID(), organizationId, phone, name, orderCount: 0 };
      this.customers.set(created.id, created);
      this.customerIdByOrgPhone.set(key, created.id);
      return created;
    });
  }

  async addCustomerAddressIfNew(customerId: string, address: string): Promise<void> {
    const list = this.addresses.get(customerId) ?? [];
    if (list.some((a) => a.address === address)) return; // onConflict ignoreDuplicates
    list.push({ address, label: null, isDefault: list.length === 0 });
    this.addresses.set(customerId, list);
  }

  async listCustomerAddresses(customerId: string): Promise<readonly CustomerAddress[]> {
    const list = this.addresses.get(customerId) ?? [];
    return [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }

  async listEligibleOrderHistory(customerId: string): Promise<ReadonlyArray<{ items: readonly PersistedOrderItem[]; createdAt: string }>> {
    const eligibleStatuses = new Set(["pending", "preparando", "en_camino", "entregado", "completado"]);
    return this.orders
      .filter((o) => o.customerId === customerId && eligibleStatuses.has(o.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((o) => ({ items: o.items, createdAt: o.createdAt }));
  }

  async calcCustomerTier(organizationId: string, customerId: string): Promise<CustomerTier | null> {
    // Réplica en JS de restaurantes.calc_customer_tier (migrations/002): mismo
    // criterio de selección de métrica (gasto si >=30% de clientes tiene gasto>0, si
    // no frecuencia, si no sin_datos) y mismos cortes de percentil "mid-rank".
    const clientes = [...this.customers.values()].filter((c) => c.organizationId === organizationId);
    if (clientes.length === 0) return null;
    const gastoPorCliente = new Map<string, number>();
    for (const o of this.orders) {
      if (o.organizationId !== organizationId || !o.customerId) continue;
      gastoPorCliente.set(o.customerId, (gastoPorCliente.get(o.customerId) ?? 0) + o.total);
    }
    const conGasto = clientes.filter((c) => (gastoPorCliente.get(c.id) ?? 0) > 0).length;
    const conFrecuencia = clientes.filter((c) => c.orderCount > 0).length;
    const n = clientes.length;
    const metrica = conGasto >= Math.max(1, Math.ceil(n * 0.3)) ? "gasto" : conFrecuencia > 0 ? "frecuencia" : "sin_datos";
    if (metrica === "sin_datos") return null;

    const valores = clientes.map((c) => ({
      id: c.id,
      valor: metrica === "gasto" ? (gastoPorCliente.get(c.id) ?? 0) : c.orderCount,
    }));
    const sorted = [...valores].sort((a, b) => a.valor - b.valor);
    const percentilById = new Map<string, number>();
    if (n === 1) {
      percentilById.set(sorted[0]!.id, 100);
    } else {
      let index = 0;
      while (index < sorted.length) {
        let end = index;
        while (end + 1 < sorted.length && sorted[end + 1]!.valor === sorted[index]!.valor) end += 1;
        const rankMin = index; // 0-based, igual que (rank() - 1) del SQL
        const tieCount = end - index + 1;
        const percentil = ((rankMin + rankMin + tieCount - 1) / 2 / (n - 1)) * 100;
        for (let i = index; i <= end; i += 1) percentilById.set(sorted[i]!.id, percentil);
        index = end + 1;
      }
    }
    const percentil = percentilById.get(customerId);
    if (percentil === undefined) return null;
    if (percentil >= 90) return "BLACK";
    if (percentil >= 75) return "PLATINUM";
    if (percentil >= 35) return "GOLD";
    return "BLUE";
  }

  async createOrderIdempotent(order: NewOrderRecord, dedupeFingerprint: string, idempotencyKey: string | null): Promise<Order> {
    return this.orderLock.run(`${order.organizationId}:${idempotencyKey ?? dedupeFingerprint}`, async () => {
      if (idempotencyKey) {
        const existing = this.orders.find((o) => o.organizationId === order.organizationId && o.idempotencyKey === idempotencyKey);
        if (existing) return existing;
      } else {
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        const existing = this.orders.find(
          (o) =>
            o.organizationId === order.organizationId &&
            o.dedupeFingerprint === dedupeFingerprint &&
            o.status === "pending" &&
            Date.parse(o.createdAt) >= fiveMinutesAgo,
        );
        if (existing) return existing;
      }

      const created: Order = {
        id: randomUUID(),
        organizationId: order.organizationId,
        propertyId: order.propertyId,
        customerId: order.customerId,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerAddress: order.customerAddress,
        branch: order.branch,
        total: order.total,
        status: "pending",
        items: order.items,
        source: order.source,
        notes: order.notes,
        paymentMethod: order.paymentMethod,
        callTranscript: order.callTranscript,
        callRecordingUrl: order.callRecordingUrl,
        dedupeFingerprint,
        idempotencyKey,
        createdAt: new Date().toISOString(),
      };
      this.orders.push(created);
      if (order.customerId) {
        const customer = this.customers.get(order.customerId);
        if (customer) this.customers.set(customer.id, { ...customer, orderCount: customer.orderCount + 1 });
      }
      return created;
    });
  }

  async createCallbackRequest(input: CallbackRequestInput): Promise<CallbackRequest> {
    const created: CallbackRequest = { ...input, id: randomUUID(), resolved: false, createdAt: new Date().toISOString() };
    this.callbackRequests.push(created);
    return created;
  }

  async consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const key = `${scope}:${actorHash}`;
    const now = Date.now();
    const existing = this.rateLimits.get(key);
    if (!existing || now - existing.windowStartedAt >= windowSeconds * 1000) {
      this.rateLimits.set(key, { windowStartedAt: now, requestCount: 1 });
      return 1 <= maxRequests;
    }
    existing.requestCount += 1;
    return existing.requestCount <= maxRequests;
  }

  async resolveOrganizationByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    return this.phoneNumberIdToOrg.get(phoneNumberId) ?? null;
  }

  async claimWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string): Promise<boolean> {
    return this.whatsappLock.run(`event:${messageId}`, async () => {
      const existing = this.whatsappEvents.get(messageId);
      const now = Date.now();
      if (!existing) {
        this.whatsappEvents.set(messageId, { status: "processing", attempts: 1, claimedAt: now });
        return true;
      }
      const reclaimable = existing.status === "failed" || (existing.status === "processing" && now - existing.claimedAt > 5 * 60 * 1000);
      if (!reclaimable) return false;
      existing.status = "processing";
      existing.attempts += 1;
      existing.claimedAt = now;
      return true;
    });
  }

  async claimWhatsAppConversation(organizationId: string, phoneHash: string, messageId: string, leaseSeconds: number): Promise<boolean> {
    const key = `${organizationId}:${phoneHash}`;
    return this.whatsappLock.run(`lease:${key}`, async () => {
      const now = Date.now();
      const existing = this.whatsappLeases.get(key);
      if (existing && existing.lockedUntil >= now) return false;
      this.whatsappLeases.set(key, { ownerMessageId: messageId, lockedUntil: now + leaseSeconds * 1000 });
      return true;
    });
  }

  async appendWhatsAppUserMessageOnce(organizationId: string, phone: string, message: ConversationMessage): Promise<readonly ConversationMessage[]> {
    return this.whatsappAppendTurn(organizationId, phone, [message], null, null, null);
  }

  async whatsappAppendTurn(
    organizationId: string,
    phone: string,
    newMessages: readonly ConversationMessage[],
    status: "active" | "completed" | "abandoned" | null,
    orderId: string | null,
    propertyId: string | null,
  ): Promise<readonly ConversationMessage[]> {
    const key = `${organizationId}:${phone}`;
    // Serializado por (organizationId, phone) — equivalente en memoria del row lock
    // de Postgres que serializa `messages = messages || nuevos`: mensajes
    // casi-simultáneos del mismo teléfono nunca se pisan entre sí.
    return this.whatsappLock.run(`conv:${key}`, async () => {
      const existing = this.whatsappConversations.get(key) ?? { messages: [], status: "active" as const, orderId: null, propertyId: null };
      const updated: StoredConversation = {
        messages: [...existing.messages, ...newMessages],
        status: status ?? existing.status,
        orderId: orderId ?? existing.orderId,
        propertyId: propertyId ?? existing.propertyId,
      };
      this.whatsappConversations.set(key, updated);
      return updated.messages;
    });
  }

  async finishWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string, status: "processed" | "failed", errorClass: string | null): Promise<void> {
    const event = this.whatsappEvents.get(messageId);
    if (event) {
      event.status = status;
    }
    const leaseKey = `${organizationId}:${phoneHash}`;
    const lease = this.whatsappLeases.get(leaseKey);
    if (lease && lease.ownerMessageId === messageId) this.whatsappLeases.delete(leaseKey);
    void errorClass;
  }

  async markInboundEventFailed(organizationId: string, messageId: string, errorClass: string): Promise<void> {
    void organizationId;
    void errorClass;
    const event = this.whatsappEvents.get(messageId);
    if (event) event.status = "failed";
  }
}
