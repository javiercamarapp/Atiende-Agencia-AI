// InMemoryRestaurantesRepository — implementación real (no un mock) de
// `RestaurantesRepository`, con las mismas restricciones de integridad e idempotencia
// que las migraciones SQL de migrations/001-004 (UNIQUE(organization_id, phone),
// serialización tipo pg_advisory_xact_lock, dedupe de mensajes de WhatsApp, leases de
// conversación). Sirve como fixture de seed para tests determinísticos y como
// fallback dev/CI sin Postgres real — mismo rol que InMemoryStateStore en
// @atiende/core-conversation.
import { avanzarEstadoEntrega } from "@atiende/whatsapp-gateway";
import type { VoiceSecretMatch, VoiceToolAuditInput } from "./types.ts";
import type { OrderFlowContext, OrderFlowSnapshot, OrderFlowState, OrderFlowWriteResult } from "./agent-tools/order-flow.ts";
import { randomUUID } from "node:crypto";
import type { ClaveContadorAgente } from "./whatsapp/contadores-agente.ts";
import { ClienteMemoriaNoDisponibleError, OrderConflictError, WhatsAppAgentConfigConflictError, WhatsappNumberInUseError } from "./errors.ts";
import { fotoConfigAgente } from "./whatsapp/agent-config-editor.ts";
import { RestaurantesConfigUnavailableError } from "./repository.ts";
import { EMPTY_BRANCH_POLICY } from "./types.ts";
import { diaLocalSucursal } from "./voz/kpi.ts";
import { InMemoryConocimientoStore } from "./conocimiento/in-memory.ts";
import type { ConocimientoEntrada, ConocimientoLectura, ConocimientoPatch, NuevaConocimientoEntrada } from "./conocimiento/types.ts";
import { haversineKm, normalizeZoneText } from "./nearest-branch.ts";
import { ahoraEstricto, Cliente360Store, newMemAddress, type MemAddress } from "./cliente-360/in-memory.ts";
import type { ClosureObservation, CustomerAddressChanges, CustomerAddressDetail, CustomerFicha, CustomerMemory, CustomerPolicy, CustomerPreference, CustomerProfilePatch, OrderClosureInput, PastOrder, PreferenceAction } from "./cliente-360/types.ts";
import { isPreferenceKind, POLITICA_POR_OMISION } from "./cliente-360/types.ts";
import type {
  CanalPedido,
  Branch,
  BranchPolicy,
  WhatsAppAgentConfigAccion,
  WhatsAppAgentConfigHistorialEntry,
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
  BranchHoursException,
  NewBranchHoursExceptionInput,
  OrderPickupInfo,
  OrderScheduleInfo,
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
  WhatsAppChannelResolution,
  WhatsappBranchChannel,
  StorefrontMarca,
  StorefrontMarcaInput,
  WhatsappChannelConfig,
  StorefrontCatalogRow,
  StorefrontTrackingResult,
} from "./types.ts";
import type {
  ChannelStatsRow,
  ConversationMessage,
  CustomerOverviewRow,
  EmailOutboxJobRow,
  KpiDateRange,
  EstadoEntregaEntrante,
  MessagingOutboxRow,
  MotivoFalloEntregaGuardado,
  RegistroEstadoEntrega,
  NewOrderRecord,
  PromotedScheduledOrdersResult,
  RestaurantesRepository,
  ScheduledOrdersResult,
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
  agotadoHasta?: string | null;
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
  readonly lat: number | null;
  readonly lng: number | null;
  readonly createdAt?: string;
  /** Procedencia y referencia del piloto original (migracion 056); solo las siembran los mundos de prueba del seed. */
  readonly fuente?: string | null;
  readonly asignacionFuente?: string | null;
  readonly refSucursalSlug?: string | null;
  readonly refKm?: number | null;
  readonly ref2SucursalSlug?: string | null;
  readonly ref2Km?: number | null;
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
  /** Migracion 066: wamid y estado de entrega (espejo de las columnas nuevas). */
  providerMessageId?: string | null;
  enviadoComo?: "texto" | "plantilla" | "botones" | "ubicacion" | null;
  deliveryStatus?: "sent" | "delivered" | "read" | "failed" | null;
  deliveryUpdatedAt?: number | null;
  deliveryErrorCode?: number | null;
  deliveryErrorTitle?: string | null;
  deliveryFailureReason?: MotivoFalloEntregaGuardado | null;
}

/** Ventana en que un aviso abierto del mismo canal, telefono y motivo absorbe al siguiente (misma que `callback_registrar_agente`: 2 h). */
const CALLBACK_VENTANA_AGRUPAR_MS = 120 * 60_000;
/** Vigencia de un contador del agente (misma que la funcion SQL: 2 h). */
const CONTADOR_AGENTE_VIGENCIA_MS = 120 * 60_000;

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
  private readonly addresses = new Map<string, MemAddress[]>();
  // Cliente 360 (migracion 049): espejo en memoria de las columnas/tablas nuevas.
  private readonly cliente360 = new Cliente360Store();
  private readonly orders: StoredOrder[] = [];
  private readonly knownZones: StoredKnownZone[] = [];
  private readonly storefrontMarcas = new Map<string, StorefrontMarca>();
  private readonly callbackRequests: CallbackRequest[] = [];
  private readonly contadoresAgente = new Map<string, { n: number; at: number }>();
  /** Ids de evento agregados como nota a un aviso (migracion 047, `eventos_agrupados`). */
  private readonly callbackEventosAgrupados = new Map<string, string[]>();
  private readonly rateLimits = new Map<string, { windowStartedAt: number; requestCount: number }>();
  private readonly phoneNumberIdToOrg = new Map<string, string>();
  private readonly whatsappEvents = new Map<string, StoredWhatsAppEvent>();
  private readonly whatsappLeases = new Map<string, StoredLease>();
  private readonly whatsappConversations = new Map<string, StoredConversation>();
  private readonly outbox = new Map<string, InMemoryOutboxRow>();
  private readonly staffOrderNotifications = new Map<string, StaffOrderNotificationRecord>();
  // FASE 3 (producto) -- zona horaria por negocio (migración 022,
  // `restaurantes.branch_detail.zona_horaria`). Mapa aparte (no una propiedad de
  // `Branch`/`StoredBranch`) -- mismo criterio que `whatsappChannelConfig`/
  // `knownZones`: `Branch` es un tipo público usado en muchos call-sites, esto es
  // config editable aparte que solo un puñado de sitios necesita.
  private readonly branchZonaHoraria = new Map<string, string | null>();
  // Modelo PM (migracion 023), espejo en memoria de branch_policy / branch_delivery_zone /
  // whatsapp_branch_channel / no_domicilio.
  private readonly branchPolicies = new Map<string, BranchPolicy>();
  /** Conocimiento del negocio e interruptor del agente de WhatsApp (migracion 053); `conocimiento.noDisponible = true` simula la base sin migrar. */
  readonly conocimiento = new InMemoryConocimientoStore(
    () => new Date(),
    (organizationId, propertyId) => this.branches.get(propertyId)?.organizationId === organizationId,
  );
  private readonly branchHoursExceptions: BranchHoursException[] = [];
  private readonly orderPickupInfo = new Map<string, { canal: CanalPedido | null; propina: number | null; horaRecogida: string | null }>();
  // R-11 (migracion 034): `false` simula la base SIN migrar (los pedidos programados no estan disponibles).
  private scheduledOrdersSupported = true;
  private readonly whatsAppAgentConfigs = new Map<string, WhatsAppAgentConfigRow>();
  private readonly branchDeliveryZones = new Map<string, Set<string>>();
  private readonly whatsappBranchChannels = new Map<string, { organizationId: string; propertyId: string }>();
  private readonly noDomicilioProducts = new Set<string>();
  private readonly noDomicilioCategories = new Set<string>();

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

  /** Equivalente en memoria de `insert into restaurantes.whatsapp_branch_channel`. */
  seedWhatsAppBranchChannel(organizationId: string, propertyId: string, phoneNumberId: string): void {
    this.whatsappBranchChannels.set(phoneNumberId, { organizationId, propertyId });
  }

  seedBranchPolicy(propertyId: string, policy: Partial<BranchPolicy>): void {
    this.branchPolicies.set(propertyId, { ...EMPTY_BRANCH_POLICY, ...policy });
  }

  seedBranchDeliveryZones(propertyId: string, zoneIds: readonly string[]): void {
    this.branchDeliveryZones.set(propertyId, new Set(zoneIds));
  }

  seedNoDomicilio(marks: { readonly productIds?: readonly string[]; readonly categoryIds?: readonly string[] }): void {
    for (const id of marks.productIds ?? []) this.noDomicilioProducts.add(id);
    for (const id of marks.categoryIds ?? []) this.noDomicilioCategories.add(id);
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
      // Una colonia sin coordenadas (migracion 056) no sirve de punto para medir distancias: la funcion SQL tampoco la considera.
      if (zone.lat === null || zone.lng === null) continue;
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
      const distance = haversineKm(bestZone.lat as number, bestZone.lng as number, branch.lat, branch.lng);
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
        noDomicilio: this.noDomicilioProducts.has(product.id) || (product.categoryId !== null && this.noDomicilioCategories.has(product.categoryId)),
      });
    }
    return result;
  }

  async listStorefrontCatalog(propertyId: string): Promise<readonly StorefrontCatalogRow[]> {
    const rows: StorefrontCatalogRow[] = [];
    for (const bp of this.branchProducts) {
      if (bp.propertyId !== propertyId) continue;
      const product = this.products.get(bp.productId);
      if (!product) continue;
      const category = product.categoryId ? this.categories.get(product.categoryId) : undefined;
      rows.push({
        id: product.id,
        name: product.name,
        description: product.description,
        price: bp.price,
        imageUrl: product.imageUrl,
        isPopular: product.isPopular,
        isAvailable: bp.isAvailable,
        categoryId: product.categoryId,
        categoryName: category?.name ?? null,
        categoryDisplayOrder: category?.displayOrder ?? 0,
        displayOrder: product.displayOrder,
        noDomicilio: this.noDomicilioProducts.has(product.id) || (product.categoryId !== null && this.noDomicilioCategories.has(product.categoryId)),
      });
    }
    return rows.sort((a, b) => a.categoryDisplayOrder - b.categoryDisplayOrder || (a.categoryName ?? "~").localeCompare(b.categoryName ?? "~") || a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
  }

  /** Solo pruebas: simula una base sin la migracion 032 (`findStorefrontOrderTracking` -> no disponible). */
  simulateStorefrontTrackingUnavailable(): void {
    this.storefrontTrackingUnavailable = true;
  }
  private storefrontTrackingUnavailable = false;

  async findStorefrontOrderTracking(organizationId: string, orderId: string): Promise<StorefrontTrackingResult> {
    if (this.storefrontTrackingUnavailable) return { disponible: false, pedido: null };
    const order = this.orders.find((o) => o.id === orderId && o.organizationId === organizationId);
    if (!order) return { disponible: true, pedido: null };
    const notes = order.notes ?? "";
    return {
      disponible: true,
      pedido: {
        status: order.status,
        branch: order.branch,
        total: order.total,
        paymentMethod: order.paymentMethod,
        canal: notes.includes("Canal: recoger en sucursal.") ? "recoger" : "domicilio",
        createdAt: order.createdAt,
        items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, tortilla: i.tortilla ?? null })),
      },
    };
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

  async addCustomerAddressIfNew(customerId: string, address: string, organizationId: string): Promise<void> {
    // Mismo guard cross-tenant que la funcion SQL (`add_customer_address_if_new`, migracion 048).
    const dueno = this.customers.get(customerId);
    if (!dueno || dueno.organizationId !== organizationId) throw new Error("el cliente no pertenece a la organización");
    const list = this.addresses.get(customerId) ?? [];
    if (list.some((a) => a.address === address)) return; // onConflict ignoreDuplicates
    list.push(newMemAddress(address, list.length === 0));
    this.addresses.set(customerId, list);
  }

  async listCustomerAddresses(customerId: string, _organizationId?: string): Promise<readonly CustomerAddress[]> {
    const list = this.addresses.get(customerId) ?? [];
    return [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map((a) => ({ address: a.address, label: a.label, isDefault: a.isDefault }));
  }

  async listEligibleOrderHistory(customerId: string, _organizationId?: string): Promise<ReadonlyArray<{ items: readonly PersistedOrderItem[]; createdAt: string }>> {
    const eligibleStatuses = new Set(["pending", "preparando", "en_camino", "entregado", "completado"]);
    return this.orders
      .filter((o) => o.customerId === customerId && eligibleStatuses.has(o.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((o) => ({ items: o.items, createdAt: o.createdAt }));
  }

  // ---- Cliente 360 (migracion 049): espejo en memoria de las funciones SQL (cliente_memoria, cliente_registrar_pedido, ...) ----

  /** Pruebas: `false` simula la base SIN la migracion 049 (el agente cae al camino anterior; el staff ve "no disponible"). */
  setCliente360Supported(supported: boolean): void {
    this.cliente360.supported = supported;
  }

  /** Pruebas: pedido de un cliente con el estado y la fecha que se indiquen (p. ej. `no_recogido` hace 10 dias). */
  seedOrderForCustomer(order: Order): void {
    this.orders.push(order);
    const pickup = { canal: order.canal ?? null, propina: order.propina ?? null, horaRecogida: order.horaRecogida ?? null };
    this.orderPickupInfo.set(order.id, pickup);
  }

  private policyFor(organizationId: string): CustomerPolicy {
    return this.cliente360.policies.get(organizationId) ?? POLITICA_POR_OMISION;
  }

  private addressDetails(customerId: string): CustomerAddressDetail[] {
    const list = [...(this.addresses.get(customerId) ?? [])];
    list.sort((a, b) => {
      const la = a.lastUsedAt ? Date.parse(a.lastUsedAt) : -Infinity;
      const lb = b.lastUsedAt ? Date.parse(b.lastUsedAt) : -Infinity;
      return lb - la || Number(b.isDefault) - Number(a.isDefault) || Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
    return list.map((a) => ({
      id: a.id,
      address: a.address,
      label: a.label,
      isDefault: a.isDefault,
      accessNotes: a.accessNotes,
      mapsUrl: a.mapsUrl,
      colonia: a.colonia,
      branchSlug: a.propertyId ? ([...this.branches.values()].find((b) => b.propertyId === a.propertyId)?.slug ?? null) : null,
      lastUsedAt: a.lastUsedAt,
      timesUsed: a.timesUsed,
    }));
  }

  private reliabilityFor(organizationId: string, customerId: string): { noRecogidos90d: number; pedidosFalsos: number; umbral: number; ventanaDias: number } {
    const policy = this.policyFor(organizationId);
    const desde = Date.now() - policy.ventanaDias * 86_400_000;
    const delCliente = this.orders.filter((o) => o.customerId === customerId && o.organizationId === organizationId && Date.parse(o.createdAt) >= desde);
    return {
      noRecogidos90d: delCliente.filter((o) => o.status === "no_recogido").length,
      pedidosFalsos: delCliente.filter((o) => this.cliente360.fakeOrders.has(o.id)).length,
      umbral: policy.umbralNoRecogidos,
      ventanaDias: policy.ventanaDias,
    };
  }

  private orderNumberOf(order: Order): number {
    return this.orders.indexOf(order) + 1;
  }

  async getCustomerMemory(organizationId: string, phone: string): Promise<CustomerMemory | null | undefined> {
    if (!this.cliente360.supported) return undefined;
    const customer = await this.findCustomerByPhone(organizationId, phone);
    if (!customer) return null;
    const eligible = new Set(["pending", "preparando", "en_camino", "entregado", "completado", "listo_para_recoger"]);
    const orders: PastOrder[] = this.orders
      .filter((o) => o.customerId === customer.id && o.organizationId === organizationId && eligible.has(o.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 30)
      .map((o) => {
        const pickup = this.orderPickupInfo.get(o.id);
        return {
          id: o.id,
          orderNumber: this.orderNumberOf(o),
          createdAt: o.createdAt,
          status: o.status,
          total: o.total,
          items: o.items,
          branch: o.branch,
          propertyId: o.propertyId,
          paymentMethod: o.paymentMethod,
          canal: pickup?.canal ?? null,
          propina: pickup?.propina ?? null,
          source: o.source,
        };
      });
    return {
      customer,
      addresses: this.addressDetails(customer.id),
      orders,
      preferences: [...(this.cliente360.preferences.get(customer.id) ?? [])],
      reliability: this.reliabilityFor(organizationId, customer.id),
    };
  }

  async registerOrderClosure(input: OrderClosureInput): Promise<{ readonly applied: boolean } | undefined> {
    if (!this.cliente360.supported) return undefined;
    const order = this.orders.find((o) => o.id === input.orderId && o.organizationId === input.organizationId);
    if (!order || !order.customerId) throw Object.assign(new Error("el pedido no existe en la organizacion o no tiene cliente"), { code: "42501" });
    if (this.cliente360.closures.has(order.id)) return { applied: false };
    this.cliente360.closures.add(order.id);
    const customerId = order.customerId;

    if (input.address) {
      const list = this.addresses.get(customerId) ?? [];
      const now = ahoraEstricto();
      const validProperty = input.address.propertyId && [...this.branches.values()].some((b) => b.propertyId === input.address!.propertyId && b.organizationId === input.organizationId) ? input.address.propertyId : null;
      const existing = list.find((a) => a.address === input.address!.address);
      if (existing) {
        existing.lastUsedAt = now;
        existing.timesUsed += 1;
        existing.accessNotes = input.address.accessNotes ?? existing.accessNotes;
        existing.mapsUrl = input.address.mapsUrl ?? existing.mapsUrl;
        existing.colonia = input.address.colonia ?? existing.colonia;
        existing.propertyId = validProperty ?? existing.propertyId;
        if (input.address.label) this.setAddressLabel(customerId, existing.id, input.address.label);
      } else {
        const created = newMemAddress(input.address.address, list.length === 0);
        created.lastUsedAt = now;
        created.timesUsed = 1;
        created.accessNotes = input.address.accessNotes ?? null;
        created.mapsUrl = input.address.mapsUrl ?? null;
        created.colonia = input.address.colonia ?? null;
        created.propertyId = validProperty;
        list.push({ ...created, label: input.address.label ?? null });
        this.addresses.set(customerId, list);
      }
    }

    const prefs = this.cliente360.preferences.get(customerId) ?? [];
    const now = ahoraEstricto();
    for (const obs of input.observations.slice(0, 20) as readonly ClosureObservation[]) {
      const value = obs.value.trim().slice(0, 120);
      if (!value || !isPreferenceKind(obs.kind)) continue;
      const found = prefs.find((p) => p.kind === obs.kind && p.value === value);
      if (found) {
        const idx = prefs.indexOf(found);
        prefs[idx] = { ...found, timesSeen: found.timesSeen + 1, lastSeenAt: now };
      } else if (prefs.length < 80) {
        prefs.push({ id: randomUUID(), kind: obs.kind, value, source: "pedido", timesSeen: 1, firstSeenAt: now, lastSeenAt: now, status: "activa" });
      }
    }
    this.cliente360.preferences.set(customerId, prefs);
    return { applied: true };
  }

  private setAddressLabel(customerId: string, addressId: string, label: string | null): void {
    const list = this.addresses.get(customerId) ?? [];
    const idx = list.findIndex((a) => a.id === addressId);
    if (idx >= 0) list[idx] = { ...list[idx]!, label };
  }

  private requireCliente360(): void {
    if (!this.cliente360.supported) throw new ClienteMemoriaNoDisponibleError();
  }

  private requireCustomer(organizationId: string, customerId: string): Customer {
    const customer = this.customers.get(customerId);
    if (!customer || customer.organizationId !== organizationId) throw Object.assign(new Error("cliente inexistente en la organizacion"), { code: "42501" });
    return customer;
  }

  async getCustomerFicha(organizationId: string, customerId: string): Promise<Omit<CustomerFicha, "tier"> | null> {
    this.requireCliente360();
    const customer = this.customers.get(customerId);
    if (!customer || customer.organizationId !== organizationId) return null;
    const profile = this.cliente360.profiles.get(customerId);
    const orders = this.orders
      .filter((o) => o.customerId === customerId && o.organizationId === organizationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 20);
    const conversation = this.whatsappConversations.get(`${organizationId}:${customer.phone}`);
    return {
      customer: {
        ...customer,
        lastOrderAt: orders[0]?.createdAt ?? null,
        createdAt: orders.length > 0 ? orders[orders.length - 1]!.createdAt : new Date(0).toISOString(),
        fechaNacimientoDia: profile?.dia ?? null,
        fechaNacimientoMes: profile?.mes ?? null,
        staffNotes: profile?.staffNotes ?? null,
      },
      addresses: this.addressDetails(customerId),
      preferences: [...(this.cliente360.preferences.get(customerId) ?? [])],
      reliability: this.reliabilityFor(organizationId, customerId),
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: this.orderNumberOf(o),
        createdAt: o.createdAt,
        status: o.status,
        total: o.total,
        items: o.items,
        branch: o.branch,
        source: o.source,
        paymentMethod: o.paymentMethod,
        pedidoFalso: this.cliente360.fakeOrders.has(o.id),
      })),
      whatsapp: { conversaciones: conversation ? 1 : 0, ultimaActividad: null, mensajes: conversation?.messages.length ?? 0 },
      llamadas: [],
    };
  }

  async updateCustomerProfile(organizationId: string, customerId: string, patch: CustomerProfilePatch): Promise<void> {
    this.requireCliente360();
    const customer = this.requireCustomer(organizationId, customerId);
    if (patch.name !== undefined) this.customers.set(customerId, { ...customer, name: patch.name });
    const prev = this.cliente360.profiles.get(customerId) ?? { dia: null, mes: null, staffNotes: null };
    const dia = patch.fechaNacimientoDia !== undefined || patch.fechaNacimientoMes !== undefined ? (patch.fechaNacimientoDia ?? null) : prev.dia;
    const mes = patch.fechaNacimientoDia !== undefined || patch.fechaNacimientoMes !== undefined ? (patch.fechaNacimientoMes ?? null) : prev.mes;
    if ((dia === null) !== (mes === null)) throw Object.assign(new Error("fecha de nacimiento incompleta"), { code: "23514" });
    const diasPorMes = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (dia !== null && mes !== null && (mes < 1 || mes > 12 || dia < 1 || dia > diasPorMes[mes - 1]!)) throw Object.assign(new Error("fecha de nacimiento invalida"), { code: "23514" });
    this.cliente360.profiles.set(customerId, { dia, mes, staffNotes: patch.staffNotes !== undefined ? patch.staffNotes : prev.staffNotes });
  }

  async saveCustomerAddress(organizationId: string, customerId: string, addressId: string | null, changes: CustomerAddressChanges): Promise<string> {
    this.requireCliente360();
    this.requireCustomer(organizationId, customerId);
    if (changes.mapsUrl && !/^https:\/\/\S+$/.test(changes.mapsUrl)) throw Object.assign(new Error("el link de Maps debe empezar con https://"), { code: "22023" });
    if (changes.propertyId && ![...this.branches.values()].some((b) => b.propertyId === changes.propertyId && b.organizationId === organizationId)) {
      throw Object.assign(new Error("sucursal inexistente en la organizacion"), { code: "42501" });
    }
    const list = this.addresses.get(customerId) ?? [];
    let id = addressId;
    if (id === null) {
      if (!changes.address?.trim()) throw Object.assign(new Error("la direccion es requerida"), { code: "22023" });
      const created = newMemAddress(changes.address.trim(), list.length === 0);
      list.push({ ...created, label: changes.label ?? null, accessNotes: changes.accessNotes ?? null, mapsUrl: changes.mapsUrl ?? null, colonia: changes.colonia ?? null, propertyId: changes.propertyId ?? null });
      id = created.id;
    } else {
      const idx = list.findIndex((a) => a.id === id);
      if (idx < 0) throw Object.assign(new Error("direccion inexistente para el cliente"), { code: "42501" });
      const cur = list[idx]!;
      list[idx] = {
        ...cur,
        address: changes.address?.trim() ? changes.address.trim() : cur.address,
        label: changes.label !== undefined ? changes.label : cur.label,
        accessNotes: changes.accessNotes !== undefined ? changes.accessNotes : cur.accessNotes,
        mapsUrl: changes.mapsUrl !== undefined ? changes.mapsUrl : cur.mapsUrl,
        colonia: changes.colonia !== undefined ? changes.colonia : cur.colonia,
        propertyId: changes.propertyId !== undefined ? changes.propertyId : cur.propertyId,
      };
    }
    if (changes.isDefault) for (let i = 0; i < list.length; i++) list[i] = { ...list[i]!, isDefault: list[i]!.id === id };
    this.addresses.set(customerId, list);
    return id!;
  }

  async deleteCustomerAddress(organizationId: string, customerId: string, addressId: string): Promise<boolean> {
    this.requireCliente360();
    this.requireCustomer(organizationId, customerId);
    const list = this.addresses.get(customerId) ?? [];
    const idx = list.findIndex((a) => a.id === addressId);
    if (idx < 0) return false;
    const wasDefault = list[idx]!.isDefault;
    list.splice(idx, 1);
    if (wasDefault && list.length > 0) {
      const next = [...list].sort((a, b) => (b.lastUsedAt ? Date.parse(b.lastUsedAt) : -Infinity) - (a.lastUsedAt ? Date.parse(a.lastUsedAt) : -Infinity))[0]!;
      const i = list.indexOf(next);
      list[i] = { ...next, isDefault: true };
    }
    this.addresses.set(customerId, list);
    return true;
  }

  async applyCustomerPreferenceAction(organizationId: string, customerId: string, action: PreferenceAction, args: { readonly prefId?: string | null; readonly kind?: string | null; readonly value?: string | null }): Promise<string> {
    this.requireCliente360();
    this.requireCustomer(organizationId, customerId);
    const prefs = this.cliente360.preferences.get(customerId) ?? [];
    const now = new Date().toISOString();
    if (action === "agregar") {
      const value = args.value?.trim().slice(0, 120);
      if (!value || !isPreferenceKind(args.kind)) throw Object.assign(new Error("categoria o valor invalido"), { code: "22023" });
      const idx = prefs.findIndex((p) => p.kind === args.kind && p.value === value);
      const base: CustomerPreference = { id: idx >= 0 ? prefs[idx]!.id : randomUUID(), kind: args.kind, value, source: "staff", timesSeen: idx >= 0 ? prefs[idx]!.timesSeen : 1, firstSeenAt: idx >= 0 ? prefs[idx]!.firstSeenAt : now, lastSeenAt: idx >= 0 ? prefs[idx]!.lastSeenAt : now, status: "activa" };
      if (idx >= 0) prefs[idx] = base;
      else prefs.push(base);
      this.cliente360.preferences.set(customerId, prefs);
      return base.id;
    }
    const idx = prefs.findIndex((p) => p.id === args.prefId);
    if (idx < 0) throw Object.assign(new Error("gusto inexistente para el cliente"), { code: "42501" });
    const found = prefs[idx]!;
    if (action === "eliminar") prefs.splice(idx, 1);
    else prefs[idx] = { ...found, status: action === "descartar" ? "descartada" : "activa" };
    this.cliente360.preferences.set(customerId, prefs);
    return found.id;
  }

  async markOrderFake(organizationId: string, orderId: string, falso: boolean): Promise<boolean> {
    this.requireCliente360();
    const order = this.orders.find((o) => o.id === orderId && o.organizationId === organizationId);
    if (!order) throw Object.assign(new Error("pedido inexistente en la organizacion"), { code: "42501" });
    if (falso) this.cliente360.fakeOrders.add(orderId);
    else this.cliente360.fakeOrders.delete(orderId);
    return falso;
  }

  async exportCustomerData(organizationId: string, customerId: string): Promise<Record<string, unknown> | null> {
    const ficha = await this.getCustomerFicha(organizationId, customerId);
    if (!ficha) return null;
    return {
      nombre: ficha.customer.name,
      telefono: ficha.customer.phone,
      fecha_nacimiento_dia: ficha.customer.fechaNacimientoDia,
      fecha_nacimiento_mes: ficha.customer.fechaNacimientoMes,
      notas_del_restaurante: ficha.customer.staffNotes,
      domicilios: ficha.addresses,
      gustos: ficha.preferences,
      pedidos: ficha.orders.map((o) => ({ numero: o.orderNumber, fecha: o.createdAt, estado: o.status, total: o.total, productos: o.items, sucursal: o.branch })),
    };
  }

  async deleteCustomerMemory(organizationId: string, customerId: string): Promise<{ readonly domiciliosBorrados: number; readonly gustosBorrados: number }> {
    this.requireCliente360();
    const customer = this.requireCustomer(organizationId, customerId);
    const domicilios = (this.addresses.get(customerId) ?? []).length;
    const gustos = (this.cliente360.preferences.get(customerId) ?? []).length;
    this.addresses.delete(customerId);
    this.cliente360.preferences.delete(customerId);
    this.cliente360.profiles.delete(customerId);
    this.customers.set(customerId, { ...customer, name: null });
    return { domiciliosBorrados: domicilios, gustosBorrados: gustos };
  }

  async getCustomerPolicy(organizationId: string): Promise<CustomerPolicy> {
    return this.cliente360.supported ? this.policyFor(organizationId) : POLITICA_POR_OMISION;
  }

  async saveCustomerPolicy(organizationId: string, policy: CustomerPolicy): Promise<CustomerPolicy> {
    this.requireCliente360();
    if (policy.umbralNoRecogidos < 0 || policy.umbralNoRecogidos > 20 || policy.ventanaDias < 7 || policy.ventanaDias > 365) throw Object.assign(new Error("fuera de rango"), { code: "22023" });
    this.cliente360.policies.set(organizationId, policy);
    return policy;
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
        // R-30 + QA R1 viaje-09: ventas netas; un pedido cancelado, no recogido (no se cobro) o programado (aun no es venta) no cuenta.
        // QA R2 viaje-04: un pedido retenido (por_aprobar) tampoco es venta. QA R2 viaje-03: el dia es el de la promocion si la hay.
        if (o.status === "cancelado" || o.status === "no_recogido" || o.status === "programado" || o.status === "por_aprobar") return false;
        const createdMs = Date.parse(o.promovidoAt ?? o.createdAt);
        return createdMs >= startMs && createdMs < endMs;
      });
      const revenue = enRango.reduce((sum, o) => sum + o.total, 0);
      // R-30: por customer_id (espejo de `count(distinct customer_id)`), nunca por nombre.
      const customerCount = new Set(enRango.flatMap((o) => (o.customerId ? [o.customerId] : []))).size;
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

  async getChannelStats(organizationId: string, propertyIds: readonly string[] | null, range?: KpiDateRange): Promise<ChannelStatsRow> {
    const scope = propertyIds ? new Set(propertyIds) : null;
    // Espejo de orders_channel_stats(_periodo) (036): ingresos SIN cancelados; conteos con cancelados.
    const relevantes = this.orders.filter((o) => {
      if (o.organizationId !== organizationId || (scope !== null && !scope.has(o.propertyId))) return false;
      if (!range) return true;
      const ms = Date.parse(o.createdAt);
      return ms >= range.start.getTime() && ms < range.end.getTime();
    });
    const netos = (list: readonly Order[]) => list.filter((o) => o.status !== "cancelado").reduce((sum, o) => sum + o.total, 0);
    const porCanal = (source: "voice" | "whatsapp") => {
      const list = relevantes.filter((o) => o.source === source);
      return {
        orders: list.length,
        completed: list.filter((o) => o.status === "completado" || o.status === "entregado").length,
        cancelled: list.filter((o) => o.status === "cancelado").length,
        revenue: netos(list),
      };
    };
    return {
      acotadoAPeriodo: range !== undefined,
      totalOrders: relevantes.length,
      totalRevenue: netos(relevantes),
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

    // R-30: el ticket promedio no promedia pedidos cancelados (espejo de la migracion 036).
    const ordenesNetas = ordenesOrg.filter((o) => o.status !== "cancelado");
    const averageOrderValue = ordenesNetas.length > 0 ? ordenesNetas.reduce((sum, o) => sum + o.total, 0) / ordenesNetas.length : null;
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
            (o.status === "pending" || o.status === "programado") &&
            Date.parse(o.createdAt) >= fiveMinutesAgo,
        );
        if (existing) return existing;
      }

      const programadoPara = this.scheduledOrdersSupported ? (order.programadoPara ?? null) : null;
      if (programadoPara && Date.parse(programadoPara) <= Date.now()) throw new Error("programado_para debe ser una hora futura");
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
        // Espejo de create_order_idempotent (034): con `programadoPara` nace `programado`; la funcion VIEJA
        // (base sin migrar) ignora la llave y lo crea `pending`.
        status: programadoPara ? "programado" : "pending",
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
        canal: order.canal ?? null,
        propina: order.propina ?? null,
        horaRecogida: order.horaRecogida ?? null,
        ...(programadoPara ? { programadoPara, promovidoAt: null } : {}),
      };
      this.orders.push(created);
      this.orderPickupInfo.set(created.id, { canal: order.canal ?? null, propina: order.propina ?? null, horaRecogida: order.horaRecogida ?? null });
      if (order.customerId) {
        const customer = this.customers.get(order.customerId);
        if (customer) this.customers.set(customer.id, { ...customer, orderCount: customer.orderCount + 1 });
      }
      return created;
    });
  }

  /** Solo pruebas: los avisos (callbacks) de la organizacion, tal como quedaron (con las notas agregadas en `message`). */
  listCallbackRequests(organizationId: string): readonly CallbackRequest[] {
    return this.callbackRequests.filter((c) => c.organizationId === organizationId);
  }

  /** Solo para pruebas: las solicitudes de contacto registradas (en orden de creacion). */
  peekCallbackRequests(): readonly CallbackRequest[] {
    return this.callbackRequests;
  }

  /** Mismas reglas que `restaurantes.callback_registrar_agente` (migracion 047) para los avisos del agente (`voice`/`whatsapp`): el mismo
   * evento no se repite y un aviso abierto del mismo canal, telefono y motivo recibe una nota en vez de crear otro. */
  async createCallbackRequest(input: CallbackRequestInput): Promise<CallbackRequest> {
    if (input.source === "voice" || input.source === "whatsapp") {
      const evento = input.sourceEventId ?? null;
      const delTelefono = this.callbackRequests.filter((c) => c.organizationId === input.organizationId && c.customerPhone === input.customerPhone);
      if (evento) {
        const previo = delTelefono.find((c) => c.sourceEventId === evento || (this.callbackEventosAgrupados.get(c.id) ?? []).includes(evento));
        if (previo) return { ...previo, registro: "evento_repetido" };
      }
      const ahora = Date.now();
      const abierto = [...delTelefono]
        .reverse()
        .find((c) => c.source === input.source && (c.reason ?? null) === (input.reason ?? null) && !c.resolved && ahora - Date.parse(c.createdAt) < CALLBACK_VENTANA_AGRUPAR_MS);
      if (abierto) {
        const nota = `\n— Aviso repetido: ${(input.message ?? "").trim().slice(0, 500) || "sin detalle"}`;
        const actual = abierto.message ?? "";
        const actualizado: CallbackRequest = { ...abierto, message: actual.length + nota.length <= 4000 ? actual + nota : abierto.message };
        this.callbackRequests[this.callbackRequests.indexOf(abierto)] = actualizado;
        if (evento) this.callbackEventosAgrupados.set(abierto.id, [...(this.callbackEventosAgrupados.get(abierto.id) ?? []), evento]);
        return { ...actualizado, registro: "nota_agregada" };
      }
    }
    const created: CallbackRequest = { ...input, id: randomUUID(), resolved: false, createdAt: new Date().toISOString() };
    this.callbackRequests.push(created);
    return { ...created, registro: "nuevo" };
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
  async resolveActiveWhatsAppPhoneNumberId(organizationId: string, propertyId?: string | null): Promise<string | null> {
    if (propertyId) {
      for (const [phoneNumberId, v] of this.whatsappBranchChannels) {
        if (v.organizationId === organizationId && v.propertyId === propertyId) return phoneNumberId;
      }
    }
    for (const [phoneNumberId, orgId] of this.phoneNumberIdToOrg) {
      if (orgId === organizationId) return phoneNumberId;
    }
    return null;
  }

  /** Misma regla que `restaurantes.whatsapp_contador_agente` (migracion 047): un contador de mas de 2 h cuenta como 0. */
  async contadorAgenteWhatsApp(organizationId: string, phone: string, clave: ClaveContadorAgente, accion: "incrementar" | "reiniciar"): Promise<number | null> {
    const llave = `${organizationId}|${phone}|${clave}`;
    if (accion === "reiniciar") {
      this.contadoresAgente.delete(llave);
      return 0;
    }
    const previo = this.contadoresAgente.get(llave);
    const n = (previo && Date.now() - previo.at < CONTADOR_AGENTE_VIGENCIA_MS ? previo.n : 0) + 1;
    this.contadoresAgente.set(llave, { n, at: Date.now() });
    return n;
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
  private readonly voiceSecrets = new Map<string, { organizationId: string; propertyId: string; hash: string; hint: string; previousHash: string | null; previousUntilMs: number; rotatedAt: string }>();
  /** Solo pruebas: bitacora de voz en memoria. */
  readonly voiceToolAudit: VoiceToolAuditInput[] = [];
  /** Solo pruebas: simula la base sin migrar para secretos por sucursal. */
  voiceSecretsUnavailable = false;

  async verifyVoiceBranchSecret(organizationId: string, secretHash: string): Promise<VoiceSecretMatch> {
    if (this.voiceSecretsUnavailable) return { status: "unavailable" };
    for (const row of this.voiceSecrets.values()) {
      if (row.organizationId !== organizationId) continue;
      if (row.hash === secretHash) return { status: "match", propertyId: row.propertyId };
      if (row.previousHash === secretHash && row.previousUntilMs > Date.now()) return { status: "match", propertyId: row.propertyId };
    }
    return { status: "no_match" };
  }

  async rotateVoiceBranchSecret(organizationId: string, propertyId: string, secretHash: string, secretHint: string, graceSeconds: number): Promise<{ readonly rotatedAt: string }> {
    if (this.voiceSecretsUnavailable) throw new RestaurantesConfigUnavailableError();
    const key = `${organizationId}:${propertyId}`;
    const previous = this.voiceSecrets.get(key);
    const rotatedAt = new Date().toISOString();
    this.voiceSecrets.set(key, {
      organizationId,
      propertyId,
      hash: secretHash,
      hint: secretHint,
      previousHash: previous ? previous.hash : null,
      previousUntilMs: previous ? Date.now() + graceSeconds * 1000 : 0,
      rotatedAt,
    });
    return { rotatedAt };
  }

  async recordVoiceToolAudit(input: VoiceToolAuditInput): Promise<void> {
    this.voiceToolAudit.push(input);
  }

  private readonly orderFlows = new Map<string, { state: OrderFlowState; context: OrderFlowContext; version: number; expiresAtMs: number }>();
  /** Solo pruebas: simula una base sin migrar (`readOrderFlow` -> null, `writeOrderFlow` -> "unavailable"). */
  orderFlowUnavailable = false;

  async readOrderFlow(organizationId: string, flowKey: string): Promise<OrderFlowSnapshot | null> {
    if (this.orderFlowUnavailable) return null;
    const row = this.orderFlows.get(`${organizationId}:${flowKey}`);
    if (!row || row.expiresAtMs <= Date.now()) return { state: null, context: null, version: row && row.expiresAtMs <= Date.now() ? row.version : 0 };
    return { state: row.state, context: row.context, version: row.version };
  }

  async writeOrderFlow(
    organizationId: string,
    flowKey: string,
    expectedVersion: number,
    next: { readonly state: OrderFlowState; readonly context: OrderFlowContext },
    ttlSeconds: number,
  ): Promise<OrderFlowWriteResult> {
    if (this.orderFlowUnavailable) return "unavailable";
    const key = `${organizationId}:${flowKey}`;
    const row = this.orderFlows.get(key);
    const currentVersion = row?.version ?? 0;
    if (currentVersion !== expectedVersion) return "conflict";
    this.orderFlows.set(key, { state: next.state, context: next.context, version: currentVersion + 1, expiresAtMs: Date.now() + ttlSeconds * 1000 });
    return "written";
  }

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
    return eligible.map((row) => ({ id: row.id, attempts: row.attempts, payload: row.payload, organizationId: row.organizationId }));
  }

  /** false simula la base sin la migracion 066: el wamid no se guarda y registrarEstadoEntregaWhatsapp responde `no_disponible`. */
  estadosEntregaDisponibles = true;

  async markMessagingOutboxSent(id: string, detalle?: { readonly providerMessageId: string; readonly enviadoComo?: "texto" | "plantilla" | "botones" | "ubicacion" }): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "sent";
    if (!this.estadosEntregaDisponibles || !detalle || detalle.providerMessageId.length === 0) return;
    // Indice unico parcial (organizacion, wamid): un wamid repetido cierra el mensaje sin guardarlo.
    const repetido = [...this.outbox.values()].some((o) => o.organizationId === row.organizationId && o.providerMessageId === detalle.providerMessageId);
    if (repetido) return;
    row.providerMessageId = detalle.providerMessageId.slice(0, 255);
    row.enviadoComo = detalle.enviadoComo ?? null;
    row.deliveryStatus = "sent";
    row.deliveryUpdatedAt = Date.now();
  }

  /** Espejo de `restaurantes.registrar_estado_entrega_whatsapp` (066): mismo avance, mismo motivo, misma llave (organizacion + wamid). */
  async registrarEstadoEntregaWhatsapp(organizationId: string, estado: EstadoEntregaEntrante): Promise<RegistroEstadoEntrega> {
    const vacio = { outboxId: null, estado: null, eventType: null, motivoFallo: null, orderId: null, orderStatus: null, fallidasUltimaHora: 0, respaldoCorreo: null } as const;
    if (!this.estadosEntregaDisponibles) return { resultado: "no_disponible", ...vacio };
    const row = [...this.outbox.values()].find((o) => o.organizationId === organizationId && o.channel === "whatsapp" && o.providerMessageId === estado.wamid);
    if (!row) return { resultado: "desconocido", ...vacio };
    const nuevo = avanzarEstadoEntrega(row.deliveryStatus ?? null, estado.status);
    const cambia = nuevo !== (row.deliveryStatus ?? null);
    if (cambia) {
      if (nuevo === "failed") {
        const plantillaDisponible = typeof (row.payload as { template?: unknown } | null)?.template === "object" && (row.payload as { template?: unknown }).template !== null;
        const codigo = estado.errorCode;
        row.deliveryFailureReason =
          codigo === 131047 ? (row.enviadoComo === "texto" && plantillaDisponible ? "fuera_de_ventana_plantilla_sin_usar" : "fuera_de_ventana")
          : codigo === 131026 ? "numero_no_entregable"
          : codigo === 131049 ? "limite_marketing"
          : codigo !== null && codigo >= 132000 && codigo <= 132999 ? "plantilla"
          : "otro";
        row.deliveryErrorCode = codigo;
        row.deliveryErrorTitle = estado.errorTitle ? estado.errorTitle.slice(0, 120) : null;
      }
      row.deliveryStatus = nuevo;
      row.deliveryUpdatedAt = Date.now();
    }
    const m = /^order-status:([0-9a-fA-F-]{36}):(.+)$/.exec(row.dedupeKey);
    const hora = Date.now() - 3_600_000;
    // Como la funcion SQL: los datos del correo solo salen cuando ESTE status hace pasar un aviso de pedido a failed.
    const pedido = cambia && nuevo === "failed" && row.eventType.startsWith("order.status.") && m?.[1] ? await this.findOrderById(organizationId, m[1]) : null;
    return {
      resultado: cambia ? "actualizado" : "sin_cambio",
      outboxId: row.id,
      estado: nuevo,
      eventType: row.eventType,
      motivoFallo: nuevo === "failed" ? (row.deliveryFailureReason ?? null) : null,
      orderId: row.eventType.startsWith("order.status.") && m ? (m[1] ?? null) : null,
      orderStatus: row.eventType.startsWith("order.status.") && m ? (m[2] ?? null) : null,
      fallidasUltimaHora: [...this.outbox.values()].filter((o) => o.organizationId === organizationId && o.deliveryStatus === "failed" && (o.deliveryUpdatedAt ?? 0) > hora).length,
      respaldoCorreo: pedido?.customerEmail ? { to: pedido.customerEmail, clienteNombre: pedido.customerName, sucursal: pedido.branch ?? null, total: pedido.total } : null,
    };
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

  async acknowledgeStaffOrderNotification(organizationId: string, notificationId: string, actorId: string, propertyIds?: readonly string[] | null): Promise<StaffOrderNotificationRecord> {
    const existing = this.staffOrderNotifications.get(notificationId);
    if (!existing || existing.organizationId !== organizationId || (propertyIds && !propertyIds.includes(existing.propertyId))) {
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

  private readonly compensationCodes = new Map<string, string>();

  /** Solo pruebas: emite a `phone` un codigo de compensacion (espejo de solicitud_resolver con `descuento_proximo`). */
  seedCompensationCode(organizationId: string, phone: string, code: string): void {
    this.compensationCodes.set(`${organizationId}:${phone.replace(/\D/g, "").slice(-10)}`, code);
  }

  async findCompensationCode(organizationId: string, phone: string): Promise<string | null> {
    const code = this.compensationCodes.get(`${organizationId}:${phone.replace(/\D/g, "").slice(-10)}`);
    if (!code) return null;
    const p = await this.findPromotionByCode(organizationId, code);
    const now = Date.now();
    if (!p || !p.isActive || (p.maxUses !== null && p.timesUsed >= p.maxUses)) return null;
    if ((p.startsAt && Date.parse(p.startsAt) > now) || (p.endsAt && Date.parse(p.endsAt) < now)) return null;
    return code;
  }

  async listAutoApplyPromotions(organizationId: string): Promise<readonly Promotion[]> {
    return [...this.promotions.values()]
      .filter((p) => p.organizationId === organizationId && p.autoApply && p.isActive)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.code.localeCompare(b.code))
      .map((p) => ({ ...p }));
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
      channels: input.channels ?? null,
      productIds: input.productIds ?? null,
      autoApply: input.autoApply ?? false,
      courtesyProductIds: input.courtesyProductIds ?? null,
      courtesyQuantity: input.courtesyQuantity ?? null,
      propertyIds: input.propertyIds ?? null,
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
      channels: patch.channels !== undefined ? patch.channels : existing.channels,
      productIds: patch.productIds !== undefined ? patch.productIds : existing.productIds,
      autoApply: patch.autoApply ?? existing.autoApply,
      courtesyProductIds: patch.courtesyProductIds !== undefined ? patch.courtesyProductIds : existing.courtesyProductIds,
      courtesyQuantity: patch.courtesyQuantity !== undefined ? patch.courtesyQuantity : existing.courtesyQuantity,
      propertyIds: patch.propertyIds !== undefined ? patch.propertyIds : (existing.propertyIds ?? null),
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
    return entry ? { propertyId: entry.propertyId, productId: entry.productId, price: entry.price, isAvailable: entry.isAvailable, ...(entry.agotadoHasta !== undefined ? { agotadoHasta: entry.agotadoHasta } : {}) } : null;
  }

  async limpiarAgotadoHasta(propertyId: string, productId: string): Promise<void> {
    const entry = this.branchProducts.find((bp) => bp.propertyId === propertyId && bp.productId === productId);
    if (entry) entry.agotadoHasta = null;
  }

  /** Pruebas: deja la reposición programada (`agotado_hasta`) que escribe `agotado_marcar` (migración 050). */
  marcarAgotadoHastaParaPruebas(propertyId: string, productId: string, hasta: string): void {
    const entry = this.branchProducts.find((bp) => bp.propertyId === propertyId && bp.productId === productId);
    if (entry) entry.agotadoHasta = hasta;
  }

  /** Doble de `restaurantes.agotados_reponer` (migración 050) para pruebas: devuelve a la venta lo que está apagado CON reposición
   * programada que ya venció (`agotadoHasta <= hoy`). Lo apagado sin `agotadoHasta` nunca se reactiva solo. */
  reponerAgotadosVencidos(hoy: string): readonly { readonly propertyId: string; readonly productId: string }[] {
    const repuestos: { propertyId: string; productId: string }[] = [];
    for (const bp of this.branchProducts) {
      if (!bp.agotadoHasta || bp.isAvailable || bp.agotadoHasta > hoy) continue;
      bp.isAvailable = true;
      bp.agotadoHasta = null;
      repuestos.push({ propertyId: bp.propertyId, productId: bp.productId });
    }
    return repuestos;
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

  async setBranchProductAvailability(propertyId: string, productId: string, isAvailable: boolean): Promise<BranchProductState | null> {
    const existing = this.branchProducts.find((bp) => bp.propertyId === propertyId && bp.productId === productId);
    if (!existing) return null;
    existing.isAvailable = isAvailable;
    return { propertyId, productId, price: existing.price, isAvailable };
  }

  async findOrderById(organizationId: string, orderId: string): Promise<Order | null> {
    const order = this.orders.find((o) => o.id === orderId && o.organizationId === organizationId);
    return order ?? null;
  }

  async findLatestOrderByPhone(organizationId: string, customerPhone: string, sinceIso: string): Promise<Order | null | undefined> {
    const sinceMs = Date.parse(sinceIso);
    const mios = this.orders
      .filter((o) => o.organizationId === organizationId && o.status !== "cancelado" && Date.parse(o.createdAt) >= sinceMs && o.customerPhone.replace(/\D/g, "").slice(-10) === customerPhone)
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
    return mios[0] ?? null;
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

  async updateOrderStatus(organizationId: string, orderId: string, fromStatus: OrderStatus, toStatus: OrderStatus, incidentNote?: string | null): Promise<Order | null> {
    // Mismo espejo del fix TOCTOU de postgres-repository.ts: la guarda de estado
    // vive en el `findIndex`, no en una validación aparte.
    const index = this.orders.findIndex((o) => o.id === orderId && o.organizationId === organizationId && o.status === fromStatus);
    if (index === -1) return null;
    const existing = this.orders[index]!;
    const updated: Order = { ...existing, status: toStatus, ...(toStatus === "problema" && incidentNote ? { incidentNote } : {}) };
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

  async listDeliveredOrdersForRepartidor(organizationId: string, repartidorId: string, fechaLocal: string, zonaHoraria: string): Promise<readonly Order[]> {
    return this.orders
      .filter((o) => o.organizationId === organizationId && o.assignedRepartidorId === repartidorId && o.deliveredAt && diaLocalSucursal(new Date(o.deliveredAt), zonaHoraria).fecha === fechaLocal)
      .sort((a, b) => (b.deliveredAt ?? "").localeCompare(a.deliveredAt ?? ""))
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
    const updated: Order = {
      ...existing,
      status: toStatus,
      incidentNote: toStatus === "problema" ? incidentNote : existing.incidentNote,
      deliveredAt: toStatus === "entregado" ? new Date().toISOString() : existing.deliveredAt,
    };
    this.orders[index] = updated;
    return updated;
  }

  async findCustomerById(organizationId: string, customerId: string): Promise<Customer | null> {
    const customer = this.customers.get(customerId);
    return customer && customer.organizationId === organizationId ? customer : null;
  }

  /** Nivel de TODOS los clientes de la organizacion (espejo de `restaurantes.customer_tiers`, migracion 054). */
  private tiersDeOrganizacion(organizationId: string): Map<string, CustomerTier | null> {
    const clientes = [...this.customers.values()].filter((c) => c.organizationId === organizationId);
    const resultado = new Map<string, CustomerTier | null>();
    const gastoPorCliente = this.gastoPorClienteDeOrganizacion(organizationId);
    const metrica = chooseTierMetric(clientes, gastoPorCliente);
    if (metrica === "sin_datos") {
      for (const c of clientes) resultado.set(c.id, null);
      return resultado;
    }
    const valueOf = (c: Customer) => (metrica === "gasto" ? (gastoPorCliente.get(c.id) ?? 0) : c.orderCount);
    const percentiles = computeMidRankPercentiles(clientes, valueOf);
    for (const c of clientes) resultado.set(c.id, tierFromPercentile(percentiles.get(c) ?? 0));
    return resultado;
  }

  private ultimoPedidoDeCliente(customerId: string): string | null {
    let ultimo: string | null = null;
    for (const o of this.orders) {
      if (o.customerId === customerId && (ultimo === null || o.createdAt > ultimo)) ultimo = o.createdAt;
    }
    return ultimo;
  }

  async listCustomers(organizationId: string, filter: CustomerListFilter): Promise<CustomerListPage> {
    const search = filter.search?.trim().toLowerCase();
    const tiers = this.tiersDeOrganizacion(organizationId);
    const limiteInactivoMs = filter.inactivoDias === undefined ? null : Date.now() - filter.inactivoDias * 86_400_000;
    let matching = [...this.customers.values()].filter((c) => {
      if (c.organizationId !== organizationId) return false;
      if (search && !(c.name?.toLowerCase().includes(search) || c.phone.includes(search))) return false;
      if (filter.nivel !== undefined && tiers.get(c.id) !== filter.nivel) return false;
      if (filter.frecuencia === "una_vez" && c.orderCount !== 1) return false;
      if (filter.frecuencia === "recurrentes" && c.orderCount < 2) return false;
      if (limiteInactivoMs !== null) {
        const ultimo = this.ultimoPedidoDeCliente(c.id);
        // Quien nunca ha pedido cuenta como "sin pedir" (igual que clientes_cartera).
        if (ultimo !== null && Date.parse(ultimo) >= limiteInactivoMs) return false;
      }
      if (filter.propertyId !== undefined && !this.orders.some((o) => o.customerId === c.id && o.propertyId === filter.propertyId)) return false;
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

    const page = matching.slice(0, filter.limit).map((c) => ({ ...c, tier: tiers.get(c.id) ?? null, lastOrderAt: this.ultimoPedidoDeCliente(c.id) }));
    const nextCursor = matching.length > filter.limit ? page[page.length - 1]!.id : null;
    return { customers: page, nextCursor, filtrosDisponibles: true };
  }

  async getCarteraKpis(organizationId: string): Promise<CarteraKpis> {
    const clientes = [...this.customers.values()].filter((c) => c.organizationId === organizationId);
    const vigentes = new Set(["pending", "preparando", "en_camino", "entregado", "completado"]);
    const pedidos = this.orders.filter((o) => o.organizationId === organizationId && o.customerId && vigentes.has(o.status));
    const ticket = pedidos.length === 0 ? null : Math.round((pedidos.reduce((suma, o) => suma + o.total, 0) / pedidos.length) * 100) / 100;
    const conPedidos = clientes
      .filter((c) => c.orderCount > 0)
      .sort((a, b) => b.orderCount - a.orderCount || (this.ultimoPedidoDeCliente(b.id) ?? "").localeCompare(this.ultimoPedidoDeCliente(a.id) ?? "") || a.id.localeCompare(b.id));
    const top = conPedidos[0];
    return {
      disponible: true,
      total: clientes.length,
      recurrentes: clientes.filter((c) => c.orderCount >= 2).length,
      ticketPromedio: ticket,
      masFrecuente: top ? { customerId: top.id, orderCount: top.orderCount, ultimoPedidoEn: this.ultimoPedidoDeCliente(top.id) } : null,
    };
  }

  private readonly customerNotes = new Map<string, string>();
  /** Lo que escribio una importacion (procedencia: customers.import_nombre / import_notas / customer_addresses.from_import). */
  private readonly importNombre = new Map<string, string>();
  private readonly importNotas = new Map<string, string>();
  private readonly direccionesImportadas = new Set<string>();
  private readonly importacionesClientes = new Map<string, Extract<ResultadoImportacionClientes, { disponible: true }>>();

  async importarClientes(organizationId: string, huella: string, filas: readonly FilaImportacionCliente[]): Promise<ResultadoImportacionClientes> {
    // Un solo hilo: el chequeo + escritura son sincronos, asi que dos llamadas "simultaneas" nunca se entrelazan (espejo de la huella unica).
    const clave = `${organizationId}:${huella}`;
    const previa = this.importacionesClientes.get(clave);
    if (previa) return { ...previa, yaImportado: true };
    let creados = 0;
    let actualizados = 0;
    let sinCambios = 0;
    let rechazados = 0;
    const vistos = new Set<string>();
    for (const f of filas) {
      if (!/^[0-9]{10}$/.test(f.phone)) {
        rechazados += 1;
        continue;
      }
      const key = `${organizationId}:${f.phone}`;
      const existenteId = this.customerIdByOrgPhone.get(key);
      let id: string;
      if (!existenteId) {
        id = randomUUID();
        this.customers.set(id, { id, organizationId, phone: f.phone, name: f.name, orderCount: 0 });
        this.customerIdByOrgPhone.set(key, id);
        if (f.name) this.importNombre.set(id, f.name);
        if (f.notes) {
          this.customerNotes.set(id, f.notes);
          this.importNotas.set(id, f.notes);
        }
        creados += 1;
      } else {
        id = existenteId;
        const actual = this.customers.get(id)!;
        // Completa lo vacio y CORRIGE solo lo que una importacion anterior escribio y nadie cambio despues (mismo contrato que la funcion SQL).
        const nota = this.customerNotes.get(id) ?? null;
        const repetido = vistos.has(f.phone); // un telefono repetido dentro del MISMO archivo no se corrige a si mismo
        const nombreFinal = f.name === null ? actual.name : actual.name === null ? f.name : !repetido && this.importNombre.get(id) === actual.name ? f.name : actual.name;
        const notaFinal = f.notes === null ? nota : nota === null ? f.notes : !repetido && this.importNotas.get(id) === nota ? f.notes : nota;
        if (nombreFinal !== actual.name) {
          this.customers.set(id, { ...actual, name: nombreFinal });
          if (nombreFinal) this.importNombre.set(id, nombreFinal);
        }
        if (notaFinal !== nota && notaFinal !== null) {
          this.customerNotes.set(id, notaFinal);
          this.importNotas.set(id, notaFinal);
        }
        if (nombreFinal !== actual.name || notaFinal !== nota) actualizados += 1;
        else sinCambios += 1;
      }
      vistos.add(f.phone);
      if (f.address) {
        const existia = (this.addresses.get(id) ?? []).some((a) => a.address === f.address);
        await this.addCustomerAddressIfNew(id, f.address, organizationId);
        if (!existia) {
          this.direccionesImportadas.add(`${id}|${f.address}`);
          const lista = this.addresses.get(id) ?? [];
          // Domicilio nuevo de esta importacion: si el predeterminado actual tambien vino de una importacion, pasa a ser este.
          if (lista.some((a) => a.isDefault && a.address !== f.address && this.direccionesImportadas.has(`${id}|${a.address}`))) {
            this.addresses.set(id, lista.map((a) => ({ ...a, isDefault: a.address === f.address })));
          }
        }
      }
    }
    const resultado = { disponible: true as const, yaImportado: false, total: filas.length, creados, actualizados, sinCambios, rechazados };
    this.importacionesClientes.set(clave, resultado);
    return resultado;
  }

  async getCustomerNotes(organizationId: string, customerId: string): Promise<string | null> {
    const cliente = this.customers.get(customerId);
    return cliente && cliente.organizationId === organizationId ? (this.customerNotes.get(customerId) ?? null) : null;
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
    const branchOwner = this.whatsappBranchChannels.get(phoneNumberId);
    if (branchOwner && branchOwner.organizationId !== organizationId) throw new WhatsappNumberInUseError();
    const legacyOwner = this.phoneNumberIdToOrg.get(phoneNumberId);
    if (legacyOwner && legacyOwner !== organizationId) throw new WhatsappNumberInUseError();
    // Un solo `phone_number_id` por organización (PK real de la tabla) -- limpia
    // cualquier entrada previa de ESTA organización antes de fijar la nueva.
    for (const [existingPhoneNumberId, orgId] of this.phoneNumberIdToOrg) {
      if (orgId === organizationId) this.phoneNumberIdToOrg.delete(existingPhoneNumberId);
    }
    this.phoneNumberIdToOrg.set(phoneNumberId, organizationId);
    return { phoneNumberId };
  }

  async findStorefrontMarca(organizationId: string): Promise<StorefrontMarca | null> {
    return this.storefrontMarcas.get(organizationId) ?? null;
  }

  async upsertStorefrontMarca(organizationId: string, input: StorefrontMarcaInput): Promise<StorefrontMarca> {
    const guardada: StorefrontMarca = { ...input, updatedAt: new Date().toISOString() };
    this.storefrontMarcas.set(organizationId, guardada);
    return guardada;
  }

  async listKnownZones(organizationId: string): Promise<readonly KnownZone[]> {
    return this.knownZones
      .filter((z) => z.organizationId === organizationId)
      .map((z) => ({ id: z.id!, organizationId: z.organizationId, name: z.name, lat: z.lat, lng: z.lng, createdAt: z.createdAt! }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id.localeCompare(a.id)));
  }

  async listColoniasReferencia(organizationId: string): Promise<ColoniasReferenciaLectura> {
    return {
      disponible: true,
      zonas: this.knownZones
        .filter((z) => z.organizationId === organizationId)
        .map((z) => ({
          zoneId: z.id!,
          name: z.name,
          lat: z.lat,
          lng: z.lng,
          fuente: z.fuente ?? null,
          asignacionFuente: z.asignacionFuente ?? null,
          refSucursalSlug: z.refSucursalSlug ?? null,
          refKm: z.refKm ?? null,
          ref2SucursalSlug: z.ref2SucursalSlug ?? null,
          ref2Km: z.ref2Km ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "es")),
    };
  }

  async createKnownZone(organizationId: string, input: NewKnownZoneInput): Promise<KnownZone> {
    const zone: StoredKnownZone & { readonly id: string; readonly createdAt: string } = { id: randomUUID(), organizationId, name: input.name, lat: input.lat, lng: input.lng, createdAt: new Date().toISOString() };
    this.knownZones.push(zone);
    return zone;
  }

  async deleteKnownZone(organizationId: string, zoneId: string): Promise<boolean> {
    const idx = this.knownZones.findIndex((z) => z.id === zoneId && z.organizationId === organizationId);
    if (idx < 0) return false;
    this.knownZones.splice(idx, 1);
    return true;
  }

  // ---- FASE 3 (producto) -- zona horaria por negocio (migración 022) ----
  async findBranchZonaHoraria(propertyId: string): Promise<BranchTimezoneConfig> {
    return { zonaHoraria: this.branchZonaHoraria.get(propertyId) ?? null };
  }

  async upsertBranchZonaHoraria(propertyId: string, zonaHoraria: string | null): Promise<BranchTimezoneConfig> {
    // Mismo contrato que Postgres real (UPDATE, nunca upsert -- la fila de
    // `branch_detail` de una property SIEMPRE existe, ver el comentario de
    // cabecera de `PostgresRestaurantesRepository.upsertBranchZonaHoraria`).
    if (!this.branches.has(propertyId)) throw new Error(`upsertBranchZonaHoraria: la property "${propertyId}" no existe.`);
    this.branchZonaHoraria.set(propertyId, zonaHoraria);
    return { zonaHoraria };
  }

  // ---- Agente de WhatsApp por organizacion/sucursal (migracion 029) ----
  async findWhatsAppAgentConfig(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null> {
    const propia = propertyId ? this.whatsAppAgentConfigs.get(`${organizationId}:${propertyId}`) : undefined;
    return propia ?? this.whatsAppAgentConfigs.get(`${organizationId}:`) ?? null;
  }

  async upsertWhatsAppAgentConfig(organizationId: string, propertyId: string | null, config: WhatsAppAgentConfigInput): Promise<WhatsAppAgentConfigRow> {
    // Mismo contrato que el `with check` de la policy: la property debe ser de la organizacion.
    if (propertyId && this.branches.get(propertyId)?.organizationId !== organizationId) throw new Error(`upsertWhatsAppAgentConfig: la property "${propertyId}" no pertenece a la organizacion.`);
    const row: WhatsAppAgentConfigRow = { ...config, propertyId };
    this.whatsAppAgentConfigs.set(`${organizationId}:${propertyId ?? ""}`, row);
    return row;
  }

  async findWhatsAppAgentConfigExacta(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null> {
    return this.whatsAppAgentConfigs.get(`${organizationId}:${propertyId ?? ""}`) ?? null;
  }

  /** `true` simula la base sin la migracion 033 (solo el guardado de 029, sin historial ni version). */
  whatsAppAgentConfigSin033 = false;
  /** `true` simula la base con la 033 pero SIN la 039 (PM-C5): guarda todo menos el umbral de pedido grande y la espera de rafagas. */
  whatsAppAgentConfigSin039 = false;
  readonly whatsAppAgentConfigHistorial: Array<WhatsAppAgentConfigHistorialEntry & { readonly organizationId: string }> = [];

  async guardarWhatsAppAgentConfig(
    organizationId: string,
    propertyId: string | null,
    config: WhatsAppAgentConfigInput,
    meta: { readonly accion: WhatsAppAgentConfigAccion; readonly actorUserId: string; readonly versionEsperada: number | null },
  ): Promise<WhatsAppAgentConfigRow> {
    if (propertyId && this.branches.get(propertyId)?.organizationId !== organizationId) throw new Error(`guardarWhatsAppAgentConfig: la property "${propertyId}" no pertenece a la organizacion.`);
    if (this.whatsAppAgentConfigSin033) {
      const usaCamposNuevos = Boolean(
        config.greetingText || config.salsasText || config.promosText || (config.escalationReasonsOff?.length ?? 0) > 0 || config.largeOrderText || (config.replyDebounceSeconds !== null && config.replyDebounceSeconds !== undefined),
      );
      if (usaCamposNuevos) throw new RestaurantesConfigUnavailableError();
      return this.upsertWhatsAppAgentConfig(organizationId, propertyId, config);
    }
    if (this.whatsAppAgentConfigSin039) {
      // Sin la 039 no se puede guardar el umbral ni la espera, y nunca se descartan en silencio.
      if (config.largeOrderText || (config.replyDebounceSeconds !== null && config.replyDebounceSeconds !== undefined)) throw new RestaurantesConfigUnavailableError();
    }
    const previa = await this.findWhatsAppAgentConfigExacta(organizationId, propertyId);
    const versionVigente = previa?.version ?? (previa ? 1 : 0);
    if (meta.versionEsperada !== null && meta.versionEsperada !== versionVigente) throw new WhatsAppAgentConfigConflictError();
    const row: WhatsAppAgentConfigRow = { ...config, propertyId, version: versionVigente + 1 };
    this.whatsAppAgentConfigs.set(`${organizationId}:${propertyId ?? ""}`, row);
    this.whatsAppAgentConfigHistorial.push({
      organizationId,
      version: row.version!,
      accion: meta.accion,
      propertyId,
      anterior: previa ? fotoConfigAgente(previa) : null,
      nuevo: fotoConfigAgente(row)!,
      actorUserId: meta.actorUserId,
      actorNombre: null,
      creadoAt: new Date().toISOString(),
    });
    return row;
  }

  async listWhatsAppAgentConfigHistorial(organizationId: string, propertyId: string | null, limit: number): Promise<readonly WhatsAppAgentConfigHistorialEntry[]> {
    if (this.whatsAppAgentConfigSin033) return [];
    return this.whatsAppAgentConfigHistorial
      .filter((h) => h.organizationId === organizationId && h.propertyId === propertyId)
      .sort((a, b) => b.version - a.version)
      .slice(0, limit);
  }

  // ---- Modelo PM (migracion 023) ----
  async listarConocimiento(organizationId: string): Promise<ConocimientoLectura> {
    return this.conocimiento.listar(organizationId);
  }

  async listarConocimientoPublicado(organizationId: string, propertyId: string | null): Promise<readonly ConocimientoEntrada[]> {
    return this.conocimiento.listarPublicado(organizationId, propertyId);
  }

  async crearConocimiento(organizationId: string, actorId: string, input: NuevaConocimientoEntrada): Promise<ConocimientoEntrada> {
    return this.conocimiento.crear(organizationId, actorId, input);
  }

  async actualizarConocimiento(organizationId: string, actorId: string, id: string, patch: ConocimientoPatch): Promise<ConocimientoEntrada | null> {
    return this.conocimiento.actualizar(organizationId, actorId, id, patch);
  }

  async borrarConocimiento(organizationId: string, id: string): Promise<boolean> {
    return this.conocimiento.borrar(organizationId, id);
  }

  async findAgenteWhatsappActivo(propertyId: string): Promise<boolean> {
    return this.conocimiento.agenteActivo(propertyId);
  }

  async listarAgentesWhatsappApagados(organizationId: string): Promise<{ readonly disponible: boolean; readonly propertyIdsApagados: readonly string[] }> {
    return this.conocimiento.agentesApagadosDe(organizationId);
  }

  async fijarAgenteWhatsappActivo(organizationId: string, propertyId: string, _actorId: string, activo: boolean): Promise<void> {
    this.conocimiento.fijarAgenteActivo(organizationId, propertyId, activo);
  }

  async findBranchPolicy(propertyId: string): Promise<BranchPolicy> {
    return this.branchPolicies.get(propertyId) ?? EMPTY_BRANCH_POLICY;
  }

  async upsertBranchPolicy(organizationId: string, propertyId: string, policy: BranchPolicy): Promise<BranchPolicy> {
    // Mismo contrato que el `with check` de la policy: la property debe ser de la organizacion.
    if (this.branches.get(propertyId)?.organizationId !== organizationId) throw new Error(`upsertBranchPolicy: la property "${propertyId}" no pertenece a la organizacion.`);
    this.branchPolicies.set(propertyId, { ...policy });
    return policy;
  }

  async listBranchHoursExceptions(propertyId: string, fechaDesde: string, fechaHasta: string): Promise<readonly BranchHoursException[]> {
    return this.branchHoursExceptions.filter((e) => e.propertyId === propertyId && e.fechaDesde <= fechaHasta && e.fechaHasta >= fechaDesde).map((e) => ({ ...e }));
  }

  async listUpcomingBranchHoursExceptions(organizationId: string, desdeFecha: string): Promise<readonly BranchHoursException[]> {
    return this.branchHoursExceptions
      .filter((e) => this.branches.get(e.propertyId)?.organizationId === organizationId && e.fechaHasta >= desdeFecha)
      .sort((a, b) => a.fechaDesde.localeCompare(b.fechaDesde))
      .map((e) => ({ ...e }));
  }

  async createBranchHoursException(organizationId: string, input: NewBranchHoursExceptionInput): Promise<BranchHoursException> {
    // Mismo contrato que el `with check` de la policy: la property debe ser de la organizacion.
    if (this.branches.get(input.propertyId)?.organizationId !== organizationId) throw new Error(`createBranchHoursException: la property "${input.propertyId}" no pertenece a la organizacion.`);
    const created: BranchHoursException = { id: randomUUID(), propertyId: input.propertyId, fechaDesde: input.fechaDesde, fechaHasta: input.fechaHasta, horario: input.horario, motivo: input.motivo ?? null };
    this.branchHoursExceptions.push(created);
    return { ...created };
  }

  async deleteBranchHoursException(organizationId: string, exceptionId: string): Promise<boolean> {
    const index = this.branchHoursExceptions.findIndex((e) => e.id === exceptionId && this.branches.get(e.propertyId)?.organizationId === organizationId);
    if (index < 0) return false;
    this.branchHoursExceptions.splice(index, 1);
    return true;
  }

  async listOrderPickupInfo(organizationId: string, orderIds: readonly string[]): Promise<readonly OrderPickupInfo[]> {
    const wanted = new Set(orderIds);
    return this.orders
      .filter((o) => o.organizationId === organizationId && wanted.has(o.id) && this.orderPickupInfo.has(o.id))
      .map((o) => ({ orderId: o.id, ...this.orderPickupInfo.get(o.id)! }));
  }

  // ---- Pedidos programados (migracion 034), espejo en memoria ----

  /** Solo para pruebas: simula una base sin la migracion 034. */
  setScheduledOrdersSupported(supported: boolean): void {
    this.scheduledOrdersSupported = supported;
  }

  async supportsScheduledOrders(): Promise<boolean> {
    return this.scheduledOrdersSupported;
  }

  async listOrderScheduleInfo(organizationId: string, orderIds: readonly string[]): Promise<readonly OrderScheduleInfo[]> {
    if (!this.scheduledOrdersSupported) return [];
    const wanted = new Set(orderIds);
    return this.orders
      .filter((o) => o.organizationId === organizationId && wanted.has(o.id) && o.programadoPara)
      .map((o) => ({ orderId: o.id, programadoPara: o.programadoPara ?? null, promovidoAt: o.promovidoAt ?? null }));
  }

  async listScheduledOrders(organizationId: string, filter: { readonly propertyIds: readonly string[] | null; readonly limit: number }): Promise<ScheduledOrdersResult> {
    if (!this.scheduledOrdersSupported) return { disponible: false, orders: [] };
    const scope = filter.propertyIds ? new Set(filter.propertyIds) : null;
    const orders = this.orders
      .filter((o) => o.organizationId === organizationId && o.status === "programado" && (scope === null || scope.has(o.propertyId)))
      .sort((a, b) => (a.programadoPara ?? "").localeCompare(b.programadoPara ?? "") || a.id.localeCompare(b.id))
      .slice(0, filter.limit);
    return { disponible: true, orders };
  }

  async promoteDueScheduledOrders(
    organizationId: string | null,
    options: { readonly now: Date; readonly anticipacionMin: number; readonly propertyIds?: readonly string[] | null },
  ): Promise<PromotedScheduledOrdersResult> {
    if (!this.scheduledOrdersSupported) return { disponible: false, promoted: [] };
    const scope = options.propertyIds ? new Set(options.propertyIds) : null;
    const limitMs = options.now.getTime() + Math.min(Math.max(options.anticipacionMin, 0), 1440) * 60_000;
    const promoted: Order[] = [];
    // Espejo del UPDATE ... WHERE status = 'programado': solo toca programados (un cancelado nunca se promueve).
    const due = this.orders
      .filter(
        (o) =>
          o.status === "programado" &&
          (organizationId === null || o.organizationId === organizationId) &&
          (scope === null || scope.has(o.propertyId)) &&
          // Espejo de la migracion 041: una sucursal desactivada no manda sus programados a cocina.
          this.branches.get(o.propertyId)?.status === "active" &&
          o.programadoPara !== undefined &&
          o.programadoPara !== null &&
          Date.parse(o.programadoPara) <= limitMs,
      )
      .sort((a, b) => (a.programadoPara ?? "").localeCompare(b.programadoPara ?? ""));
    for (const o of due.slice(0, 1000)) {
      const index = this.orders.findIndex((x) => x.id === o.id);
      const updated: Order = { ...this.orders[index]!, status: "pending", promovidoAt: options.now.toISOString() };
      this.orders[index] = updated;
      promoted.push(updated);
    }
    return { disponible: true, promoted };
  }

  async listPromotedOrdersWithoutComanda(options: { readonly hours: number; readonly limit: number }): Promise<readonly Order[]> {
    const desde = Date.now() - options.hours * 3_600_000;
    return this.orders
      .filter((o) => o.promovidoAt && Date.parse(o.promovidoAt) >= desde && (o.status === "pending" || o.status === "preparando"))
      .sort((a, b) => (a.promovidoAt ?? "").localeCompare(b.promovidoAt ?? ""))
      .slice(0, options.limit);
  }

  async listBranchDeliveryZoneIds(propertyId: string): Promise<readonly string[]> {
    return [...(this.branchDeliveryZones.get(propertyId) ?? [])].sort();
  }

  async replaceBranchDeliveryZones(organizationId: string, propertyId: string, zoneIds: readonly string[]): Promise<readonly string[]> {
    if (this.branches.get(propertyId)?.organizationId !== organizationId) throw new Error(`replaceBranchDeliveryZones: la property "${propertyId}" no pertenece a la organizacion.`);
    for (const id of zoneIds) {
      if (!this.knownZones.some((z) => z.id === id && z.organizationId === organizationId)) throw new Error(`replaceBranchDeliveryZones: la zona "${id}" no pertenece a la organizacion.`);
    }
    const next = new Set(zoneIds);
    this.branchDeliveryZones.set(propertyId, next);
    return [...next].sort();
  }

  async resolveWhatsAppChannel(phoneNumberId: string): Promise<WhatsAppChannelResolution | null> {
    const branch = this.whatsappBranchChannels.get(phoneNumberId);
    if (branch) return { organizationId: branch.organizationId, propertyId: branch.propertyId };
    const organizationId = this.phoneNumberIdToOrg.get(phoneNumberId);
    return organizationId ? { organizationId, propertyId: null } : null;
  }

  async listWhatsappBranchChannels(organizationId: string): Promise<readonly WhatsappBranchChannel[]> {
    return [...this.whatsappBranchChannels.entries()]
      .filter(([, v]) => v.organizationId === organizationId)
      .map(([phoneNumberId, v]) => ({ propertyId: v.propertyId, phoneNumberId }));
  }

  async upsertWhatsappBranchChannel(organizationId: string, propertyId: string, phoneNumberId: string): Promise<WhatsappBranchChannel> {
    if (this.branches.get(propertyId)?.organizationId !== organizationId) throw new Error(`upsertWhatsappBranchChannel: la property "${propertyId}" no pertenece a la organizacion.`);
    // PRIMARY KEY + guardia de unicidad cruzada de la migracion 023.
    const branchOwner = this.whatsappBranchChannels.get(phoneNumberId);
    if (branchOwner && (branchOwner.organizationId !== organizationId || branchOwner.propertyId !== propertyId)) throw new WhatsappNumberInUseError();
    const legacyOwner = this.phoneNumberIdToOrg.get(phoneNumberId);
    if (legacyOwner && legacyOwner !== organizationId) throw new WhatsappNumberInUseError();
    for (const [existing, v] of this.whatsappBranchChannels) {
      if (v.propertyId === propertyId) this.whatsappBranchChannels.delete(existing);
    }
    this.whatsappBranchChannels.set(phoneNumberId, { organizationId, propertyId });
    return { propertyId, phoneNumberId };
  }

  async deleteWhatsappBranchChannel(organizationId: string, propertyId: string): Promise<boolean> {
    for (const [phoneNumberId, v] of this.whatsappBranchChannels) {
      if (v.propertyId === propertyId && v.organizationId === organizationId) {
        this.whatsappBranchChannels.delete(phoneNumberId);
        return true;
      }
    }
    return false;
  }

  async listNoDomicilioMarks(organizationId: string): Promise<NoDomicilioMarks> {
    return {
      productIds: [...this.noDomicilioProducts].filter((id) => this.products.get(id)?.organizationId === organizationId),
      categoryIds: [...this.noDomicilioCategories].filter((id) => this.categories.get(id)?.organizationId === organizationId),
    };
  }

  async setProductNoDomicilio(organizationId: string, productId: string, noDomicilio: boolean): Promise<boolean> {
    if (this.products.get(productId)?.organizationId !== organizationId) return false;
    if (noDomicilio) this.noDomicilioProducts.add(productId);
    else this.noDomicilioProducts.delete(productId);
    return true;
  }

  async setCategoryNoDomicilio(organizationId: string, categoryId: string, noDomicilio: boolean): Promise<boolean> {
    if (this.categories.get(categoryId)?.organizationId !== organizationId) return false;
    if (noDomicilio) this.noDomicilioCategories.add(categoryId);
    else this.noDomicilioCategories.delete(categoryId);
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
