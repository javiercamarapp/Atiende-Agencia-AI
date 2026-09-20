// InMemoryRestaurantesRepository — implementación real (no un mock) de
// `RestaurantesRepository`, con las mismas restricciones de integridad e idempotencia
// que las migraciones SQL de migrations/001-004 (UNIQUE(organization_id, phone),
// serialización tipo pg_advisory_xact_lock, dedupe de mensajes de WhatsApp, leases de
// conversación). Sirve como fixture de seed para tests determinísticos y como
// fallback dev/CI sin Postgres real — mismo rol que InMemoryStateStore en
// @atiende/core-conversation.
import { randomUUID } from "node:crypto";
import { OrderConflictError } from "./errors.ts";
import { haversineKm, normalizeZoneText } from "./nearest-branch.ts";
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
  KnownZone,
  NearestBranchMatch,
  NewCategoryInput,
  NewKnownZoneInput,
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
  RestaurantesAuditLogRow,
  WhatsappChannelConfig,
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
  TierDistributionRow,
  TopCustomerRow,
  WhatsAppConversationStatsRow,
} from "./repository.ts";

// FASE 3 (producto) -- mismos límites que el CHECK de `restaurantes.audit_log`
// (ver migrations/019_restaurantes_audit_log.sql) -- mismo criterio EXACTO que
// `InMemoryRentasRepository` (@atiende/domain-rentas, ver el comentario dentro
// de `registrarAuditoria` de abajo).
const AUDIT_LOG_CAMPO_MAX = 200;
const AUDIT_LOG_TEXTO_MAX = 500;

function truncarCampoAuditoriaRestaurantes(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Percentil "mid-rank" con empates promediados (0-100) — mismo método que
 * `restaurantes.calc_customer_tier` (migrations/002) y que `calcularPercentiles` de
 * `ClientesSection.tsx` del origen. Factorizado una sola vez para que
 * `calcCustomerTier` (un cliente) y `getCustomerTierDistribution` (todos, agregados)
 * nunca puedan divergir en la fórmula. n=1 -> 100 (es, por definición, el mejor de un
 * universo de uno). */
function computeMidRankPercentiles<T>(items: readonly T[], valueOf: (item: T) => number): Map<T, number> {
  const n = items.length;
  const result = new Map<T, number>();
  if (n === 0) return result;
  const sorted = [...items].sort((a, b) => valueOf(a) - valueOf(b));
  if (n === 1) {
    result.set(sorted[0]!, 100);
    return result;
  }
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && valueOf(sorted[end + 1]!) === valueOf(sorted[index]!)) end += 1;
    const rankMin = index; // 0-based, igual que (rank() - 1) del SQL
    const tieCount = end - index + 1;
    const percentil = ((rankMin + rankMin + tieCount - 1) / 2 / (n - 1)) * 100;
    for (let i = index; i <= end; i += 1) result.set(sorted[i]!, percentil);
    index = end + 1;
  }
  return result;
}

/** Cortes 95/90/70 (corregidos en Fase 3 — ver comentario en migrations/002). */
/** Slugify mínimo para el default de `seedCategory`/fixtures viejos que nunca
 * pasaron un slug explícito — la ruta HTTP real de creación (admin-catalog.ts)
 * SIEMPRE exige un slug explícito del caller, esto es solo para no romper fixtures
 * preexistentes de otras fases. */
function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tierFromPercentile(percentil: number): CustomerTier {
  if (percentil >= 95) return "BLACK";
  if (percentil >= 90) return "PLATINUM";
  if (percentil >= 70) return "GOLD";
  return "BLUE";
}

/** Selección de métrica real de tier: gasto si al menos 30% de los clientes tiene
 * gasto>0 (señal suficientemente representativa), si no frecuencia (order_count),
 * si tampoco eso hay señal real -> sin_datos. Mismo criterio que
 * `restaurantes.calc_customer_tier` y `ClientesSection.tsx` del origen. */
function chooseTierMetric(clientes: readonly Customer[], gastoPorCliente: ReadonlyMap<string, number>): "gasto" | "frecuencia" | "sin_datos" {
  const n = clientes.length;
  if (n === 0) return "sin_datos";
  const conGasto = clientes.filter((c) => (gastoPorCliente.get(c.id) ?? 0) > 0).length;
  if (conGasto >= Math.max(1, Math.ceil(n * 0.3))) return "gasto";
  const conFrecuencia = clientes.filter((c) => c.orderCount > 0).length;
  if (conFrecuencia > 0) return "frecuencia";
  return "sin_datos";
}

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

type StoredBranch = Branch;

interface StoredCategory {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  displayOrder: number;
}

interface StoredProduct {
  id: string;
  organizationId: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  searchKeywords: readonly string[];
  price: number;
  imageUrl: string | null;
  isPopular: boolean;
  isAvailable: boolean;
  displayOrder: number;
}

interface StoredBranchProduct {
  readonly propertyId: string;
  readonly productId: string;
  price: number;
  isAvailable: boolean;
}

type StoredPromotion = Promotion;

type StoredOrder = Order;

interface StoredKnownZone {
  /** Opcional en `seedKnownZone` (fixtures de Fase 2 ya existentes nunca lo pasan)
   *  -- generado con `randomUUID()` si se omite, mismo criterio que el resto de
   *  `seed*` de esta clase. Requerido para `listKnownZones`/`deleteKnownZone`
   *  (Fase 3, ver `repository.ts`). */
  readonly id?: string;
  readonly organizationId: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly createdAt?: string;
}

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

/** Espejo en memoria de `restaurantes.messaging_outbox` (migrations/007) — mismo
 * idioma de claim-con-lease-reclamable que `StoredWhatsAppEvent`/`StoredLease`. */
interface InMemoryOutboxRow {
  id: string;
  organizationId: string;
  channel: "whatsapp" | "email";
  eventType: string;
  dedupeKey: string;
  payload: unknown;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
  claimedAt: number | null;
  nextAttemptAt: number;
  lastErrorClass: string | null;
}

export class InMemoryRestaurantesRepository implements RestaurantesRepository {
  private readonly organizations = new Map<string, StoredOrganization>();
  private readonly organizationIdBySlug = new Map<string, string>();
  private readonly branches = new Map<string, StoredBranch>();
  private readonly categories = new Map<string, StoredCategory>();
  private readonly products = new Map<string, StoredProduct>();
  private readonly branchProducts: StoredBranchProduct[] = [];
  private readonly promotions = new Map<string, StoredPromotion>();
  private readonly customers = new Map<string, Customer>();
  private readonly customerIdByOrgPhone = new Map<string, string>();
  private readonly addresses = new Map<string, CustomerAddress[]>();
  private readonly orders: StoredOrder[] = [];
  private readonly knownZones: StoredKnownZone[] = [];
  private readonly callbackRequests: CallbackRequest[] = [];
  private readonly rateLimits = new Map<string, { windowStartedAt: number; requestCount: number }>();
  private readonly phoneNumberIdToOrg = new Map<string, string>();
  private readonly whatsappEvents = new Map<string, StoredWhatsAppEvent>();
  private readonly whatsappLeases = new Map<string, StoredLease>();
  private readonly whatsappConversations = new Map<string, StoredConversation>();
  private readonly outbox = new Map<string, InMemoryOutboxRow>();
  private readonly staffOrderNotifications = new Map<string, StaffOrderNotificationRecord>();

  // ---- FASE 3 (producto) -- bitácora de auditoría del staff ----
  /** Expuesto también como referencia tipada directa (mismo criterio que
   *  `InMemoryRentasRepository.auditLog`) para que un test pueda inspeccionar lo
   *  que quedó registrado sin depender de `listAuditoria`. */
  readonly auditLog: (RestaurantesAuditLogRow & { readonly organizationId: string; readonly seq: number })[] = [];
  /** Desempate monótono, EQUIVALENTE en memoria a la columna `seq bigint
   *  generated always as identity` de Postgres (ver migrations/
   *  019_restaurantes_audit_log.sql) -- `Date.now()` (usado como `createdAtMs`
   *  abajo) tiene resolución de milisegundo, dos escrituras dentro del mismo
   *  milisegundo empatarían sin este desempate. Empieza en 0 y solo avanza. */
  private auditLogSeq = 0;

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

  // `slug`/`displayOrder` (category) y `price`/`imageUrl`/`isPopular`/`isAvailable`/
  // `displayOrder` (product) son opcionales aquí con default — Fase 5 los agregó
  // para el CRUD real de administración, pero decenas de fixtures YA existentes de
  // Fase 1-4 (búsqueda/cotización de pedidos) siembran categorías/productos sin
  // ellos: exigirlos habría roto esos tests sin ganar nada (esos flujos nunca leen
  // slug/precio-base/displayOrder, solo name/description/categoryId/searchKeywords).
  seedCategory(category: { id: string; organizationId: string; name: string; slug?: string; displayOrder?: number }): void {
    this.categories.set(category.id, { id: category.id, organizationId: category.organizationId, name: category.name, slug: category.slug ?? slugify(category.name), displayOrder: category.displayOrder ?? 0 });
  }

  seedProduct(product: {
    id: string;
    organizationId: string;
    categoryId: string | null;
    name: string;
    description: string | null;
    searchKeywords: readonly string[];
    price?: number;
    imageUrl?: string | null;
    isPopular?: boolean;
    isAvailable?: boolean;
    displayOrder?: number;
  }): void {
    this.products.set(product.id, {
      id: product.id,
      organizationId: product.organizationId,
      categoryId: product.categoryId,
      name: product.name,
      description: product.description,
      searchKeywords: product.searchKeywords,
      price: product.price ?? 0,
      imageUrl: product.imageUrl ?? null,
      isPopular: product.isPopular ?? false,
      isAvailable: product.isAvailable ?? true,
      displayOrder: product.displayOrder ?? 0,
    });
  }

  seedBranchProduct(entry: StoredBranchProduct): void {
    this.branchProducts.push({ ...entry });
  }

  seedWhatsAppChannel(organizationId: string, phoneNumberId: string): void {
    this.phoneNumberIdToOrg.set(phoneNumberId, organizationId);
  }

  /** Equivalente en memoria de `insert into restaurantes.known_zone(...)`
   * (ver migrations/005) — una zona conocida (colonia/plaza/referencia) con
   * sus coordenadas reales, sembrada por organización. */
  seedKnownZone(zone: StoredKnownZone): void {
    this.knownZones.push({ id: zone.id ?? randomUUID(), createdAt: zone.createdAt ?? new Date().toISOString(), ...zone });
  }

  /** Fase 3 — inserta un pedido YA en el estado/canal/fecha que el test necesita,
   * sin pasar por `createOrderIdempotent` (que siempre crea en `status: "pending"` y
   * `createdAt: now()` — no hay todavía, en ninguna fase, un caso de negocio que
   * transicione el estado de un pedido o le fije una fecha pasada). Necesario para
   * probar KPIs de canal/tendencia/tier con datos reales de "completado"/"cancelado"
   * y de fechas distintas a "ahora" — mismo rol que los demás `seed*` de esta clase
   * (fixture determinístico, nunca código de producción). También actualiza
   * `customer.orderCount` cuando `customerId` viene dado, para que
   * getCustomerOverviewKpis/getCustomerTierDistribution vean un conteo consistente. */
  seedOrder(order: Order): void {
    this.orders.push(order);
    if (order.customerId) {
      const customer = this.customers.get(order.customerId);
      if (customer) this.customers.set(customer.id, { ...customer, orderCount: customer.orderCount + 1 });
    }
  }

  /** Fase 3 — inserta un cliente ya con `orderCount` fijo (para tests de tier/
   * recurrencia que necesitan una base de clientes sin pasar 1 a 1 por
   * `upsertCustomer` + N pedidos reales cuando solo el conteo importa). */
  seedCustomer(customer: Customer): void {
    this.customers.set(customer.id, customer);
    this.customerIdByOrgPhone.set(`${customer.organizationId}:${customer.phone}`, customer.id);
  }

  /** Fase 3 — conversación de WhatsApp ya resuelta (para whatsapp_conversation_stats:
   * total/withOrder/averageMessages), sin pasar por el flujo real de mensajería. */
  seedWhatsAppConversation(organizationId: string, phone: string, conversation: { messages: ConversationMessage[]; status: "active" | "completed" | "abandoned"; orderId: string | null; propertyId: string | null }): void {
    this.whatsappConversations.set(`${organizationId}:${phone}`, conversation);
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

  async listBranchesForOrganization(organizationId: string): Promise<readonly BranchSummary[]> {
    const result: BranchSummary[] = [];
    for (const branch of this.branches.values()) {
      if (branch.organizationId !== organizationId || branch.status !== "active") continue;
      result.push({ propertyId: branch.propertyId, name: branch.name, slug: branch.slug, address: branch.address });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name, "es-MX"));
  }

  async findNearestBranchByColonia(organizationId: string, colonia: string): Promise<NearestBranchMatch | null> {
    // Mismo criterio de desempate que la SQL del origen: `order by
    // length(nombre) desc limit 1` — entre dos zonas conocidas que matchean,
    // gana la de nombre más largo/específico (p.ej. "Plaza Las Américas"
    // sobre "Américas" si ambas matchearan).
    const inputNorm = normalizeZoneText(colonia);
    let bestZone: StoredKnownZone | null = null;
    for (const zone of this.knownZones) {
      if (zone.organizationId !== organizationId) continue;
      const zoneNorm = normalizeZoneText(zone.name);
      if (!zoneNorm) continue;
      if (inputNorm.includes(zoneNorm) || zoneNorm.includes(inputNorm)) {
        if (!bestZone || zone.name.length > bestZone.name.length) bestZone = zone;
      }
    }
    if (!bestZone) return null; // cero-match real: nunca se inventa una sucursal.

    let nearestBranch: Branch | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const branch of this.branches.values()) {
      if (branch.organizationId !== organizationId || branch.status !== "active") continue;
      if (branch.lat === null || branch.lng === null) continue;
      const distance = haversineKm(bestZone.lat, bestZone.lng, branch.lat, branch.lng);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestBranch = branch;
      }
    }
    if (!nearestBranch) return null;
    return { branch: nearestBranch, distanceKm: nearestDistance, recognizedZoneName: bestZone.name };
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
    // criterio de selección de métrica y mismos cortes de percentil "mid-rank"
    // (factorizados en computeMidRankPercentiles/chooseTierMetric/tierFromPercentile,
    // compartidos con getCustomerTierDistribution para no divergir).
    const clientes = [...this.customers.values()].filter((c) => c.organizationId === organizationId);
    if (clientes.length === 0) return null;
    const gastoPorCliente = this.gastoPorClienteDeOrganizacion(organizationId);
    const metrica = chooseTierMetric(clientes, gastoPorCliente);
    if (metrica === "sin_datos") return null;

    const valueOf = (c: Customer) => (metrica === "gasto" ? (gastoPorCliente.get(c.id) ?? 0) : c.orderCount);
    const percentiles = computeMidRankPercentiles(clientes, valueOf);
    const target = clientes.find((c) => c.id === customerId);
    if (!target) return null;
    const percentil = percentiles.get(target);
    if (percentil === undefined) return null;
    return tierFromPercentile(percentil);
  }

  /** Suma de `orders.total` por `customer_id` dentro de la organización — compartido
   * entre calcCustomerTier (un cliente) y getCustomerTierDistribution (todos). */
  private gastoPorClienteDeOrganizacion(organizationId: string): Map<string, number> {
    const gastoPorCliente = new Map<string, number>();
    for (const o of this.orders) {
      if (o.organizationId !== organizationId || !o.customerId) continue;
      gastoPorCliente.set(o.customerId, (gastoPorCliente.get(o.customerId) ?? 0) + o.total);
    }
    return gastoPorCliente;
  }

  // ---- KPIs de admin (Fase 3) ----

  async getSalesBucketedStats(organizationId: string, propertyIds: readonly string[] | null, buckets: readonly KpiDateRange[]): Promise<readonly SalesBucketRow[]> {
    const scope = propertyIds ? new Set(propertyIds) : null;
    return buckets.map((bucket) => {
      const startMs = bucket.start.getTime();
      const endMs = bucket.end.getTime();
      const enRango = this.orders.filter((o) => {
        if (o.organizationId !== organizationId) return false;
        if (scope !== null && !scope.has(o.propertyId)) return false;
        const createdMs = Date.parse(o.createdAt);
        return createdMs >= startMs && createdMs < endMs;
      });
      const revenue = enRango.reduce((sum, o) => sum + o.total, 0);
      const customerCount = new Set(enRango.map((o) => o.customerName)).size;
      return { revenue, orderCount: enRango.length, customerCount };
    });
  }

  async getFirstOrderCreatedAt(organizationId: string, propertyIds: readonly string[] | null): Promise<Date | null> {
    const scope = propertyIds ? new Set(propertyIds) : null;
    let earliest: number | null = null;
    for (const o of this.orders) {
      if (o.organizationId !== organizationId) continue;
      if (scope !== null && !scope.has(o.propertyId)) continue;
      const ts = Date.parse(o.createdAt);
      if (earliest === null || ts < earliest) earliest = ts;
    }
    return earliest === null ? null : new Date(earliest);
  }

  async getChannelStats(organizationId: string, propertyIds: readonly string[] | null): Promise<ChannelStatsRow> {
    const scope = propertyIds ? new Set(propertyIds) : null;
    const relevantes = this.orders.filter((o) => o.organizationId === organizationId && (scope === null || scope.has(o.propertyId)));
    const porCanal = (source: "voice" | "whatsapp") => {
      const list = relevantes.filter((o) => o.source === source);
      return {
        orders: list.length,
        completed: list.filter((o) => o.status === "completado" || o.status === "entregado").length,
        cancelled: list.filter((o) => o.status === "cancelado").length,
        revenue: list.reduce((sum, o) => sum + o.total, 0),
      };
    };
    return {
      totalOrders: relevantes.length,
      totalRevenue: relevantes.reduce((sum, o) => sum + o.total, 0),
      voice: porCanal("voice"),
      whatsapp: porCanal("whatsapp"),
    };
  }

  async getWhatsappConversationStats(organizationId: string, propertyIds: readonly string[] | null): Promise<WhatsAppConversationStatsRow> {
    const scope = propertyIds ? new Set(propertyIds) : null;
    let total = 0;
    let withOrder = 0;
    let sumMessages = 0;
    const prefix = `${organizationId}:`;
    for (const [key, conv] of this.whatsappConversations) {
      if (!key.startsWith(prefix)) continue;
      if (scope !== null && (conv.propertyId === null || !scope.has(conv.propertyId))) continue;
      total += 1;
      if (conv.orderId) withOrder += 1;
      sumMessages += conv.messages.length;
    }
    return { total, withOrder, averageMessages: total > 0 ? sumMessages / total : 0 };
  }

  async getCustomerOverviewKpis(organizationId: string): Promise<CustomerOverviewRow> {
    const clientes = [...this.customers.values()].filter((c) => c.organizationId === organizationId);
    const ordenesOrg = this.orders.filter((o) => o.organizationId === organizationId);

    const averageOrderValue = ordenesOrg.length > 0 ? ordenesOrg.reduce((sum, o) => sum + o.total, 0) / ordenesOrg.length : null;
    const customersWithOrders = clientes.filter((c) => c.orderCount > 0).length;
    const recurringCustomers = clientes.filter((c) => c.orderCount > 1).length;

    // Empates: gana el cliente creado MÁS RECIENTEMENTE (mismo criterio que
    // ClientesSection.tsx, que itera su lista `created_at desc` con comparación
    // estricta `>` — aquí se itera en orden de creación ascendente con `>=`, que
    // produce el mismo resultado: el último visto de un empate es el más reciente).
    let topCustomer: TopCustomerRow | null = null;
    for (const c of clientes) {
      if (c.orderCount <= 0) continue;
      if (!topCustomer || c.orderCount >= topCustomer.orderCount) {
        topCustomer = { id: c.id, name: c.name, phone: c.phone, orderCount: c.orderCount };
      }
    }

    // avgDaysSinceLastOrder se calcula desde `orders.created_at` (max por cliente),
    // no desde una columna `customers.last_order_at` — esta última existe en el
    // schema SQL (migrations/001) pero ningún caso de negocio la escribe todavía
    // (gap real preexistente, fuera de alcance de Fase 3 arreglar la escritura);
    // calcularlo desde `orders` da el mismo resultado sin depender de una columna
    // que nadie mantiene.
    const ultimoPedidoPorCliente = new Map<string, number>();
    for (const o of ordenesOrg) {
      if (!o.customerId) continue;
      const ts = Date.parse(o.createdAt);
      const actual = ultimoPedidoPorCliente.get(o.customerId);
      if (actual === undefined || ts > actual) ultimoPedidoPorCliente.set(o.customerId, ts);
    }
    const dias = [...ultimoPedidoPorCliente.values()].map((ts) => Math.max(0, Math.floor((Date.now() - ts) / 86_400_000)));
    const avgDaysSinceLastOrder = dias.length > 0 ? dias.reduce((sum, d) => sum + d, 0) / dias.length : null;

    return {
      totalCustomers: clientes.length,
      averageOrderValue,
      customersWithOrders,
      recurringCustomers,
      topCustomer,
      avgDaysSinceLastOrder,
    };
  }

  async getCustomerTierDistribution(organizationId: string): Promise<TierDistributionRow> {
    const clientes = [...this.customers.values()].filter((c) => c.organizationId === organizationId);
    const n = clientes.length;
    if (n === 0) return { metric: "sin_datos", black: 0, platinum: 0, gold: 0, blue: 0, withoutTier: 0 };

    const gastoPorCliente = this.gastoPorClienteDeOrganizacion(organizationId);
    const metrica = chooseTierMetric(clientes, gastoPorCliente);
    if (metrica === "sin_datos") return { metric: "sin_datos", black: 0, platinum: 0, gold: 0, blue: 0, withoutTier: n };

    const valueOf = (c: Customer) => (metrica === "gasto" ? (gastoPorCliente.get(c.id) ?? 0) : c.orderCount);
    const percentiles = computeMidRankPercentiles(clientes, valueOf);
    const distribucion = { black: 0, platinum: 0, gold: 0, blue: 0 };
    for (const c of clientes) {
      const percentil = percentiles.get(c);
      if (percentil === undefined) continue; // no debería ocurrir: todo cliente recibe percentil cuando metrica !== sin_datos
      switch (tierFromPercentile(percentil)) {
        case "BLACK":
          distribucion.black += 1;
          break;
        case "PLATINUM":
          distribucion.platinum += 1;
          break;
        case "GOLD":
          distribucion.gold += 1;
          break;
        case "BLUE":
          distribucion.blue += 1;
          break;
      }
    }
    return { metric: metrica, ...distribucion, withoutTier: 0 };
  }

  async createOrderIdempotent(order: NewOrderRecord, dedupeFingerprint: string, idempotencyKey: string | null): Promise<Order> {
    return this.orderLock.run(`${order.organizationId}:${idempotencyKey ?? dedupeFingerprint}`, async () => {
      if (idempotencyKey) {
        const existing = this.orders.find((o) => o.organizationId === order.organizationId && o.idempotencyKey === idempotencyKey);
        if (existing) {
          // Misma llave, contenido DISTINTO (fingerprint no coincide) -> no es un
          // reintento real, es un pedido materialmente diferente reusando la llave:
          // conflicto real, nunca se devuelve el pedido viejo en silencio (mismo
          // comportamiento que 20260904070000_order_idempotency_conflict.sql, PT409).
          if (existing.dedupeFingerprint !== dedupeFingerprint) {
            throw new OrderConflictError("idempotency key was already used with a different order payload");
          }
          return existing;
        }
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
        customerEmail: order.customerEmail,
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
        assignedRepartidorId: null,
        estimatedDeliveryAt: null,
        incidentNote: null,
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

  // Fase 9 — sentido SALIENTE del mismo índice `phoneNumberIdToOrg` que ya siembra
  // `seedWhatsAppChannel` (ver comentario de `resolveActiveWhatsAppPhoneNumberId` en
  // repository.ts): un solo `phone_number_id` por organización (PK real de
  // `restaurantes.whatsapp_channel_config`, migrations/001), así que basta con
  // recorrer el mismo mapa buscando el organizationId — nunca hace falta un índice
  // separado.
  async resolveActiveWhatsAppPhoneNumberId(organizationId: string): Promise<string | null> {
    for (const [phoneNumberId, orgId] of this.phoneNumberIdToOrg) {
      if (orgId === organizationId) return phoneNumberId;
    }
    return null;
  }

  async claimWhatsAppMessage(organizationId: string, messageId: string, _phoneHash: string): Promise<boolean> {
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

  // No-op real: sin una transacción/conexión Postgres real que proteger, no hay
  // nada que aislar con un SAVEPOINT -- ver el comentario de cabecera de
  // `runWithRowSavepoint` en `repository.ts`. `fn` corre directo y su error (si lo
  // hay) se repropaga tal cual, mismo comportamiento observable que tendría un
  // SAVEPOINT+ROLLBACK TO SAVEPOINT real desde el punto de vista del caller.
  async runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  // ---- Dispatcher real de messaging_outbox (migrations/007) ----

  getOutbox(): readonly InMemoryOutboxRow[] {
    return [...this.outbox.values()];
  }

  async enqueueMessagingOutbox(organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    const existing = [...this.outbox.values()].find((o) => o.organizationId === organizationId && o.channel === channel && o.dedupeKey === dedupeKey);
    if (existing) {
      if (existing.status === "pending" || existing.status === "failed") {
        existing.eventType = eventType;
        existing.payload = payload;
      }
      return;
    }
    const id = randomUUID();
    this.outbox.set(id, { id, organizationId, channel, eventType, dedupeKey, payload, status: "pending", attempts: 0, claimedAt: null, nextAttemptAt: 0, lastErrorClass: null });
  }

  async claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]> {
    const now = Date.now();
    const eligible = [...this.outbox.values()]
      .filter(
        (o) =>
          o.channel === "whatsapp" &&
          ((o.status === "pending" && o.nextAttemptAt <= now) || (o.status === "processing" && (o.claimedAt ?? 0) < now - leaseSeconds * 1000)),
      )
      .slice(0, limit);
    for (const row of eligible) {
      row.status = "processing";
      row.claimedAt = now;
    }
    return eligible.map((row) => ({ id: row.id, attempts: row.attempts, payload: row.payload }));
  }

  async markMessagingOutboxSent(id: string): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "sent";
  }

  async markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "pending";
    row.attempts = attempts;
    row.lastErrorClass = errorClass.slice(0, 120);
    row.nextAttemptAt = Date.parse(nextAttemptAtIso);
    row.claimedAt = null;
  }

  async markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "dead";
    row.attempts = attempts;
    row.lastErrorClass = errorClass.slice(0, 120);
    row.claimedAt = null;
  }

  // ---- Dispatcher real de correo (migrations/011_email_outbox_dispatch.sql) —
  // acotado a channel='email' del MISMO outbox de arriba, mismo criterio exacto
  // que restaurantes.claim_email_outbox_batch/complete_email_outbox_job. ----

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    // Iteración en orden de inserción del Map (equivalente en memoria de `order by
    // created_at asc` — mismo criterio que claimMessagingOutboxBatch de arriba,
    // que tampoco ordena explícitamente por la misma razón).
    const eligible = [...this.outbox.values()]
      .filter((o) => o.channel === "email" && (o.status === "pending" || o.status === "failed") && o.attempts < 5)
      .slice(0, Math.max(limit, 0));
    for (const row of eligible) {
      row.status = "processing";
      row.attempts += 1;
    }
    return eligible.map((row) => ({ id: row.id, organizationId: row.organizationId, attempts: row.attempts, payload: (row.payload ?? {}) as Record<string, unknown> }));
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.channel !== "email") return;
    row.status = status;
    row.lastErrorClass = error ? error.slice(0, 120) : null;
  }

  // ---- Fase 9 — bandeja de notificaciones internas al staff (ver
  // order-notifications.ts, migrations/009_order_notifications.sql) ----

  getStaffOrderNotifications(): readonly StaffOrderNotificationRecord[] {
    return [...this.staffOrderNotifications.values()];
  }

  async createStaffOrderNotification(
    organizationId: string,
    propertyId: string,
    orderId: string,
    eventType: StaffOrderNotificationEventType,
    message: string,
  ): Promise<StaffOrderNotificationRecord> {
    // Idempotente por (organizationId, orderId, eventType) — mismo criterio que
    // `enqueue_messaging_outbox` (ON CONFLICT DO NOTHING real, ver migrations/009):
    // un reintento real del mismo evento nunca duplica la fila, siempre devuelve la
    // ya existente.
    const existing = [...this.staffOrderNotifications.values()].find((n) => n.organizationId === organizationId && n.orderId === orderId && n.eventType === eventType);
    if (existing) return existing;
    const record: StaffOrderNotificationRecord = {
      id: randomUUID(),
      organizationId,
      propertyId,
      orderId,
      eventType,
      message,
      createdAt: new Date().toISOString(),
      acknowledgedAt: null,
      acknowledgedBy: null,
    };
    this.staffOrderNotifications.set(record.id, record);
    return record;
  }

  async listStaffOrderNotifications(
    organizationId: string,
    propertyIds: readonly string[] | null,
    options?: { readonly unacknowledgedOnly?: boolean; readonly limit?: number },
  ): Promise<readonly StaffOrderNotificationRecord[]> {
    const limit = options?.limit ?? 50;
    return [...this.staffOrderNotifications.values()]
      .filter((n) => n.organizationId === organizationId)
      .filter((n) => propertyIds === null || propertyIds.includes(n.propertyId))
      .filter((n) => !options?.unacknowledgedOnly || n.acknowledgedAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async acknowledgeStaffOrderNotification(organizationId: string, notificationId: string, actorId: string): Promise<StaffOrderNotificationRecord> {
    const existing = this.staffOrderNotifications.get(notificationId);
    if (!existing || existing.organizationId !== organizationId) {
      throw new Error(`Notificación "${notificationId}" no encontrada para la organización "${organizationId}".`);
    }
    const updated: StaffOrderNotificationRecord = { ...existing, acknowledgedAt: new Date().toISOString(), acknowledgedBy: actorId };
    this.staffOrderNotifications.set(notificationId, updated);
    return updated;
  }

  // ---- Fase 5 — back-office CORE (ver diseño §1) ----

  async findBranchById(organizationId: string, propertyId: string): Promise<Branch | null> {
    const branch = this.branches.get(propertyId);
    return branch && branch.organizationId === organizationId ? branch : null;
  }

  async listBranchesForOrganizationAdmin(organizationId: string): Promise<readonly Branch[]> {
    return [...this.branches.values()].filter((b) => b.organizationId === organizationId).sort((a, b) => a.name.localeCompare(b.name, "es-MX"));
  }

  async updateBranchDetail(
    organizationId: string,
    propertyId: string,
    patch: { readonly phone?: string | null; readonly address?: string | null; readonly lat?: number | null; readonly lng?: number | null; readonly slug?: string; readonly displayOrder?: number },
  ): Promise<Branch | null> {
    void patch.displayOrder; // no modelado en `StoredBranch` (equivalente en memoria de branch_detail.display_order) — solo afecta orden de listado, no hay caso de prueba que lo requiera todavía.
    const existing = this.branches.get(propertyId);
    if (!existing || existing.organizationId !== organizationId) return null;
    const updated: Branch = {
      ...existing,
      phone: patch.phone !== undefined ? patch.phone : existing.phone,
      address: patch.address !== undefined ? patch.address : existing.address,
      lat: patch.lat !== undefined ? patch.lat : existing.lat,
      lng: patch.lng !== undefined ? patch.lng : existing.lng,
      slug: patch.slug !== undefined ? patch.slug : existing.slug,
    };
    this.branches.set(propertyId, updated);
    return updated;
  }

  async listCategories(organizationId: string): Promise<readonly Category[]> {
    return [...this.categories.values()]
      .filter((c) => c.organizationId === organizationId)
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, "es-MX"))
      .map((c) => ({ ...c }));
  }

  async createCategory(organizationId: string, input: NewCategoryInput): Promise<Category> {
    const created: StoredCategory = { id: randomUUID(), organizationId, name: input.name, slug: input.slug, displayOrder: input.displayOrder ?? 0 };
    this.categories.set(created.id, created);
    return { ...created };
  }

  async updateCategory(organizationId: string, categoryId: string, patch: CategoryPatch): Promise<Category | null> {
    const existing = this.categories.get(categoryId);
    if (!existing || existing.organizationId !== organizationId) return null;
    const updated: StoredCategory = {
      ...existing,
      name: patch.name ?? existing.name,
      slug: patch.slug ?? existing.slug,
      displayOrder: patch.displayOrder ?? existing.displayOrder,
    };
    this.categories.set(categoryId, updated);
    return { ...updated };
  }

  private toProduct(stored: StoredProduct): Product {
    const category = stored.categoryId ? this.categories.get(stored.categoryId) : undefined;
    return {
      id: stored.id,
      organizationId: stored.organizationId,
      categoryId: stored.categoryId,
      categoryName: category?.name ?? null,
      name: stored.name,
      description: stored.description,
      price: stored.price,
      imageUrl: stored.imageUrl,
      isPopular: stored.isPopular,
      isAvailable: stored.isAvailable,
      displayOrder: stored.displayOrder,
      searchKeywords: stored.searchKeywords,
    };
  }

  async listProducts(organizationId: string): Promise<readonly Product[]> {
    return [...this.products.values()]
      .filter((p) => p.organizationId === organizationId)
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, "es-MX"))
      .map((p) => this.toProduct(p));
  }

  async findProduct(organizationId: string, productId: string): Promise<Product | null> {
    const product = this.products.get(productId);
    return product && product.organizationId === organizationId ? this.toProduct(product) : null;
  }

  async createProduct(organizationId: string, input: NewProductInput): Promise<Product> {
    const created: StoredProduct = {
      id: randomUUID(),
      organizationId,
      categoryId: input.categoryId ?? null,
      name: input.name,
      description: input.description ?? null,
      searchKeywords: input.searchKeywords ?? [],
      price: input.price,
      imageUrl: input.imageUrl ?? null,
      isPopular: input.isPopular ?? false,
      isAvailable: input.isAvailable ?? true,
      displayOrder: input.displayOrder ?? 0,
    };
    this.products.set(created.id, created);
    return this.toProduct(created);
  }

  async updateProduct(organizationId: string, productId: string, patch: ProductPatch): Promise<Product | null> {
    const existing = this.products.get(productId);
    if (!existing || existing.organizationId !== organizationId) return null;
    const updated: StoredProduct = {
      ...existing,
      categoryId: patch.categoryId !== undefined ? patch.categoryId : existing.categoryId,
      name: patch.name ?? existing.name,
      description: patch.description !== undefined ? patch.description : existing.description,
      price: patch.price ?? existing.price,
      imageUrl: patch.imageUrl !== undefined ? patch.imageUrl : existing.imageUrl,
      isPopular: patch.isPopular ?? existing.isPopular,
      isAvailable: patch.isAvailable ?? existing.isAvailable,
      displayOrder: patch.displayOrder ?? existing.displayOrder,
      searchKeywords: patch.searchKeywords ?? existing.searchKeywords,
    };
    this.products.set(productId, updated);
    return this.toProduct(updated);
  }

  // ---- Fase 11 — promociones/marketing (ver promotions.ts, repository.ts) ----

  async listPromotions(organizationId: string): Promise<readonly Promotion[]> {
    return [...this.promotions.values()]
      .filter((p) => p.organizationId === organizationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => ({ ...p }));
  }

  async findPromotion(organizationId: string, promotionId: string): Promise<Promotion | null> {
    const promotion = this.promotions.get(promotionId);
    return promotion && promotion.organizationId === organizationId ? { ...promotion } : null;
  }

  async findPromotionByCode(organizationId: string, code: string): Promise<Promotion | null> {
    const found = [...this.promotions.values()].find((p) => p.organizationId === organizationId && p.code === code);
    return found ? { ...found } : null;
  }

  async createPromotion(organizationId: string, input: NewPromotionInput): Promise<Promotion> {
    const now = new Date().toISOString();
    const created: StoredPromotion = {
      id: randomUUID(),
      organizationId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      value: input.value,
      minOrderTotal: input.minOrderTotal ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      daysOfWeek: input.daysOfWeek ?? null,
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
      maxUses: input.maxUses ?? null,
      timesUsed: 0,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.promotions.set(created.id, created);
    return { ...created };
  }

  async updatePromotion(organizationId: string, promotionId: string, patch: PromotionPatch): Promise<Promotion | null> {
    const existing = this.promotions.get(promotionId);
    if (!existing || existing.organizationId !== organizationId) return null;
    const updated: StoredPromotion = {
      ...existing,
      code: patch.code ?? existing.code,
      name: patch.name ?? existing.name,
      description: patch.description !== undefined ? patch.description : existing.description,
      type: patch.type ?? existing.type,
      value: patch.value ?? existing.value,
      minOrderTotal: patch.minOrderTotal !== undefined ? patch.minOrderTotal : existing.minOrderTotal,
      startsAt: patch.startsAt !== undefined ? patch.startsAt : existing.startsAt,
      endsAt: patch.endsAt !== undefined ? patch.endsAt : existing.endsAt,
      daysOfWeek: patch.daysOfWeek !== undefined ? patch.daysOfWeek : existing.daysOfWeek,
      startTime: patch.startTime !== undefined ? patch.startTime : existing.startTime,
      endTime: patch.endTime !== undefined ? patch.endTime : existing.endTime,
      maxUses: patch.maxUses !== undefined ? patch.maxUses : existing.maxUses,
      isActive: patch.isActive ?? existing.isActive,
      updatedAt: new Date().toISOString(),
    };
    this.promotions.set(promotionId, updated);
    return { ...updated };
  }

  /** Mismo re-check atómico que exige el puerto (ver repository.ts) — en memoria el
   * "atómico" real es simplemente síncrono (JS de un solo hilo, sin await entre la
   * lectura y la escritura), equivalente al UPDATE...WHERE... de Postgres. */
  async incrementPromotionUses(organizationId: string, promotionId: string): Promise<boolean> {
    const existing = this.promotions.get(promotionId);
    if (!existing || existing.organizationId !== organizationId) return false;
    if (!existing.isActive || (existing.maxUses !== null && existing.timesUsed >= existing.maxUses)) return false;
    this.promotions.set(promotionId, { ...existing, timesUsed: existing.timesUsed + 1, updatedAt: new Date().toISOString() });
    return true;
  }

  async getBranchProductState(propertyId: string, productId: string): Promise<BranchProductState | null> {
    const entry = this.branchProducts.find((bp) => bp.propertyId === propertyId && bp.productId === productId);
    return entry ? { propertyId: entry.propertyId, productId: entry.productId, price: entry.price, isAvailable: entry.isAvailable } : null;
  }

  async upsertBranchProductState(propertyId: string, productId: string, price: number, isAvailable: boolean): Promise<BranchProductState> {
    const existing = this.branchProducts.find((bp) => bp.propertyId === propertyId && bp.productId === productId);
    if (existing) {
      existing.price = price;
      existing.isAvailable = isAvailable;
      return { propertyId, productId, price, isAvailable };
    }
    this.branchProducts.push({ propertyId, productId, price, isAvailable });
    return { propertyId, productId, price, isAvailable };
  }

  async findOrderById(organizationId: string, orderId: string): Promise<Order | null> {
    const order = this.orders.find((o) => o.id === orderId && o.organizationId === organizationId);
    return order ?? null;
  }

  async listOrders(organizationId: string, filter: OrderListFilter): Promise<OrderListPage> {
    const scope = filter.propertyIds ? new Set(filter.propertyIds) : null;
    const fromMs = filter.dateFrom ? filter.dateFrom.getTime() : null;
    const toMs = filter.dateTo ? filter.dateTo.getTime() : null;
    const cursorBoundary = decodeCursor(filter.cursor);

    let matching = this.orders.filter((o) => {
      if (o.organizationId !== organizationId) return false;
      if (scope !== null && !scope.has(o.propertyId)) return false;
      if (filter.status !== undefined && o.status !== filter.status) return false;
      const createdMs = Date.parse(o.createdAt);
      if (fromMs !== null && createdMs < fromMs) return false;
      if (toMs !== null && createdMs >= toMs) return false;
      return true;
    });
    matching = matching.sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));

    if (cursorBoundary) {
      matching = matching.filter((o) => isBeforeCursor(o, cursorBoundary));
    }

    const page = matching.slice(0, filter.limit);
    const nextCursor = matching.length > filter.limit ? encodeCursor(page[page.length - 1]!) : null;
    return { orders: page, nextCursor };
  }

  async updateOrderStatus(organizationId: string, orderId: string, fromStatus: OrderStatus, toStatus: OrderStatus): Promise<Order | null> {
    // Mismo espejo del fix TOCTOU de postgres-repository.ts: la guarda de estado
    // vive en el `findIndex`, no en una validación aparte.
    const index = this.orders.findIndex((o) => o.id === orderId && o.organizationId === organizationId && o.status === fromStatus);
    if (index === -1) return null;
    const existing = this.orders[index]!;
    const updated: Order = { ...existing, status: toStatus };
    this.orders[index] = updated;
    return updated;
  }

  // ---- Fase 8 — superficie real del rol "repartidor" (ver repository.ts para el
  // contrato completo de cada método; mismo criterio de scoping que el adaptador de
  // Postgres, ver postgres-repository.ts). ----

  async assignRepartidorToOrder(organizationId: string, orderId: string, repartidorId: string, estimatedDeliveryAt: string | null): Promise<Order | null> {
    const index = this.orders.findIndex((o) => o.id === orderId && o.organizationId === organizationId);
    if (index === -1) return null;
    const updated: Order = { ...this.orders[index]!, assignedRepartidorId: repartidorId, estimatedDeliveryAt };
    this.orders[index] = updated;
    return updated;
  }

  async listOrdersForRepartidor(organizationId: string, repartidorId: string): Promise<readonly Order[]> {
    return this.orders
      .filter((o) => o.organizationId === organizationId && o.assignedRepartidorId === repartidorId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200);
  }

  async findAssignedOrderById(organizationId: string, repartidorId: string, orderId: string): Promise<Order | null> {
    const order = this.orders.find((o) => o.id === orderId && o.organizationId === organizationId && o.assignedRepartidorId === repartidorId);
    return order ?? null;
  }

  async updateAssignedOrderStatus(
    organizationId: string,
    repartidorId: string,
    orderId: string,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
    incidentNote: string | null,
  ): Promise<Order | null> {
    const index = this.orders.findIndex(
      (o) => o.id === orderId && o.organizationId === organizationId && o.assignedRepartidorId === repartidorId && o.status === fromStatus,
    );
    if (index === -1) return null;
    const existing = this.orders[index]!;
    const updated: Order = { ...existing, status: toStatus, incidentNote: toStatus === "problema" ? incidentNote : existing.incidentNote };
    this.orders[index] = updated;
    return updated;
  }

  async findCustomerById(organizationId: string, customerId: string): Promise<Customer | null> {
    const customer = this.customers.get(customerId);
    return customer && customer.organizationId === organizationId ? customer : null;
  }

  async listCustomers(organizationId: string, filter: CustomerListFilter): Promise<CustomerListPage> {
    const search = filter.search?.trim().toLowerCase();
    let matching = [...this.customers.values()].filter((c) => {
      if (c.organizationId !== organizationId) return false;
      if (search && !(c.name?.toLowerCase().includes(search) || c.phone.includes(search))) return false;
      return true;
    });
    // Orden por `id asc` — mismo criterio (y mismo formato de cursor: el último id
    // visto) que PostgresRestaurantesRepository.listCustomers, para que ambos
    // adaptadores paginen de forma idéntica (ver comentario de ese método).
    matching = matching.sort((a, b) => a.id.localeCompare(b.id));

    const cursorBoundary = filter.cursor;
    if (cursorBoundary) {
      matching = matching.filter((c) => c.id > cursorBoundary);
    }

    const page = matching.slice(0, filter.limit);
    const nextCursor = matching.length > filter.limit ? page[page.length - 1]!.id : null;
    return { customers: page, nextCursor };
  }

  // ---- FASE 3 (producto) -- bitácora de auditoría del staff ----

  async registrarAuditoria(input: RegistrarAuditoriaInput): Promise<void> {
    // A diferencia de PostgresRestaurantesRepository (que ignora
    // `input.actorUserId` y deja que `restaurantes.record_audit_log` capture el
    // actor real vía `auth.uid()`), este doble en memoria SÍ lo usa -- no hay
    // sesión SQL/`auth.uid()` que simular aquí, y los tests necesitan un actor
    // real para poder afirmar "quién" quedó registrado.
    this.auditLogSeq += 1;
    this.auditLog.push({
      id: randomUUID(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      // Trunca a los MISMOS límites que el CHECK de `restaurantes.audit_log`
      // (200/500/500, ver migrations/019_restaurantes_audit_log.sql) -- mismo
      // criterio que `left(..., N)` dentro de `restaurantes.record_audit_log`.
      campo: truncarCampoAuditoriaRestaurantes(input.campo, AUDIT_LOG_CAMPO_MAX),
      antes: truncarCampoAuditoriaRestaurantes(input.antes, AUDIT_LOG_TEXTO_MAX),
      despues: truncarCampoAuditoriaRestaurantes(input.despues, AUDIT_LOG_TEXTO_MAX),
      createdAtMs: Date.now(),
      seq: this.auditLogSeq,
    });
  }

  async listAuditoria(organizationId: string, filtro: RestaurantesAuditLogFiltro, paginacion: RestaurantesAuditLogPaginacion): Promise<RestaurantesAuditLogPagina> {
    const limit = Math.min(200, Math.max(1, paginacion.limit ?? 50));
    const offset = Math.max(0, paginacion.offset ?? 0);

    let filtrados = this.auditLog.filter((r) => r.organizationId === organizationId);
    if (filtro.entityType) filtrados = filtrados.filter((r) => r.entityType === filtro.entityType);
    // Mismo criterio EXACTO que `PostgresRestaurantesRepository.listAuditoria` --
    // ancla `desde`/`hasta` a America/Mexico_City (offset fijo `-06:00`) para
    // que ambos repositorios (real e in-memory) clasifiquen el mismo instante
    // en el mismo día de filtro.
    if (filtro.desde) {
      const desdeMs = new Date(`${filtro.desde}T00:00:00-06:00`).getTime();
      filtrados = filtrados.filter((r) => r.createdAtMs >= desdeMs);
    }
    if (filtro.hasta) {
      const hastaExclusivoMs = new Date(`${filtro.hasta}T00:00:00-06:00`).getTime() + 24 * 60 * 60 * 1000;
      filtrados = filtrados.filter((r) => r.createdAtMs < hastaExclusivoMs);
    }
    // Desempate por `seq` cuando `createdAtMs` empata (dos escrituras dentro del
    // mismo milisegundo) -- MISMO orden que `PostgresRestaurantesRepository.
    // listAuditoria` (`order by created_at desc, seq desc`). `Array.prototype.sort`
    // es estable; sin este desempate dos filas empatadas quedarían en orden de
    // inserción (más antigua primero) en vez de "más reciente primero".
    filtrados = [...filtrados].sort((a, b) => b.createdAtMs - a.createdAtMs || b.seq - a.seq);

    const total = filtrados.length;
    const pagina = filtrados.slice(offset, offset + limit).map(({ organizationId: _organizationId, seq: _seq, ...row }) => row);
    return { disponible: true, items: pagina, total, nextOffset: offset + pagina.length < total ? offset + pagina.length : null };
  }

  // ---- FASE 3 (producto) -- configuración editable del panel (owner/admin),
  // ver migrations/021_restaurantes_config_editable_y_search_path_fix.sql ----

  async getWhatsappChannelConfig(organizationId: string): Promise<WhatsappChannelConfig> {
    for (const [phoneNumberId, orgId] of this.phoneNumberIdToOrg) {
      if (orgId === organizationId) return { phoneNumberId };
    }
    return { phoneNumberId: null };
  }

  async upsertWhatsappChannelConfig(organizationId: string, phoneNumberId: string): Promise<WhatsappChannelConfig> {
    // Un solo `phone_number_id` por organización (PK real de la tabla) -- limpia
    // cualquier entrada previa de ESTA organización antes de fijar la nueva.
    for (const [existingPhoneNumberId, orgId] of this.phoneNumberIdToOrg) {
      if (orgId === organizationId) this.phoneNumberIdToOrg.delete(existingPhoneNumberId);
    }
    this.phoneNumberIdToOrg.set(phoneNumberId, organizationId);
    return { phoneNumberId };
  }

  async listKnownZones(organizationId: string): Promise<readonly KnownZone[]> {
    return this.knownZones
      .filter((z) => z.organizationId === organizationId)
      .map((z) => ({ id: z.id!, organizationId: z.organizationId, name: z.name, lat: z.lat, lng: z.lng, createdAt: z.createdAt! }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id.localeCompare(a.id)));
  }

  async createKnownZone(organizationId: string, input: NewKnownZoneInput): Promise<KnownZone> {
    const zone: Required<StoredKnownZone> = { id: randomUUID(), organizationId, name: input.name, lat: input.lat, lng: input.lng, createdAt: new Date().toISOString() };
    this.knownZones.push(zone);
    return zone;
  }

  async deleteKnownZone(organizationId: string, zoneId: string): Promise<boolean> {
    const idx = this.knownZones.findIndex((z) => z.id === zoneId && z.organizationId === organizationId);
    if (idx < 0) return false;
    this.knownZones.splice(idx, 1);
    return true;
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

/** El listado real está ordenado `createdAt desc, id desc` (ver `listOrders`) — un
 * pedido queda "después" del cursor (se incluye en la página siguiente) cuando su
 * clave compuesta es estrictamente MENOR que la del cursor bajo ese mismo orden. */
function isBeforeCursor(order: Order, boundary: OrderCursorBoundary): boolean {
  if (order.createdAt !== boundary.createdAt) return order.createdAt < boundary.createdAt;
  return order.id < boundary.id;
}
