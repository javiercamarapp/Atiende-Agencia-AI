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
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import * as cliente360 from "./cliente-360/postgres.ts";
import type { CustomerAddressChanges, CustomerPolicy, CustomerProfilePatch, OrderClosureInput, PreferenceAction } from "./cliente-360/types.ts";
import type { OrderFlowContext, OrderFlowSnapshot, OrderFlowState, OrderFlowWriteResult } from "./agent-tools/order-flow.ts";
import type { ConocimientoEntrada, ConocimientoLectura, ConocimientoPatch, NuevaConocimientoEntrada } from "./conocimiento/types.ts";
import {
  pgActualizarConocimiento,
  pgAgenteWhatsappActivo,
  pgBorrarConocimiento,
  pgCrearConocimiento,
  pgFijarAgenteWhatsappActivo,
  pgListarAgentesApagados,
  pgListarConocimiento,
  pgListarConocimientoPublicado,
} from "./conocimiento/postgres.ts";
import { OrderConflictError, WhatsAppAgentConfigConflictError, WhatsappNumberInUseError } from "./errors.ts";
import type { VoiceSecretMatch, VoiceToolAuditInput } from "./types.ts";
import type {
  Branch,
  BranchProductState,
  BranchHoursException,
  BranchPolicy,
  MotivoEscalacionDesactivable,
  WhatsAppAgentConfigAccion,
  WhatsAppAgentConfigHistorialEntry,
  WhatsAppAgentConfigInput,
  WhatsAppAgentConfigRow,
  CanalPedido,
  NewBranchHoursExceptionInput,
  OrderPickupInfo,
  OrderScheduleInfo,
  BranchSummary,
  BranchTimezoneConfig,
  CallbackRequest,
  CallbackRegistro,
  CallbackRequestInput,
  Category,
  CategoryPatch,
  Customer,
  CustomerAddress,
  CustomerListFilter,
  CarteraKpis,
  CustomerListItem,
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
  RestaurantesAuditLogRow,
  WhatsAppChannelResolution,
  WhatsappBranchChannel,
  StorefrontMarca,
  StorefrontMarcaInput,
  WhatsappChannelConfig,
  StorefrontCatalogRow,
  StorefrontOrderTracking,
  StorefrontTrackingResult,
} from "./types.ts";
import type { ClaveContadorAgente } from "./whatsapp/contadores-agente.ts";
import { EMPTY_BRANCH_POLICY, MOTIVOS_ESCALACION_DESACTIVABLES, TONOS_AGENTE_WHATSAPP, type TonoAgenteWhatsApp } from "./types.ts";
import { fotoConfigAgente } from "./whatsapp/agent-config-editor.ts";
import { leerHorarioPersistido } from "./horarios.ts";
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
  TierDistributionMetric,
  TierDistributionRow,
  WhatsAppConversationStatsRow,
} from "./repository.ts";
import { RestaurantesConfigUnavailableError } from "./repository.ts";

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
  readonly no_domicilio?: boolean;
}

interface StorefrontCatalogDbRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: string;
  readonly image_url: string | null;
  readonly is_popular: boolean;
  readonly is_available: boolean;
  readonly category_id: string | null;
  readonly category_name: string | null;
  readonly category_display_order: number | string;
  readonly display_order: number | string;
  readonly no_domicilio?: boolean;
}

interface StorefrontTrackingDbPayload {
  readonly status: string;
  readonly branch: string | null;
  readonly total: string | number;
  readonly payment_method: string | null;
  readonly canal: string;
  readonly created_at: string;
  readonly items: ReadonlyArray<{ readonly name?: string; readonly quantity?: number | string; readonly tortilla?: string | null }>;
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

interface CustomerCarteraRow {
  readonly customer_id: string;
  readonly phone: string;
  readonly name: string | null;
  readonly order_count: number;
  readonly last_order_at: unknown;
  readonly tier: string | null;
}

function isoOrNullCustomer(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function mapCustomerCartera(organizationId: string, r: CustomerCarteraRow): CustomerListItem {
  const tier = r.tier === "BLACK" || r.tier === "PLATINUM" || r.tier === "GOLD" || r.tier === "BLUE" ? r.tier : null;
  return { id: r.customer_id, organizationId, phone: r.phone, name: r.name, orderCount: r.order_count, tier, lastOrderAt: isoOrNullCustomer(r.last_order_at) };
}

/** `%` `_` `\` del texto buscado son literales, no comodines (el listado anterior ya lo hacia). */
function escapeLike(texto: string): string {
  return texto.replace(/[\\%_]/g, "\\$&");
}

/** SQLSTATE de funcion/tabla/columna inexistente = la base aun no tiene la migracion 054. */
function esErrorBaseSinMigrar054(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01" || code === "42703";
}

interface OrderRow {
  readonly created_at_cursor?: string;
  readonly id: string;
  readonly organization_id: string;
  readonly property_id: string;
  readonly customer_id: string | null;
  readonly customer_name: string;
  readonly customer_phone: string;
  readonly customer_address: string | null;
  readonly customer_email: string | null;
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
  readonly assigned_repartidor_id: string | null;
  readonly estimated_delivery_at: string | null;
  readonly incident_note: string | null;
  /** Folio (`order_number`): solo viene en la fila de `create_order_idempotent` (`to_jsonb` de la fila completa). */
  readonly order_number?: string | number | null;
  /** Migracion 031 -- solo vienen en la fila de `create_order_idempotent` con la base migrada. */
  readonly canal?: CanalPedido | null;
  readonly propina?: string | null;
  readonly hora_recogida?: string | null;
  /** Migracion 034 -- solo vienen en la fila de `create_order_idempotent` / listados programados con la base migrada. */
  readonly programado_para?: string | Date | null;
  readonly promovido_at?: string | Date | null;
}

function aIsoONull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
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
    customerEmail: row.customer_email,
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
    // Fase 8 — `create_order_idempotent()` (migrations/003) devuelve `to_jsonb(v_order)`
    // de `restaurantes.orders%rowtype`, así que estas 3 columnas nuevas ya viajan solas
    // (null) en CUALQUIER OrderRow, incluido el de creación de pedido — nunca hace falta
    // tocar esa función SQL para que este mapeo sea correcto.
    assignedRepartidorId: row.assigned_repartidor_id,
    estimatedDeliveryAt: row.estimated_delivery_at,
    incidentNote: row.incident_note,
    ...(row.order_number !== undefined && row.order_number !== null ? { orderNumber: Number(row.order_number) } : {}),
    ...(row.canal !== undefined ? { canal: row.canal } : {}),
    ...(row.propina !== undefined ? { propina: row.propina === null ? null : Number(row.propina) } : {}),
    ...(row.hora_recogida !== undefined ? { horaRecogida: row.hora_recogida } : {}),
    ...(row.programado_para !== undefined ? { programadoPara: aIsoONull(row.programado_para) } : {}),
    ...(row.promovido_at !== undefined ? { promovidoAt: aIsoONull(row.promovido_at) } : {}),
  };
}

const ORDER_COLUMNS =
  "id, organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, customer_email, branch, total, status, items, source, notes, payment_method, call_transcript, call_recording_url, dedupe_fingerprint, idempotency_key, created_at, assigned_repartidor_id, estimated_delivery_at, incident_note";

interface CategoryRow {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly slug: string;
  readonly display_order: number;
}

function mapCategory(row: CategoryRow): Category {
  return { id: row.id, organizationId: row.organization_id, name: row.name, slug: row.slug, displayOrder: row.display_order };
}

interface AdminProductRow {
  readonly id: string;
  readonly organization_id: string;
  readonly category_id: string | null;
  readonly category_name: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly price: string;
  readonly image_url: string | null;
  readonly is_popular: boolean;
  readonly is_available: boolean;
  readonly display_order: number;
  readonly search_keywords: readonly string[];
}

function mapAdminProduct(row: AdminProductRow): Product {
  return {
    id: row.id,
    organizationId: row.organization_id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    imageUrl: row.image_url,
    isPopular: row.is_popular,
    isAvailable: row.is_available,
    displayOrder: row.display_order,
    searchKeywords: row.search_keywords,
  };
}

const ADMIN_PRODUCT_COLUMNS = `pr.id, pr.organization_id, pr.category_id, c.name as category_name, pr.name, pr.description, pr.price, pr.image_url, pr.is_popular, pr.is_available, pr.display_order, pr.search_keywords`;
const ADMIN_PRODUCT_FROM = `from restaurantes.products pr left join restaurantes.categories c on c.id = pr.category_id`;

interface PromotionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: "percentage" | "fixed" | "bogo";
  readonly value: string;
  readonly min_order_total: string | null;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly days_of_week: readonly number[] | null;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly max_uses: number | null;
  readonly times_used: number;
  readonly is_active: boolean;
  /** Migracion 027 -- ausentes (undefined) cuando la base todavia no la tiene. */
  readonly channels?: readonly CanalPedido[] | null;
  readonly product_ids?: readonly string[] | null;
  /** Migracion 031 -- ausentes (undefined) cuando la base todavia no la tiene. */
  readonly auto_apply?: boolean;
  readonly courtesy_product_ids?: readonly string[] | null;
  readonly courtesy_quantity?: number | null;
  /** Migracion 038 (alcance por sucursal) -- ausente (undefined) cuando la base todavia no la tiene. */
  readonly property_ids?: readonly string[] | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** `start_time`/`end_time` vuelven de Postgres como "HH:MM:SS" (tipo `time`) —
 * se recorta a "HH:MM" para que coincida exactamente con el formato que ya usa
 * `Promotion.startTime`/`endTime` y `promotions.ts::minutesSinceMidnight`. */
function toHhMm(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

function mapPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    organizationId: row.organization_id,
    code: row.code,
    name: row.name,
    description: row.description,
    type: row.type,
    value: Number(row.value),
    minOrderTotal: row.min_order_total === null ? null : Number(row.min_order_total),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    daysOfWeek: row.days_of_week,
    startTime: toHhMm(row.start_time),
    endTime: toHhMm(row.end_time),
    maxUses: row.max_uses,
    timesUsed: row.times_used,
    isActive: row.is_active,
    channels: row.channels ?? null,
    productIds: row.product_ids ?? null,
    autoApply: row.auto_apply ?? false,
    courtesyProductIds: row.courtesy_product_ids ?? null,
    courtesyQuantity: row.courtesy_quantity ?? null,
    propertyIds: row.property_ids ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROMOTION_COLUMNS =
  "id, organization_id, code, name, description, type, value, min_order_total, starts_at, ends_at, days_of_week, start_time, end_time, max_uses, times_used, is_active, created_at, updated_at";
/** Con las columnas de la migracion 027 (canales y productos elegibles). */
const PROMOTION_COLUMNS_V2 = `${PROMOTION_COLUMNS}, channels, product_ids`;
/** Con las columnas de la migracion 031 (auto_apply y combo de cortesia). */
const PROMOTION_COLUMNS_V3 = `${PROMOTION_COLUMNS_V2}, auto_apply, courtesy_product_ids, courtesy_quantity`;
/** Con la columna de la migracion 038 (alcance por sucursal). */
const PROMOTION_COLUMNS_V4 = `${PROMOTION_COLUMNS_V3}, property_ids`;

interface BranchHoursExceptionRow {
  readonly id: string;
  readonly property_id: string;
  readonly fecha_desde: string;
  readonly fecha_hasta: string;
  readonly horario: unknown;
  readonly motivo: string | null;
}

function mapBranchHoursException(row: BranchHoursExceptionRow): BranchHoursException {
  // Un horario ilegible (dato viejo/corrupto) se trata como "sin turnos": nunca bloquea un pedido.
  return { id: row.id, propertyId: row.property_id, fechaDesde: row.fecha_desde, fechaHasta: row.fecha_hasta, horario: leerHorarioPersistido(row.horario) ?? [], motivo: row.motivo };
}

interface BranchProductRow {
  readonly property_id: string;
  readonly product_id: string;
  readonly price: string;
  readonly is_available: boolean;
}

function mapBranchProductState(row: BranchProductRow): BranchProductState {
  return { propertyId: row.property_id, productId: row.product_id, price: Number(row.price), isAvailable: row.is_available };
}

// ---------------------------------------------------------------------------
// FASE 3 (producto) -- bitácora de auditoría del staff (ver
// migrations/019_restaurantes_audit_log.sql). Mismo mecanismo de SAVEPOINT que
// @atiende/domain-rentas::PostgresRentasRepository (ver ese archivo para el
// diseño completo) -- copiado a propósito para que ambas verticales se
// comporten IGUAL contra la base sin migrar.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (regla dura de esta fase, ver
// AGENTS.md): mergear a main despliega este código al instante, pero la base
// Supabase real va migraciones atrás y nadie las aplica al mergear --
// `restaurantes.record_audit_log`/`restaurantes.audit_log` no existen todavía
// en ese estado, y Postgres real lanza SQLSTATE 42883 (`undefined_function`)/
// 42P01 (`undefined_table`)/42703 (`undefined_column`) en ese caso.
// ---------------------------------------------------------------------------
const RESTAURANTES_AUDIT_LOG_WRITE_SAVEPOINT = "sp_restaurantes_audit_log_write";
const RESTAURANTES_AUDIT_LOG_READ_SAVEPOINT = "sp_restaurantes_audit_log_read";

function esErrorCompatibilidadAuditLogBaseSinMigrar(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01" || code === "42703";
}

/** Permiso (42501), funcion/tabla/columna inexistente (42883/42P01/42703): el estado del pedido "no esta disponible aun" en esa base. */
function esErrorSinPedidoRecienteDisponible(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42501" || code === "42883" || code === "42P01" || code === "42703";
}

// Compatibilidad con la base SIN migrar para la migracion 048 (escrituras de la sesion de sistema por funcion):
// solo la funcion inexistente (42883) degrada al camino directo anterior. Un 42501 de la propia funcion (sesion
// con auth.uid() no nulo) o cualquier otro error se propaga tal cual: nunca se enmascara un fallo real.
function esFuncionSistema048NoDisponible(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "42883";
}

// Compatibilidad con la base SIN migrar para la migracion 026 (estado del pedido / secretos por
// sucursal / bitacora de voz): funcion o tabla inexistente.
function esErrorBaseSinMigrar026(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01" || code === "42703";
}

let vozSecretosAdvertido = false;
function advertirVozSecretosNoDisponibles(err: unknown): void {
  if (vozSecretosAdvertido) return;
  vozSecretosAdvertido = true;
  console.warn(
    "PostgresRestaurantesRepository (voz): secretos por sucursal / bitácora de voz no existen todavía en esta base (SQLSTATE 42883/42P01/42703) -- " +
      "se usa el secreto global legado y no se registra bitácora. Aplica packages/domain-restaurantes/migrations/026_voz_secretos_sucursal_y_estado_pedido.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

let auditLogAdvertidoEscritura = false;
function advertirAuditLogEscrituraNoDisponible(err: unknown): void {
  if (auditLogAdvertidoEscritura) return;
  auditLogAdvertidoEscritura = true;
  console.warn(
    "PostgresRestaurantesRepository.registrarAuditoria: restaurantes.record_audit_log no existe todavía en esta base " +
      "(SQLSTATE 42883/42P01/42703) -- la acción de negocio YA se completó y no se revierte, esta fila de " +
      "bitácora se omitió. Aplica packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql (o su espejo " +
      "en supabase/migrations/) para habilitarla.",
    err,
  );
}

let auditLogAdvertidoLectura = false;
function advertirAuditLogLecturaNoDisponible(err: unknown): void {
  if (auditLogAdvertidoLectura) return;
  auditLogAdvertidoLectura = true;
  console.warn(
    "PostgresRestaurantesRepository.listAuditoria: restaurantes.audit_log no existe todavía en esta base (SQLSTATE " +
      "42883/42P01/42703) -- devolviendo disponible:false (nunca una lista vacía real, ver RestaurantesAuditLogPagina). " +
      "Aplica packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

// ---------------------------------------------------------------------------
// FASE 3 (producto) -- configuración editable (whatsapp_channel_config/
// known_zone), ver el comentario de cabecera de `getWhatsappChannelConfig` más
// abajo para el porqué de incluir 42501 aquí (tablas VIEJAS, GRANT nuevo).
// ---------------------------------------------------------------------------
/** Migracion 034 ausente: columna (42703), funcion (42883) o tabla (42P01) inexistente. NO incluye 42501: un
 * "sin acceso" de `promover_pedidos_programados` es un rechazo real, no una base sin migrar. */
function esErrorBaseSinMigrarProgramados(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01" || code === "42703";
}

interface StorefrontMarcaRow {
  titular: string | null;
  eslogan: string | null;
  about: string | null;
  portada_url: string | null;
  logo_url: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  tiktok_url: string | null;
  updated_at: Date | string | null;
}

function mapStorefrontMarca(r: StorefrontMarcaRow): StorefrontMarca {
  return {
    titular: r.titular,
    eslogan: r.eslogan,
    about: r.about,
    portadaUrl: r.portada_url,
    logoUrl: r.logo_url,
    instagramUrl: r.instagram_url,
    facebookUrl: r.facebook_url,
    tiktokUrl: r.tiktok_url,
    updatedAt: r.updated_at === null ? null : new Date(r.updated_at).toISOString(),
  };
}

function esErrorCompatibilidadConfigBaseSinMigrar(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42501" || code === "42883" || code === "42P01" || code === "42703";
}

const configEscrituraAdvertida = new Set<string>();
function advertirConfigEscrituraNoDisponible(tabla: string, err: unknown, migracion = "021_restaurantes_config_editable_y_search_path_fix.sql"): void {
  if (configEscrituraAdvertida.has(tabla)) return;
  configEscrituraAdvertida.add(tabla);
  console.warn(
    `PostgresRestaurantesRepository: la escritura sobre restaurantes.${tabla} todavía no está habilitada en esta base ` +
      "(SQLSTATE 42501/42883/42P01/42703) -- aplica " +
      `packages/domain-restaurantes/migrations/${migracion} (o su espejo en ` +
      "supabase/migrations/) para habilitarla.",
    err,
  );
}

interface KnownZoneRowSql {
  id: string;
  organization_id: string;
  name: string;
  lat: string | number | null;
  lng: string | number | null;
  created_at: string;
}

function mapKnownZoneRow(row: KnownZoneRowSql): KnownZone {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    createdAt: row.created_at,
  };
}

interface RestaurantesAuditLogRowSql {
  id: string;
  actor_user_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  campo: string | null;
  antes: string | null;
  despues: string | null;
  created_at: string;
}

function mapRestaurantesAuditLogRow(row: RestaurantesAuditLogRowSql): RestaurantesAuditLogRow {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    campo: row.campo,
    antes: row.antes,
    despues: row.despues,
    createdAtMs: new Date(row.created_at).getTime(),
  };
}

/** Tope de p_limit de restaurantes.clientes_cartera (migracion 054). */
const CARTERA_LIMITE_SQL = 200;

/** Evento de notificacion de un aviso de contacto. El aviso de llegada de quien recoge (`reason: cliente_llego`) es urgente y lleva su propio evento
 * (critica, enlace a pedidos): la sucursal tiene a una persona esperando en el mostrador. R-43: una solicitud de evento/catering del storefront
 * (reason = 'evento') avisa con su propio evento del catalogo. Ninguno emite ademas el aviso generico de «devolver llamada». */
function eventoDeCallback(reason: string | null | undefined): "restaurantes.cliente.llego" | "restaurantes.evento.solicitud" | "restaurantes.callback.pendiente" {
  return reason === "cliente_llego" ? "restaurantes.cliente.llego" : reason === "evento" ? "restaurantes.evento.solicitud" : "restaurantes.callback.pendiente";
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
    // Migracion 023 agrega `no_domicilio` a products/categories. Contra una base SIN
    // migrar el SELECT nuevo falla con 42703 -- este metodo corre dentro de la
    // transaccion unica de un request (cotizar/crear pedido), asi que el respaldo al
    // SELECT anterior EXIGE SAVEPOINT (un try/catch simple dejaria la transaccion
    // abortada, 25P02).
    const rows = await runWithSavepointFallback<readonly ProductRow[]>({
      session: this.db,
      savepointName: "sp_restaurantes_catalogo_no_domicilio",
      primary: async () => {
        const { rows: result } = await this.db.query<ProductRow>(
          `select pr.id, pr.name, pr.description, c.name as category_name, pr.search_keywords, bp.price, bp.is_available,
                  (pr.no_domicilio or coalesce(c.no_domicilio, false)) as no_domicilio
           from restaurantes.branch_products bp
           join restaurantes.products pr on pr.id = bp.product_id
           left join restaurantes.categories c on c.id = pr.category_id
           where bp.property_id = $1 and bp.is_available = true
           limit 400;`,
          [propertyId],
        );
        return result;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => {
        const { rows: result } = await this.db.query<ProductRow>(
          `select pr.id, pr.name, pr.description, c.name as category_name, pr.search_keywords, bp.price, bp.is_available
           from restaurantes.branch_products bp
           join restaurantes.products pr on pr.id = bp.product_id
           left join restaurantes.categories c on c.id = pr.category_id
           where bp.property_id = $1 and bp.is_available = true
           limit 400;`,
          [propertyId],
        );
        return result;
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      categoryName: row.category_name,
      searchKeywords: row.search_keywords,
      price: Number(row.price),
      isAvailable: row.is_available,
      noDomicilio: row.no_domicilio === true,
    }));
  }

  async listStorefrontCatalog(propertyId: string): Promise<readonly StorefrontCatalogRow[]> {
    // Mismo criterio que listAvailableProductsForBranch: `no_domicilio` (migracion 023) puede no
    // existir todavia; el respaldo EXIGE SAVEPOINT porque corre dentro de la transaccion del request.
    const rows = await runWithSavepointFallback<readonly StorefrontCatalogDbRow[]>({
      session: this.db,
      savepointName: "sp_restaurantes_storefront_catalogo",
      primary: async () => {
        const { rows: result } = await this.db.query<StorefrontCatalogDbRow>(
          `select pr.id, pr.name, pr.description, bp.price, pr.image_url, pr.is_popular, bp.is_available,
                  pr.category_id, c.name as category_name, coalesce(c.display_order, 0) as category_display_order,
                  pr.display_order, (pr.no_domicilio or coalesce(c.no_domicilio, false)) as no_domicilio
           from restaurantes.branch_products bp
           join restaurantes.products pr on pr.id = bp.product_id
           left join restaurantes.categories c on c.id = pr.category_id
           where bp.property_id = $1
           order by coalesce(c.display_order, 0), c.name nulls last, pr.display_order, pr.name
           limit 500;`,
          [propertyId],
        );
        return result;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => {
        const { rows: result } = await this.db.query<StorefrontCatalogDbRow>(
          `select pr.id, pr.name, pr.description, bp.price, pr.image_url, pr.is_popular, bp.is_available,
                  pr.category_id, c.name as category_name, coalesce(c.display_order, 0) as category_display_order,
                  pr.display_order
           from restaurantes.branch_products bp
           join restaurantes.products pr on pr.id = bp.product_id
           left join restaurantes.categories c on c.id = pr.category_id
           where bp.property_id = $1
           order by coalesce(c.display_order, 0), c.name nulls last, pr.display_order, pr.name
           limit 500;`,
          [propertyId],
        );
        return result;
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      price: Number(row.price),
      imageUrl: row.image_url,
      isPopular: row.is_popular === true,
      isAvailable: row.is_available === true,
      categoryId: row.category_id,
      categoryName: row.category_name,
      categoryDisplayOrder: Number(row.category_display_order),
      displayOrder: Number(row.display_order),
      noDomicilio: row.no_domicilio === true,
    }));
  }

  async findStorefrontOrderTracking(organizationId: string, orderId: string): Promise<StorefrontTrackingResult> {
    // Funcion de migracion 032: base sin migrar -> 42883. SAVEPOINT porque la sesion es la transaccion
    // unica del request (un try/catch simple la dejaria abortada, 25P02).
    return runWithSavepointFallback<StorefrontTrackingResult>({
      session: this.db,
      savepointName: "sp_restaurantes_storefront_rastreo",
      primary: async () => {
        const { rows } = await this.db.query<{ tracking: StorefrontTrackingDbPayload | null }>(
          `select restaurantes.storefront_order_tracking($1::uuid, $2::uuid) as tracking;`,
          [organizationId, orderId],
        );
        const t = rows[0]?.tracking ?? null;
        if (!t) return { disponible: true, pedido: null };
        return {
          disponible: true,
          pedido: {
            status: t.status as StorefrontOrderTracking["status"],
            branch: t.branch ?? null,
            total: Number(t.total),
            paymentMethod: t.payment_method === "efectivo" || t.payment_method === "tarjeta" ? t.payment_method : null,
            canal: t.canal === "recoger" ? "recoger" : "domicilio",
            createdAt: String(t.created_at),
            items: (Array.isArray(t.items) ? t.items : []).map((i) => ({
              name: String(i.name ?? ""),
              quantity: Number(i.quantity ?? 0),
              tortilla: i.tortilla === "maiz" || i.tortilla === "harina" || i.tortilla === "mixta" ? i.tortilla : null,
            })),
          },
        };
      },
      isRecoverable: esErrorBaseSinMigrar026,
      fallback: async () => ({ disponible: false, pedido: null }),
    });
  }

  async findCustomerByPhone(organizationId: string, phone: string): Promise<Customer | null> {
    const { rows } = await this.db.query<CustomerRow>(
      `select id, organization_id, phone, name, order_count from restaurantes.customers where organization_id = $1 and phone = $2;`,
      [organizationId, phone],
    );
    return rows[0] ? mapCustomer(rows[0]) : null;
  }

  async upsertCustomer(organizationId: string, phone: string, name: string): Promise<Customer> {
    // Migracion 048: el rol de produccion (authenticated, auth.uid() NULL) no tiene INSERT/UPDATE sobre
    // restaurantes.customers; la escritura va por la funcion solo-sistema (atomica por UNIQUE(organizacion, telefono)).
    // Contra una base sin esa migracion (42883) cae al camino directo anterior, dentro de un SAVEPOINT.
    return runWithSavepointFallback<Customer>({
      session: this.db,
      savepointName: "sp_restaurantes_upsert_customer_fn",
      primary: async () => {
        const { rows } = await this.db.query<{ customer: CustomerRow | null }>(`select restaurantes.upsert_customer($1, $2, $3) as customer;`, [organizationId, phone, name]);
        const row = rows[0]?.customer;
        if (!row) throw new Error("upsert_customer no devolvió el cliente");
        return mapCustomer(row);
      },
      isRecoverable: esFuncionSistema048NoDisponible,
      fallback: () => this.upsertCustomerDirecto(organizationId, phone, name),
    });
  }

  /** Camino anterior a la migracion 048 (INSERT/UPDATE directos). Solo funciona con un rol que tenga esos GRANT. */
  private async upsertCustomerDirecto(organizationId: string, phone: string, name: string): Promise<Customer> {
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
    // Fix hallazgo auditoría (rubro 3, "recuperación de 23505 sin SAVEPOINT deriva en
    // 25P02") — el INSERT de abajo puede perder una carrera real contra
    // UNIQUE(organization_id, phone). Sin este SAVEPOINT, ese unique_violation deja
    // TODA la transacción de la request en curso abortada a nivel Postgres (25P02:
    // "current transaction is aborted, commands ignored until end of transaction
    // block") — el SELECT/UPDATE de recuperación de abajo fallaría también con
    // 25P02 en vez de devolver la fila ganadora, y el error que finalmente sale no
    // es un 500 aislado de este upsert sino que tumba el REQUEST completo (misma
    // transacción por-request de `dbSession`, ver packages/core-auth/src/middleware.ts).
    // Mismo patrón ya establecido en domain-rentas/src/aplicacion/reservas.ts
    // (`crearReservaConfirmada`): SAVEPOINT antes del INSERT con riesgo real de
    // choque, `ROLLBACK TO SAVEPOINT` + `RELEASE SAVEPOINT` para recuperar la
    // transacción ANTES de reintentar con una consulta nueva.
    await this.db.exec("SAVEPOINT sp_upsert_customer_race");
    try {
      const { rows: created } = await this.db.query<CustomerRow>(
        `insert into restaurantes.customers (organization_id, phone, name, order_count)
         values ($1, $2, $3, 0)
         returning id, organization_id, phone, name, order_count;`,
        [organizationId, phone, name],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_upsert_customer_race");
      return mapCustomer(created[0]!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/unique|duplicate/i.test(message)) throw err;
      await this.db.exec("ROLLBACK TO SAVEPOINT sp_upsert_customer_race");
      await this.db.exec("RELEASE SAVEPOINT sp_upsert_customer_race");
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

  async addCustomerAddressIfNew(customerId: string, address: string, organizationId: string): Promise<void> {
    // Migracion 048 (ver `upsertCustomer`): funcion solo-sistema que ademas exige que el cliente sea de la organizacion.
    await runWithSavepointFallback<void>({
      session: this.db,
      savepointName: "sp_restaurantes_add_address_fn",
      primary: async () => {
        await this.db.query(`select restaurantes.add_customer_address_if_new($1, $2, $3);`, [organizationId, customerId, address]);
      },
      isRecoverable: esFuncionSistema048NoDisponible,
      fallback: () => this.addCustomerAddressDirecto(customerId, address),
    });
  }

  /** Camino anterior a la migracion 048 (INSERT directo). */
  private async addCustomerAddressDirecto(customerId: string, address: string): Promise<void> {
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

  // ---- Cliente 360 (migracion 049): delegan en cliente-360/postgres.ts (funciones security definer + SAVEPOINT) ----
  getCustomerMemory(organizationId: string, phone: string) {
    return cliente360.getCustomerMemory(this.db, organizationId, phone);
  }
  registerOrderClosure(input: OrderClosureInput) {
    return cliente360.registerOrderClosure(this.db, input);
  }
  getCustomerFicha(organizationId: string, customerId: string) {
    return cliente360.getCustomerFicha(this.db, organizationId, customerId);
  }
  updateCustomerProfile(organizationId: string, customerId: string, patch: CustomerProfilePatch) {
    return cliente360.updateCustomerProfile(this.db, organizationId, customerId, patch);
  }
  saveCustomerAddress(organizationId: string, customerId: string, addressId: string | null, changes: CustomerAddressChanges) {
    return cliente360.saveCustomerAddress(this.db, organizationId, customerId, addressId, changes);
  }
  deleteCustomerAddress(organizationId: string, customerId: string, addressId: string) {
    return cliente360.deleteCustomerAddress(this.db, organizationId, customerId, addressId);
  }
  applyCustomerPreferenceAction(organizationId: string, customerId: string, action: PreferenceAction, args: { readonly prefId?: string | null; readonly kind?: string | null; readonly value?: string | null }) {
    return cliente360.applyCustomerPreferenceAction(this.db, organizationId, customerId, action, args);
  }
  markOrderFake(organizationId: string, orderId: string, falso: boolean) {
    return cliente360.markOrderFake(this.db, organizationId, orderId, falso);
  }
  exportCustomerData(organizationId: string, customerId: string) {
    return cliente360.exportCustomerData(this.db, organizationId, customerId);
  }
  deleteCustomerMemory(organizationId: string, customerId: string) {
    return cliente360.deleteCustomerMemory(this.db, organizationId, customerId);
  }
  getCustomerPolicy(organizationId: string) {
    return cliente360.getCustomerPolicy(this.db, organizationId);
  }
  saveCustomerPolicy(organizationId: string, policy: CustomerPolicy) {
    return cliente360.saveCustomerPolicy(this.db, organizationId, policy);
  }

  async calcCustomerTier(organizationId: string, customerId: string): Promise<CustomerTier | null> {
    const { rows } = await this.db.query<{ tier: CustomerTier | null }>(
      `select (restaurantes.calc_customer_tier($1, $2)->>'tier') as tier;`,
      [organizationId, customerId],
    );
    return rows[0]?.tier ?? null;
  }

  // NOTA (r3, no-bloqueante de la re-revisión del PR #158 -- convertido por
  // simetría/defensa en profundidad con `createAppointmentIdempotent` de
  // `domain-citas`): hoy los dos callers reales de este método ya quedan a salvo del
  // `COMMIT`-que-en-realidad-es-`ROLLBACK` (`AbortedTransactionCommitError`) SIN este
  // SAVEPOINT -- la ruta HTTP (`apps/api/.../restaurantes/public.ts`) siempre
  // RELANZA `OrderConflictError`/`Errors.conflict` fuera del callback de
  // `withAppSession` (`fn` nunca resuelve normalmente, el motor hace un `rollback`
  // real), y el agente de WhatsApp (`executeToolCall`) ya envuelve TODA la tool call
  // en su propio `runWithRowSavepoint` exterior. Se convierte igual, por si un
  // caller futuro (ej. un panel admin que mapee `OrderConflictError` a una respuesta
  // 409 normal, como ya hace `appointments-lifecycle.ts::mapErrorToHttp` con
  // `AppointmentAlternativesError`) reutilizara la sesión después sin su propio
  // SAVEPOINT.
  async createOrderIdempotent(order: NewOrderRecord, dedupeFingerprint: string, idempotencyKey: string | null): Promise<Order> {
    // restaurantes.create_order_idempotent (ver migrations/003) lanza sqlstate PT409
    // cuando la misma idempotency_key se reutiliza con un dedupe_fingerprint distinto
    // (pedido con contenido materialmente diferente) — port literal de
    // `insertError?.code === "PT409"` en create-order-core.ts del origen: se traduce
    // aquí, en el punto real donde llega el error crudo de Postgres, al
    // OrderConflictError tipado que ya consume apps/api/src/routes/verticals/restaurantes/public.ts.
    try {
      const { rows } = await this.runWithRowSavepoint(() =>
        this.db.query<{ create_order_idempotent: OrderRow }>(`select restaurantes.create_order_idempotent($1::jsonb, $2, $3) as create_order_idempotent;`, [
          JSON.stringify({
            organization_id: order.organizationId,
            property_id: order.propertyId,
            customer_id: order.customerId,
            customer_name: order.customerName,
            customer_phone: order.customerPhone,
            customer_address: order.customerAddress,
            customer_email: order.customerEmail,
            branch: order.branch,
            total: order.total,
            items: order.items,
            source: order.source,
            notes: order.notes,
            payment_method: order.paymentMethod,
            call_transcript: order.callTranscript,
            call_recording_url: order.callRecordingUrl,
            // Migracion 031: el create_order_idempotent VIEJO ignora estas llaves del jsonb.
            canal: order.canal ?? null,
            propina: order.propina ?? null,
            hora_recogida: order.horaRecogida ?? null,
            // Migracion 034: el create_order_idempotent VIEJO ignora esta llave (createOrder ya verifico
            // `supportsScheduledOrders()` antes de mandar un valor, asi que nunca se programa en vano).
            programado_para: order.programadoPara ?? null,
          }),
          dedupeFingerprint,
          idempotencyKey,
        ]),
      );
      const creado = mapOrder(rows[0]!.create_order_idempotent);
      // Notificacion in-app (productor compartido, `restaurantes.pedido.nuevo`): un pedido que entra por el agente de WhatsApp/voz o
      // el checkout publico es "algo nuevo que atender". Uno por pedido (clave = id: un reintento idempotente que devuelve el mismo
      // pedido no vuelve a avisar), sin PII (titulo del catalogo), y los pedidos capturados por el propio staff (`admin`) no avisan.
      // Dentro de un SAVEPOINT (emitirNotificacion): contra la base sin migrar no aborta la transaccion del request.
      if (creado.source !== "admin") {
        await emitirNotificacion(this.db, { evento: "restaurantes.pedido.nuevo", organizationId: creado.organizationId, propertyId: creado.propertyId, clave: creado.id, entidadTipo: "order", entidadId: creado.id });
      }
      return creado;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "PT409") {
        throw new OrderConflictError("Este intento de pedido ya fue procesado con datos diferentes. Revisa el pedido existente antes de crear otro.");
      }
      throw err;
    }
  }

  async createCallbackRequest(input: CallbackRequestInput): Promise<CallbackRequest> {
    // Avisos del AGENTE (voz y WhatsApp): idempotentes por evento y por motivo (migracion 047, `callback_registrar_agente`). Corre dentro
    // de la transaccion unica del request/turno: contra una base SIN migrar la funcion no existe (42883) y el respaldo al INSERT de
    // siempre EXIGE SAVEPOINT (un try/catch simple dejaria la transaccion abortada, 25P02). Solo 42883 degrada: un 42501 es un rechazo real.
    if (input.source === "voice" || input.source === "whatsapp") {
      const agente = await runWithSavepointFallback<CallbackRequest | null>({
        session: this.db,
        savepointName: "sp_restaurantes_callback_agente",
        primary: async () => {
          const { rows } = await this.db.query<{ callback_id: string; resuelto: boolean; creado_at: string; registro: CallbackRegistro }>(
            `select callback_id, resuelto, creado_at, registro
             from restaurantes.callback_registrar_agente($1, $2, $3, $4, $5, $6, $7, $8);`,
            [input.organizationId, input.propertyId ?? null, input.customerName, input.customerPhone, input.reason ?? null, input.message ?? null, input.source, input.sourceEventId ?? null],
          );
          const fila = rows[0]!;
          return { ...input, id: fila.callback_id, resolved: fila.resuelto, createdAt: fila.creado_at, registro: fila.registro };
        },
        isRecoverable: (err) => (err as { code?: string } | null)?.code === "42883",
        fallback: async () => null,
      });
      if (agente) {
        // Notificacion in-app (`restaurantes.callback.pendiente`) solo cuando el aviso es NUEVO: un reenvio o una nota agregada no vuelven a avisar.
        if (agente.registro === "nuevo") {
          await emitirNotificacion(this.db, { evento: eventoDeCallback(input.reason), organizationId: input.organizationId, propertyId: input.propertyId ?? null, clave: agente.id, entidadTipo: "callback_request", entidadId: agente.id });
        }
        return agente;
      }
    }
    const params = [input.organizationId, input.propertyId ?? null, input.customerName, input.customerPhone, input.reason ?? null, input.message ?? null, input.source];
    // Migracion 048 (ver `upsertCustomer`): funcion solo-sistema; sin ella (42883) cae al INSERT directo anterior.
    const row = await runWithSavepointFallback<{ id: string; resolved: boolean; created_at: string }>({
      session: this.db,
      savepointName: "sp_restaurantes_callback_fn",
      primary: async () => {
        const { rows } = await this.db.query<{ callback: { id: string; resolved: boolean; created_at: string } | null }>(
          `select restaurantes.create_callback_request($1, $2, $3, $4, $5, $6, $7) as callback;`,
          params,
        );
        const creado = rows[0]?.callback;
        if (!creado) throw new Error("create_callback_request no devolvió el aviso");
        return creado;
      },
      isRecoverable: esFuncionSistema048NoDisponible,
      // Sin la 048 (42883): `restaurantes.callback_registrar` (062, ya en main) y, sin ella tampoco, el INSERT directo anterior.
      fallback: async () => {
        type Fila = { id: string; resolved: boolean; created_at: string };
        const rows = await runWithSavepointFallback<Fila[]>({
          session: this.db,
          savepointName: "sp_restaurantes_callback_registrar",
          primary: async () => (await this.db.query<Fila>(`select id, resolved, created_at from restaurantes.callback_registrar($1, $2, $3, $4, $5, $6, $7);`, params)).rows,
          isRecoverable: (err) => (err as { code?: string } | null)?.code === "42883",
          fallback: async () =>
            (
              await this.db.query<Fila>(
                `insert into restaurantes.callback_requests (organization_id, property_id, customer_name, customer_phone, reason, message, source)
                 values ($1, $2, $3, $4, $5, $6, $7)
                 returning id, resolved, created_at;`,
                params,
              )
            ).rows,
        });
        return rows[0]!;
      },
    });
    // Notificacion in-app (`restaurantes.callback.pendiente`): un contacto que el agente (voz o WhatsApp) dejo para devolver la
    // llamada. Uno por solicitud (clave = id), sin PII (ni nombre ni telefono viajan en el aviso). SAVEPOINT en emitirNotificacion.
    await emitirNotificacion(this.db, { evento: eventoDeCallback(input.reason), organizationId: input.organizationId, propertyId: input.propertyId ?? null, clave: row.id, entidadTipo: "callback_request", entidadId: row.id });
    return { ...input, id: row.id, resolved: row.resolved, createdAt: row.created_at, registro: "nuevo" };
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

  async contadorAgenteWhatsApp(organizationId: string, phone: string, clave: ClaveContadorAgente, accion: "incrementar" | "reiniciar"): Promise<number | null> {
    // Base SIN migrar: la funcion (42883) o la columna (42703) no existen. Corre dentro de la transaccion del turno: respaldo con SAVEPOINT
    // (un try/catch simple la dejaria abortada, 25P02). Sin contador el agente sigue como antes (solo cuenta dentro del turno).
    return runWithSavepointFallback<number | null>({
      session: this.db,
      savepointName: "sp_restaurantes_contador_agente",
      primary: async () => {
        const { rows } = await this.db.query<{ n: number | null }>(`select restaurantes.whatsapp_contador_agente($1, $2, $3, $4) as n;`, [organizationId, phone, clave, accion]);
        return rows[0]?.n ?? null;
      },
      isRecoverable: (err) => ["42883", "42703", "42P01"].includes((err as { code?: string } | null)?.code ?? ""),
      fallback: async () => null,
    });
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
    // Migracion 048: el rol de produccion no tiene GRANT sobre whatsapp_inbound_events; la escritura va por la
    // funcion solo-sistema. Sin ella (42883) cae al UPDATE directo anterior.
    await runWithSavepointFallback<void>({
      session: this.db,
      savepointName: "sp_restaurantes_inbound_failed_fn",
      primary: async () => {
        await this.db.query(`select restaurantes.mark_whatsapp_inbound_failed($1, $2, $3);`, [organizationId, messageId, errorClass]);
      },
      isRecoverable: esFuncionSistema048NoDisponible,
      fallback: async () => {
        await this.db.query(
          `update restaurantes.whatsapp_inbound_events set status = 'failed', last_error_class = $3
           where message_id = $2 and organization_id = $1;`,
          [organizationId, messageId, errorClass],
        );
      },
    });
  }

  // Aislamiento por tool call del turno de WhatsApp (ver el comentario de cabecera
  // de `runWithRowSavepoint` en `repository.ts` para el diseño completo) -- mismo
  // `runWithSavepointFallback` que `PostgresCitasRepository`, con `isRecoverable`
  // fijo en `true` y un `fallback` que simplemente relanza el mismo error DESPUÉS de
  // que `ROLLBACK TO SAVEPOINT` ya dejó la transacción del turno utilizable para el
  // resto del loop de tool-use / el commit final.
  async runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw err;
      },
    });
  }

  // ---- Voz: secretos por sucursal y bitacora (migracion 026) ----
  // Toda operacion lleva SAVEPOINT propio: corre dentro de la transaccion unica del request de voz.
  async verifyVoiceBranchSecret(organizationId: string, secretHash: string): Promise<VoiceSecretMatch> {
    return runWithSavepointFallback<VoiceSecretMatch>({
      session: this.db,
      savepointName: "sp_restaurantes_voice_secret_verify",
      primary: async () => {
        const { rows } = await this.db.query<{ property_id: string | null }>(`select restaurantes.verify_voice_branch_secret($1, $2) as property_id;`, [organizationId, secretHash]);
        const propertyId = rows[0]?.property_id ?? null;
        return propertyId ? { status: "match", propertyId } : { status: "no_match" };
      },
      isRecoverable: esErrorBaseSinMigrar026,
      fallback: async (err) => {
        advertirVozSecretosNoDisponibles(err);
        return { status: "unavailable" };
      },
    });
  }

  async rotateVoiceBranchSecret(organizationId: string, propertyId: string, secretHash: string, secretHint: string, graceSeconds: number): Promise<{ readonly rotatedAt: string }> {
    return runWithSavepointFallback<{ readonly rotatedAt: string }>({
      session: this.db,
      savepointName: "sp_restaurantes_voice_secret_rotate",
      primary: async () => {
        const { rows } = await this.db.query<{ rotated_at: string | Date }>(`select restaurantes.rotate_voice_branch_secret($1, $2, $3, $4, $5) as rotated_at;`, [
          organizationId,
          propertyId,
          secretHash,
          secretHint,
          graceSeconds,
        ]);
        const at = rows[0]!.rotated_at;
        return { rotatedAt: at instanceof Date ? at.toISOString() : String(at) };
      },
      isRecoverable: esErrorBaseSinMigrar026,
      fallback: async (err) => {
        advertirVozSecretosNoDisponibles(err);
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  async recordVoiceToolAudit(input: VoiceToolAuditInput): Promise<void> {
    try {
      await runWithSavepointFallback<void>({
        session: this.db,
        savepointName: "sp_restaurantes_voice_tool_audit",
        primary: async () => {
          await this.db.query(`select restaurantes.record_voice_tool_audit($1, $2, $3, $4, $5, $6, $7);`, [
            input.organizationId,
            input.propertyId,
            input.callId,
            input.tool,
            input.outcome,
            input.phoneHash,
            input.detail === null ? null : input.detail.slice(0, 300),
          ]);
        },
        isRecoverable: () => true,
        fallback: async (err) => {
          if (esErrorBaseSinMigrar026(err)) advertirVozSecretosNoDisponibles(err);
          else console.error("PostgresRestaurantesRepository.recordVoiceToolAudit: error inesperado (best-effort, no se relanza):", err);
        },
      });
    } catch (err) {
      console.error("PostgresRestaurantesRepository.recordVoiceToolAudit: no se pudo registrar (best-effort):", err);
    }
  }

  // ---- Estado del pedido en el servidor (migracion 026; ver agent-tools/order-flow.ts) ----
  // SAVEPOINT propio por operacion: en la base sin migrar (42883/42P01/42703) la funcion no
  // existe, `ROLLBACK TO SAVEPOINT` deja viva la transaccion compartida del request y se
  // devuelve "no disponible" (camino anterior) en vez de abortarla (25P02).
  async readOrderFlow(organizationId: string, flowKey: string): Promise<OrderFlowSnapshot | null> {
    return runWithSavepointFallback<OrderFlowSnapshot | null>({
      session: this.db,
      savepointName: "sp_restaurantes_order_flow_read",
      primary: async () => {
        const { rows } = await this.db.query<{ state: string | null; context: OrderFlowContext | null; version: number | string }>(
          `select state, context, version from restaurantes.read_order_flow_state($1, $2);`,
          [organizationId, flowKey],
        );
        const row = rows[0];
        if (!row || !row.state || !row.context) return { state: null, context: null, version: row ? Number(row.version) : 0 };
        return { state: row.state as OrderFlowState, context: row.context, version: Number(row.version) };
      },
      isRecoverable: esErrorBaseSinMigrar026,
      fallback: async () => null,
    });
  }

  async writeOrderFlow(
    organizationId: string,
    flowKey: string,
    expectedVersion: number,
    next: { readonly state: OrderFlowState; readonly context: OrderFlowContext },
    ttlSeconds: number,
  ): Promise<OrderFlowWriteResult> {
    return runWithSavepointFallback<OrderFlowWriteResult>({
      session: this.db,
      savepointName: "sp_restaurantes_order_flow_write",
      primary: async () => {
        const { rows } = await this.db.query<{ result: string }>(`select restaurantes.write_order_flow_state($1, $2, $3, $4, $5::jsonb, $6) as result;`, [
          organizationId,
          flowKey,
          expectedVersion,
          next.state,
          JSON.stringify(next.context),
          ttlSeconds,
        ]);
        return rows[0]?.result === "written" ? "written" : "conflict";
      },
      isRecoverable: esErrorBaseSinMigrar026,
      fallback: async () => "unavailable",
    });
  }

  // ---- Dispatcher real de messaging_outbox (migrations/007) ----

  async enqueueMessagingOutbox(organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    await this.db.query(`select restaurantes.enqueue_messaging_outbox($1, $2, $3, $4, $5::jsonb);`, [organizationId, channel, eventType, dedupeKey, JSON.stringify(payload)]);
  }

  async claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]> {
    const { rows } = await this.db.query<{ id: string; attempts: number; payload: unknown; organization_id: string }>(`select id, attempts, payload, organization_id from restaurantes.claim_messaging_outbox_batch($1, $2);`, [limit, leaseSeconds]);
    return rows.map((r) => ({ id: r.id, attempts: r.attempts, payload: r.payload, organizationId: r.organization_id }));
  }

  async markMessagingOutboxSent(id: string, detalle?: { readonly providerMessageId: string; readonly enviadoComo?: "texto" | "plantilla" | "botones" | "ubicacion" }): Promise<void> {
    if (!detalle || detalle.providerMessageId.length === 0) {
      await this.db.query(`select restaurantes.complete_messaging_outbox_sent($1);`, [id]);
      return;
    }
    // Migracion 066: guarda el wamid. Corre dentro de la transaccion corta del despachador: sin SAVEPOINT, un 42883 (base sin migrar) la dejaria
    // abortada y el cierre de respaldo fallaria con 25P02 (el mensaje, ya entregado, se reenviaria al vencer su lease).
    await runWithSavepointFallback<void>({
      session: this.db,
      savepointName: "sp_outbox_sent_wamid",
      primary: async () => {
        await this.db.query(`select restaurantes.complete_messaging_outbox_sent($1, $2, $3);`, [id, detalle.providerMessageId, detalle.enviadoComo ?? null]);
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        await this.db.query(`select restaurantes.complete_messaging_outbox_sent($1);`, [id]);
      },
    });
  }

  async registrarEstadoEntregaWhatsapp(organizationId: string, estado: EstadoEntregaEntrante): Promise<RegistroEstadoEntrega> {
    interface Fila {
      outbox_id: string | null;
      resultado: "actualizado" | "sin_cambio" | "desconocido";
      estado: RegistroEstadoEntrega["estado"];
      event_type: string | null;
      failure_reason: MotivoFalloEntregaGuardado | null;
      order_id: string | null;
      order_status: string | null;
      fallidas_ultima_hora: number | string | null;
      pedido_correo: string | null;
      pedido_cliente: string | null;
      pedido_sucursal: string | null;
      pedido_total: number | string | null;
    }
    // El webhook comparte UNA transaccion para todo el lote: el SAVEPOINT evita que una base sin la 066 (42883/42P01/42703) la deje abortada.
    return runWithSavepointFallback<RegistroEstadoEntrega>({
      session: this.db,
      savepointName: "sp_registrar_estado_entrega",
      primary: async () => {
        const { rows } = await this.db.query<Fila>(
          `select outbox_id, resultado, estado, event_type, failure_reason, order_id, order_status, fallidas_ultima_hora,
                  pedido_correo, pedido_cliente, pedido_sucursal, pedido_total
             from restaurantes.registrar_estado_entrega_whatsapp($1, $2, $3, $4, $5);`,
          [organizationId, estado.wamid, estado.status, estado.errorCode, estado.errorTitle],
        );
        const r = rows[0];
        if (!r) return { resultado: "desconocido", outboxId: null, estado: null, eventType: null, motivoFallo: null, orderId: null, orderStatus: null, fallidasUltimaHora: 0, respaldoCorreo: null };
        return {
          resultado: r.resultado,
          outboxId: r.outbox_id,
          estado: r.estado,
          eventType: r.event_type,
          motivoFallo: r.failure_reason,
          orderId: r.order_id,
          orderStatus: r.order_status,
          fallidasUltimaHora: Number(r.fallidas_ultima_hora ?? 0),
          respaldoCorreo: r.pedido_correo ? { to: r.pedido_correo, clienteNombre: r.pedido_cliente ?? "", sucursal: r.pedido_sucursal, total: Number(r.pedido_total ?? 0) } : null,
        };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ resultado: "no_disponible", outboxId: null, estado: null, eventType: null, motivoFallo: null, orderId: null, orderStatus: null, fallidasUltimaHora: 0, respaldoCorreo: null }),
    });
  }

  async markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
    await this.db.query(`select restaurantes.complete_messaging_outbox_retry($1, $2, $3, $4);`, [id, attempts, errorClass, nextAttemptAtIso]);
  }

  async markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void> {
    await this.db.query(`select restaurantes.complete_messaging_outbox_dead($1, $2, $3);`, [id, attempts, errorClass]);
  }

  // ============================================================================
  // Dispatcher real de correo (ver migrations/011_email_outbox_dispatch.sql) —
  // mismo patrón exacto que @atiende/domain-citas::PostgresCitasRepository, sobre
  // la columna real de este dominio (`last_error_class`, ver `complete_error` más
  // abajo de restaurantes.messaging_outbox).
  // ============================================================================

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const { rows } = await this.db.query<{ id: string; organization_id: string; attempts: number; payload: Record<string, unknown> }>(`select id, organization_id, attempts, payload from restaurantes.claim_email_outbox_batch($1);`, [limit]);
    return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, attempts: r.attempts, payload: r.payload ?? {} }));
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    await this.db.query(`select restaurantes.complete_email_outbox_job($1, $2, $3);`, [id, status, error]);
  }

  // Fase 9 — sentido SALIENTE de `restaurantes.whatsapp_channel_config`
  // (migrations/001, `organization_id` es su PK real: un solo `phone_number_id` por
  // organización) — ver comentario completo en repository.ts.
  async resolveActiveWhatsAppPhoneNumberId(organizationId: string, propertyId?: string | null): Promise<string | null> {
    if (propertyId) {
      // Modelo PM (migracion 023): el numero de la sucursal del pedido va primero. Contra una
      // base sin migrar la tabla no existe (42P01) -- SAVEPOINT porque esto corre dentro de la
      // transaccion del cambio de estado del pedido.
      const branchNumber = await runWithSavepointFallback<string | null>({
        session: this.db,
        savepointName: "sp_restaurantes_whatsapp_branch_channel_outbound",
        primary: async () => {
          const { rows } = await this.db.query<{ phone_number_id: string }>(
            `select phone_number_id from restaurantes.whatsapp_branch_channel where organization_id = $1 and property_id = $2;`,
            [organizationId, propertyId],
          );
          return rows[0]?.phone_number_id ?? null;
        },
        isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
        fallback: async () => null,
      });
      if (branchNumber) return branchNumber;
    }
    const { rows } = await this.db.query<{ phone_number_id: string }>(`select phone_number_id from restaurantes.whatsapp_channel_config where organization_id = $1;`, [organizationId]);
    return rows[0]?.phone_number_id ?? null;
  }

  // ---- Fase 9 — bandeja de notificaciones internas al staff (ver
  // order-notifications.ts, migrations/009_order_notifications.sql) ----

  async createStaffOrderNotification(
    organizationId: string,
    propertyId: string,
    orderId: string,
    eventType: StaffOrderNotificationEventType,
    message: string,
  ): Promise<StaffOrderNotificationRecord> {
    const { rows } = await this.db.query<{
      id: string;
      created_at: string;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
    }>(`select id, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by from restaurantes.enqueue_staff_order_notification($1, $2, $3, $4, $5);`, [
      organizationId,
      propertyId,
      orderId,
      eventType,
      message,
    ]);
    const row = rows[0]!;
    return { id: row.id, organizationId, propertyId, orderId, eventType, message, createdAt: row.created_at, acknowledgedAt: row.acknowledged_at, acknowledgedBy: row.acknowledged_by };
  }

  async listStaffOrderNotifications(
    organizationId: string,
    propertyIds: readonly string[] | null,
    options?: { readonly unacknowledgedOnly?: boolean; readonly limit?: number },
  ): Promise<readonly StaffOrderNotificationRecord[]> {
    const limit = options?.limit ?? 50;
    const { rows } = await this.db.query<{
      id: string;
      property_id: string;
      order_id: string;
      event_type: StaffOrderNotificationEventType;
      message: string;
      created_at: string;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
    }>(
      `select id, property_id, order_id, event_type, message, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by
       from restaurantes.staff_order_notification
       where organization_id = $1
         and ($2::uuid[] is null or property_id = any($2::uuid[]))
         and ($3::boolean is false or acknowledged_at is null)
       order by created_at desc
       limit $4;`,
      [organizationId, propertyIds !== null ? propertyIds : null, options?.unacknowledgedOnly ?? false, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      organizationId,
      propertyId: r.property_id,
      orderId: r.order_id,
      eventType: r.event_type,
      message: r.message,
      createdAt: r.created_at,
      acknowledgedAt: r.acknowledged_at,
      acknowledgedBy: r.acknowledged_by,
    }));
  }

  async acknowledgeStaffOrderNotification(organizationId: string, notificationId: string, actorId: string, propertyIds?: readonly string[] | null): Promise<StaffOrderNotificationRecord> {
    const { rows } = await this.db.query<{
      property_id: string;
      order_id: string;
      event_type: StaffOrderNotificationEventType;
      message: string;
      created_at: string;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
    }>(
      `update restaurantes.staff_order_notification set acknowledged_at = now(), acknowledged_by = $1
       where organization_id = $2 and id = $3${propertyIds ? " and property_id = any($4::uuid[])" : ""}
       returning property_id, order_id, event_type, message, created_at::text as created_at, acknowledged_at::text as acknowledged_at, acknowledged_by;`,
      propertyIds ? [actorId, organizationId, notificationId, [...propertyIds]] : [actorId, organizationId, notificationId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Notificación "${notificationId}" no encontrada para la organización "${organizationId}".`);
    return {
      id: notificationId,
      organizationId,
      propertyId: row.property_id,
      orderId: row.order_id,
      eventType: row.event_type,
      message: row.message,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
    };
  }

  // ---- KPIs de admin (Fase 3 — ver migrations/006_kpi_aggregates.sql) ----

  async getSalesBucketedStats(organizationId: string, propertyIds: readonly string[] | null, buckets: readonly KpiDateRange[]): Promise<readonly SalesBucketRow[]> {
    if (buckets.length === 0) return [];
    const { rows } = await this.db.query<{ idx: number; revenue: string; order_count: string; customer_count: string }>(
      // QA R1 viaje-09: consulta directa (no la funcion `orders_bucketed_stats`, cuya definicion en la base solo
      // excluye cancelados y no puede cambiar sin migracion). Misma forma y alcance (RLS del usuario, organizacion
      // y sucursales); una venta NO es un pedido cancelado, `no_recogido` (no se cobro) ni `programado` (aun no es
      // venta). Funciona igual contra la base sin migrar: solo lee `restaurantes.orders`.
      `select b.idx, coalesce(sum(o.total), 0) as revenue, count(o.id) as order_count, count(distinct o.customer_id) as customer_count
       from unnest($3::timestamptz[], $4::timestamptz[]) with ordinality as b(bucket_start, bucket_end, idx)
       left join restaurantes.orders o
         on o.organization_id = $1
         and o.status not in ('cancelado', 'no_recogido', 'programado')
         and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
         and o.created_at >= b.bucket_start
         and o.created_at < b.bucket_end
       group by b.idx
       order by b.idx;`,
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

  async getChannelStats(organizationId: string, propertyIds: readonly string[] | null, range?: KpiDateRange): Promise<ChannelStatsRow> {
    type ChannelRaw = {
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
    };
    const props = propertyIds ? [...propertyIds] : null;
    const historico = async (): Promise<{ readonly acotado: boolean; readonly rows: readonly ChannelRaw[] }> => {
      const { rows } = await this.db.query<ChannelRaw>(`select * from restaurantes.orders_channel_stats($1, $2::uuid[]);`, [organizationId, props]);
      return { acotado: false, rows };
    };
    // R-30: con periodo, intenta la funcion nueva (migracion 036) dentro de un SAVEPOINT; contra la base sin
    // migrar (42883) cae al historico y lo declara (`acotadoAPeriodo: false`), nunca un 500.
    const { acotado, rows } = range
      ? await runWithSavepointFallback<{ readonly acotado: boolean; readonly rows: readonly ChannelRaw[] }>({
          session: this.db,
          savepointName: "sp_restaurantes_canales_periodo",
          primary: async () => {
            const res = await this.db.query<ChannelRaw>(`select * from restaurantes.orders_channel_stats_periodo($1, $2::uuid[], $3::timestamptz, $4::timestamptz);`, [
              organizationId,
              props,
              range.start.toISOString(),
              range.end.toISOString(),
            ]);
            return { acotado: true, rows: res.rows };
          },
          isRecoverable: (err) => (err as { code?: string } | null)?.code === "42883",
          fallback: historico,
        })
      : await historico();
    const row = rows[0];
    if (!row) return { acotadoAPeriodo: acotado, totalOrders: 0, totalRevenue: 0, voice: { orders: 0, completed: 0, cancelled: 0, revenue: 0 }, whatsapp: { orders: 0, completed: 0, cancelled: 0, revenue: 0 } };
    return {
      acotadoAPeriodo: acotado,
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

  // ---- Fase 5 — back-office CORE (ver migrations/007_admin_backoffice_grants_and_policies.sql) ----

  async findBranchById(organizationId: string, propertyId: string): Promise<Branch | null> {
    const { rows } = await this.db.query<BranchRow>(
      `select p.id as property_id, p.organization_id, p.name, bd.slug, p.status, bd.phone, bd.address, bd.lat, bd.lng
       from core.property p
       join restaurantes.branch_detail bd on bd.property_id = p.id
       where p.organization_id = $1 and p.id = $2
       limit 1;`,
      [organizationId, propertyId],
    );
    return rows[0] ? mapBranch(rows[0]) : null;
  }

  async listBranchesForOrganizationAdmin(organizationId: string): Promise<readonly Branch[]> {
    const { rows } = await this.db.query<BranchRow>(
      `select p.id as property_id, p.organization_id, p.name, bd.slug, p.status, bd.phone, bd.address, bd.lat, bd.lng
       from core.property p
       join restaurantes.branch_detail bd on bd.property_id = p.id
       where p.organization_id = $1
       order by bd.display_order asc, p.name asc;`,
      [organizationId],
    );
    return rows.map(mapBranch);
  }

  async updateBranchDetail(
    organizationId: string,
    propertyId: string,
    patch: { readonly phone?: string | null; readonly address?: string | null; readonly lat?: number | null; readonly lng?: number | null; readonly slug?: string; readonly displayOrder?: number },
  ): Promise<Branch | null> {
    // Solo escribe `restaurantes.branch_detail` — `core.property.status`/`name` no
    // tienen GRANT de escritura para `authenticated` (ver comentario de
    // `RestaurantesRepository.updateBranchDetail`), así que ni se intentan tocar
    // aquí. `coalesce` deja intacto cualquier campo que el caller no mandó.
    const { rows } = await this.db.query<{ exists: boolean }>(`select exists(select 1 from core.property where id = $1 and organization_id = $2) as exists;`, [propertyId, organizationId]);
    if (!rows[0]?.exists) return null;

    await this.db.query(
      `update restaurantes.branch_detail
       set phone = case when $3::boolean then $4 else phone end,
           address = case when $5::boolean then $6 else address end,
           lat = case when $7::boolean then $8 else lat end,
           lng = case when $9::boolean then $10 else lng end,
           slug = coalesce($11, slug),
           display_order = coalesce($12, display_order)
       where property_id = $1 and organization_id = $2;`,
      [
        propertyId,
        organizationId,
        patch.phone !== undefined,
        patch.phone ?? null,
        patch.address !== undefined,
        patch.address ?? null,
        patch.lat !== undefined,
        patch.lat ?? null,
        patch.lng !== undefined,
        patch.lng ?? null,
        patch.slug ?? null,
        patch.displayOrder ?? null,
      ],
    );
    return this.findBranchById(organizationId, propertyId);
  }

  async listCategories(organizationId: string): Promise<readonly Category[]> {
    const { rows } = await this.db.query<CategoryRow>(
      `select id, organization_id, name, slug, display_order from restaurantes.categories where organization_id = $1 order by display_order asc, name asc;`,
      [organizationId],
    );
    return rows.map(mapCategory);
  }

  async createCategory(organizationId: string, input: NewCategoryInput): Promise<Category> {
    const { rows } = await this.db.query<CategoryRow>(
      `insert into restaurantes.categories (organization_id, name, slug, display_order)
       values ($1, $2, $3, $4)
       returning id, organization_id, name, slug, display_order;`,
      [organizationId, input.name, input.slug, input.displayOrder ?? 0],
    );
    return mapCategory(rows[0]!);
  }

  async updateCategory(organizationId: string, categoryId: string, patch: CategoryPatch): Promise<Category | null> {
    const { rows } = await this.db.query<CategoryRow>(
      `update restaurantes.categories
       set name = coalesce($3, name), slug = coalesce($4, slug), display_order = coalesce($5, display_order)
       where id = $1 and organization_id = $2
       returning id, organization_id, name, slug, display_order;`,
      [categoryId, organizationId, patch.name ?? null, patch.slug ?? null, patch.displayOrder ?? null],
    );
    return rows[0] ? mapCategory(rows[0]) : null;
  }

  async listProducts(organizationId: string): Promise<readonly Product[]> {
    const { rows } = await this.db.query<AdminProductRow>(
      `select ${ADMIN_PRODUCT_COLUMNS} ${ADMIN_PRODUCT_FROM} where pr.organization_id = $1 order by pr.display_order asc, pr.name asc;`,
      [organizationId],
    );
    return rows.map(mapAdminProduct);
  }

  async findProduct(organizationId: string, productId: string): Promise<Product | null> {
    const { rows } = await this.db.query<AdminProductRow>(`select ${ADMIN_PRODUCT_COLUMNS} ${ADMIN_PRODUCT_FROM} where pr.organization_id = $1 and pr.id = $2;`, [organizationId, productId]);
    return rows[0] ? mapAdminProduct(rows[0]) : null;
  }

  async createProduct(organizationId: string, input: NewProductInput): Promise<Product> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into restaurantes.products (organization_id, category_id, name, description, price, image_url, is_popular, is_available, display_order, search_keywords)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id;`,
      [
        organizationId,
        input.categoryId ?? null,
        input.name,
        input.description ?? null,
        input.price,
        input.imageUrl ?? null,
        input.isPopular ?? false,
        input.isAvailable ?? true,
        input.displayOrder ?? 0,
        input.searchKeywords ? [...input.searchKeywords] : [],
      ],
    );
    return (await this.findProduct(organizationId, rows[0]!.id))!;
  }

  async updateProduct(organizationId: string, productId: string, patch: ProductPatch): Promise<Product | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `update restaurantes.products
       set category_id = case when $3::boolean then $4::uuid else category_id end,
           name = coalesce($5, name),
           description = case when $6::boolean then $7 else description end,
           price = coalesce($8, price),
           image_url = case when $9::boolean then $10 else image_url end,
           is_popular = coalesce($11, is_popular),
           is_available = coalesce($12, is_available),
           display_order = coalesce($13, display_order),
           search_keywords = coalesce($14, search_keywords),
           updated_at = now()
       where id = $1 and organization_id = $2
       returning id;`,
      [
        productId,
        organizationId,
        patch.categoryId !== undefined,
        patch.categoryId ?? null,
        patch.name ?? null,
        patch.description !== undefined,
        patch.description ?? null,
        patch.imageUrl !== undefined,
        patch.imageUrl ?? null,
        patch.price ?? null,
        patch.isPopular ?? null,
        patch.isAvailable ?? null,
        patch.displayOrder ?? null,
        patch.searchKeywords ? [...patch.searchKeywords] : null,
      ],
    );
    if (!rows[0]) return null;
    return this.findProduct(organizationId, rows[0].id);
  }

  // ---- Fase 11 — promociones/marketing (ver promotions.ts, migrations/010) ----

  /** Lee promociones con las columnas de la migracion 027 y, contra una base SIN migrar (42703),
   * cae a las columnas anteriores. Corre dentro de la transaccion unica del request (p. ej.
   * crear pedido con codigo), asi que el respaldo EXIGE SAVEPOINT. */
  private async queryPromotions(where: string, params: readonly unknown[], suffix = ""): Promise<readonly Promotion[]> {
    const select = (columns: string) => `select ${columns} from restaurantes.promotions where ${where}${suffix};`;
    // Tres escalones de compatibilidad (cada uno con su SAVEPOINT, porque corren dentro de la transaccion
    // unica del request): migracion 038 (alcance por sucursal) -> 031 (auto_apply/cortesia) -> 027
    // (canales/productos) -> columnas base. Sin la 038 no hay alcance que leer: la promocion vale en todas.
    const rows = await runWithSavepointFallback<readonly PromotionRow[]>({
      session: this.db,
      savepointName: "sp_restaurantes_promociones_038_lectura",
      primary: async () => (await this.db.query<PromotionRow>(select(PROMOTION_COLUMNS_V4), [...params])).rows,
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: () =>
        runWithSavepointFallback<readonly PromotionRow[]>({
          session: this.db,
          savepointName: "sp_restaurantes_promociones_031_lectura",
          primary: async () => (await this.db.query<PromotionRow>(select(PROMOTION_COLUMNS_V3), [...params])).rows,
          isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
          fallback: () =>
            runWithSavepointFallback<readonly PromotionRow[]>({
              session: this.db,
              savepointName: "sp_restaurantes_promociones_2x1_lectura",
              primary: async () => (await this.db.query<PromotionRow>(select(PROMOTION_COLUMNS_V2), [...params])).rows,
              isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
              fallback: async () => (await this.db.query<PromotionRow>(select(PROMOTION_COLUMNS), [...params])).rows,
            }),
        }),
    });
    return rows.map(mapPromotion);
  }

  async listAutoApplyPromotions(organizationId: string): Promise<readonly Promotion[]> {
    // Contra la base sin la 031 `auto_apply` no existe (42703): vacio honesto, nunca error. Contra una base con la 031
    // pero sin la 038 se lee sin `property_ids` (las promociones valen en todas las sucursales, conducta anterior).
    const where = "where organization_id = $1 and auto_apply and is_active order by created_at, code";
    return runWithSavepointFallback<readonly Promotion[]>({
      session: this.db,
      savepointName: "sp_restaurantes_promociones_038_auto_lectura",
      primary: async () => {
        const { rows } = await this.db.query<PromotionRow>(`select ${PROMOTION_COLUMNS_V4} from restaurantes.promotions ${where};`, [organizationId]);
        return rows.map(mapPromotion);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: () =>
        runWithSavepointFallback<readonly Promotion[]>({
          session: this.db,
          savepointName: "sp_restaurantes_promociones_auto_lectura",
          primary: async () => {
            const { rows } = await this.db.query<PromotionRow>(`select ${PROMOTION_COLUMNS_V3} from restaurantes.promotions ${where};`, [organizationId]);
            return rows.map(mapPromotion);
          },
          isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
          fallback: async () => [],
        }),
    });
  }

  async listPromotions(organizationId: string): Promise<readonly Promotion[]> {
    return this.queryPromotions("organization_id = $1", [organizationId], " order by created_at desc");
  }

  async findPromotion(organizationId: string, promotionId: string): Promise<Promotion | null> {
    return (await this.queryPromotions("organization_id = $1 and id = $2", [organizationId, promotionId]))[0] ?? null;
  }

  async findPromotionByCode(organizationId: string, code: string): Promise<Promotion | null> {
    return (await this.queryPromotions("organization_id = $1 and code = $2", [organizationId, code]))[0] ?? null;
  }

  async createPromotion(organizationId: string, input: NewPromotionInput): Promise<Promotion> {
    const base = [
      organizationId,
      input.code,
      input.name,
      input.description ?? null,
      input.type,
      input.value,
      input.minOrderTotal ?? null,
      input.startsAt ?? null,
      input.endsAt ?? null,
      input.daysOfWeek ? [...input.daysOfWeek] : null,
      input.startTime ?? null,
      input.endTime ?? null,
      input.maxUses ?? null,
      input.isActive ?? true,
    ];
    if (input.propertyIds !== undefined) {
      // Escribe la columna de la migracion 038 (con las de la 027 y la 031): contra una base SIN migrar falla con 42703
      // (analisis de columnas, antes de cualquier CHECK) y se traduce a "config no disponible" con SAVEPOINT, nunca a
      // una promocion creada SIN su alcance (que valdria en todas las sucursales).
      return runWithSavepointFallback<Promotion>({
        session: this.db,
        savepointName: "sp_restaurantes_promociones_038_alta",
        primary: async () => {
          const { rows } = await this.db.query<PromotionRow>(
            `insert into restaurantes.promotions
               (organization_id, code, name, description, type, value, min_order_total, starts_at, ends_at, days_of_week, start_time, end_time, max_uses, is_active,
                channels, product_ids, auto_apply, courtesy_product_ids, courtesy_quantity, property_ids)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::smallint[], $11::time, $12::time, $13, $14, $15::text[], $16::uuid[], $17, $18::uuid[], $19, $20::uuid[])
             returning ${PROMOTION_COLUMNS_V4};`,
            [
              ...base,
              input.channels ? [...input.channels] : null,
              input.productIds ? [...input.productIds] : null,
              input.autoApply ?? false,
              input.courtesyProductIds ? [...input.courtesyProductIds] : null,
              input.courtesyQuantity ?? null,
              input.propertyIds ? [...input.propertyIds] : null,
            ],
          );
          return mapPromotion(rows[0]!);
        },
        isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
        fallback: (err) => {
          advertirModeloPmNoDisponible("promotions", err, "038_promociones_por_sucursal.sql");
          throw new RestaurantesConfigUnavailableError();
        },
      });
    }
    const usaMigracion031 = input.type === "cortesia" || input.autoApply !== undefined || input.courtesyProductIds !== undefined || input.courtesyQuantity !== undefined;
    if (usaMigracion031) {
      // Escribe columnas de la migracion 031 (y las de la 027): contra una base SIN migrar falla con
      // 42703 y se traduce a "config no disponible" con SAVEPOINT, nunca a una promocion a medias.
      return runWithSavepointFallback<Promotion>({
        session: this.db,
        savepointName: "sp_restaurantes_promociones_031_alta",
        primary: async () => {
          const { rows } = await this.db.query<PromotionRow>(
            `insert into restaurantes.promotions
               (organization_id, code, name, description, type, value, min_order_total, starts_at, ends_at, days_of_week, start_time, end_time, max_uses, is_active,
                channels, product_ids, auto_apply, courtesy_product_ids, courtesy_quantity)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::smallint[], $11::time, $12::time, $13, $14, $15::text[], $16::uuid[], $17, $18::uuid[], $19)
             returning ${PROMOTION_COLUMNS_V3};`,
            [
              ...base,
              input.channels ? [...input.channels] : null,
              input.productIds ? [...input.productIds] : null,
              input.autoApply ?? false,
              input.courtesyProductIds ? [...input.courtesyProductIds] : null,
              input.courtesyQuantity ?? null,
            ],
          );
          return mapPromotion(rows[0]!);
        },
        isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
        fallback: (err) => {
          advertirModeloPmNoDisponible("promotions", err, "031_recoger_promociones_automaticas_puentes.sql");
          throw new RestaurantesConfigUnavailableError();
        },
      });
    }
    const usaMigracion027 = input.type === "bogo" || input.channels !== undefined || input.productIds !== undefined;
    if (usaMigracion027) {
      // Escribe columnas de la migracion 027: contra una base SIN migrar falla con 42703 (analisis
      // de columnas, antes de cualquier CHECK) y se traduce a "config no disponible" con SAVEPOINT,
      // nunca a una promocion creada a medias.
      return runWithSavepointFallback<Promotion>({
        session: this.db,
        savepointName: "sp_restaurantes_promociones_2x1_alta",
        primary: async () => {
          const { rows } = await this.db.query<PromotionRow>(
            `insert into restaurantes.promotions
               (organization_id, code, name, description, type, value, min_order_total, starts_at, ends_at, days_of_week, start_time, end_time, max_uses, is_active, channels, product_ids)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::smallint[], $11::time, $12::time, $13, $14, $15::text[], $16::uuid[])
             returning ${PROMOTION_COLUMNS_V2};`,
            [...base, input.channels ? [...input.channels] : null, input.productIds ? [...input.productIds] : null],
          );
          return mapPromotion(rows[0]!);
        },
        isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
        fallback: (err) => {
          advertirModeloPmNoDisponible("promotions", err, "027_promociones_2x1_y_canal.sql");
          throw new RestaurantesConfigUnavailableError();
        },
      });
    }
    const { rows } = await this.db.query<PromotionRow>(
      `insert into restaurantes.promotions
         (organization_id, code, name, description, type, value, min_order_total, starts_at, ends_at, days_of_week, start_time, end_time, max_uses, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::smallint[], $11::time, $12::time, $13, $14)
       returning ${PROMOTION_COLUMNS};`,
      base,
    );
    return mapPromotion(rows[0]!);
  }

  async updatePromotion(organizationId: string, promotionId: string, patch: PromotionPatch): Promise<Promotion | null> {
    const setBase = `set code = coalesce($3, code),
           name = coalesce($4, name),
           description = case when $5::boolean then $6 else description end,
           type = coalesce($7, type),
           value = coalesce($8, value),
           min_order_total = case when $9::boolean then $10 else min_order_total end,
           starts_at = case when $11::boolean then $12::timestamptz else starts_at end,
           ends_at = case when $13::boolean then $14::timestamptz else ends_at end,
           days_of_week = case when $15::boolean then $16::smallint[] else days_of_week end,
           start_time = case when $17::boolean then $18::time else start_time end,
           end_time = case when $19::boolean then $20::time else end_time end,
           max_uses = case when $21::boolean then $22 else max_uses end,
           is_active = coalesce($23, is_active),
           updated_at = now()`;
    const params = [
      promotionId,
      organizationId,
      patch.code ?? null,
      patch.name ?? null,
      patch.description !== undefined,
      patch.description ?? null,
      patch.type ?? null,
      patch.value ?? null,
      patch.minOrderTotal !== undefined,
      patch.minOrderTotal ?? null,
      patch.startsAt !== undefined,
      patch.startsAt ?? null,
      patch.endsAt !== undefined,
      patch.endsAt ?? null,
      patch.daysOfWeek !== undefined,
      patch.daysOfWeek ? [...patch.daysOfWeek] : null,
      patch.startTime !== undefined,
      patch.startTime ?? null,
      patch.endTime !== undefined,
      patch.endTime ?? null,
      patch.maxUses !== undefined,
      patch.maxUses ?? null,
      patch.isActive ?? null,
    ];
    if (patch.propertyIds !== undefined) {
      return runWithSavepointFallback<Promotion | null>({
        session: this.db,
        savepointName: "sp_restaurantes_promociones_038_cambio",
        primary: async () => {
          const { rows } = await this.db.query<PromotionRow>(
            `update restaurantes.promotions
             ${setBase},
               channels = case when $24::boolean then $25::text[] else channels end,
               product_ids = case when $26::boolean then $27::uuid[] else product_ids end,
               auto_apply = coalesce($28, auto_apply),
               courtesy_product_ids = case when $29::boolean then $30::uuid[] else courtesy_product_ids end,
               courtesy_quantity = case when $31::boolean then $32::smallint else courtesy_quantity end,
               property_ids = $33::uuid[]
             where id = $1 and organization_id = $2
             returning ${PROMOTION_COLUMNS_V4};`,
            [
              ...params,
              patch.channels !== undefined,
              patch.channels ? [...patch.channels] : null,
              patch.productIds !== undefined,
              patch.productIds ? [...patch.productIds] : null,
              patch.autoApply ?? null,
              patch.courtesyProductIds !== undefined,
              patch.courtesyProductIds ? [...patch.courtesyProductIds] : null,
              patch.courtesyQuantity !== undefined,
              patch.courtesyQuantity ?? null,
              patch.propertyIds ? [...patch.propertyIds] : null,
            ],
          );
          return rows[0] ? mapPromotion(rows[0]) : null;
        },
        isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
        fallback: (err) => {
          advertirModeloPmNoDisponible("promotions", err, "038_promociones_por_sucursal.sql");
          throw new RestaurantesConfigUnavailableError();
        },
      });
    }
    const usaMigracion031 = patch.type === "cortesia" || patch.autoApply !== undefined || patch.courtesyProductIds !== undefined || patch.courtesyQuantity !== undefined;
    if (usaMigracion031) {
      return runWithSavepointFallback<Promotion | null>({
        session: this.db,
        savepointName: "sp_restaurantes_promociones_031_cambio",
        primary: async () => {
          const { rows } = await this.db.query<PromotionRow>(
            `update restaurantes.promotions
             ${setBase},
               channels = case when $24::boolean then $25::text[] else channels end,
               product_ids = case when $26::boolean then $27::uuid[] else product_ids end,
               auto_apply = coalesce($28, auto_apply),
               courtesy_product_ids = case when $29::boolean then $30::uuid[] else courtesy_product_ids end,
               courtesy_quantity = case when $31::boolean then $32::smallint else courtesy_quantity end
             where id = $1 and organization_id = $2
             returning ${PROMOTION_COLUMNS_V3};`,
            [
              ...params,
              patch.channels !== undefined,
              patch.channels ? [...patch.channels] : null,
              patch.productIds !== undefined,
              patch.productIds ? [...patch.productIds] : null,
              patch.autoApply ?? null,
              patch.courtesyProductIds !== undefined,
              patch.courtesyProductIds ? [...patch.courtesyProductIds] : null,
              patch.courtesyQuantity !== undefined,
              patch.courtesyQuantity ?? null,
            ],
          );
          return rows[0] ? mapPromotion(rows[0]) : null;
        },
        isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
        fallback: (err) => {
          advertirModeloPmNoDisponible("promotions", err, "031_recoger_promociones_automaticas_puentes.sql");
          throw new RestaurantesConfigUnavailableError();
        },
      });
    }
    const usaMigracion027 = patch.type === "bogo" || patch.channels !== undefined || patch.productIds !== undefined;
    if (usaMigracion027) {
      return runWithSavepointFallback<Promotion | null>({
        session: this.db,
        savepointName: "sp_restaurantes_promociones_2x1_cambio",
        primary: async () => {
          const { rows } = await this.db.query<PromotionRow>(
            `update restaurantes.promotions
             ${setBase},
               channels = case when $24::boolean then $25::text[] else channels end,
               product_ids = case when $26::boolean then $27::uuid[] else product_ids end
             where id = $1 and organization_id = $2
             returning ${PROMOTION_COLUMNS_V2};`,
            [
              ...params,
              patch.channels !== undefined,
              patch.channels ? [...patch.channels] : null,
              patch.productIds !== undefined,
              patch.productIds ? [...patch.productIds] : null,
            ],
          );
          return rows[0] ? mapPromotion(rows[0]) : null;
        },
        isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
        fallback: (err) => {
          advertirModeloPmNoDisponible("promotions", err, "027_promociones_2x1_y_canal.sql");
          throw new RestaurantesConfigUnavailableError();
        },
      });
    }
    // Sin campos de la migracion 027 en el cambio: el SET es el de siempre; solo el RETURNING intenta
    // traer las columnas nuevas (para no perder canales/productos en la respuesta) y, contra una base
    // sin migrar, repite el mismo UPDATE devolviendo las columnas anteriores.
    const update = (columns: string) => `update restaurantes.promotions ${setBase} where id = $1 and organization_id = $2 returning ${columns};`;
    return runWithSavepointFallback<Promotion | null>({
      session: this.db,
      savepointName: "sp_restaurantes_promociones_038_cambio_lectura",
      primary: async () => {
        const { rows } = await this.db.query<PromotionRow>(update(PROMOTION_COLUMNS_V4), params);
        return rows[0] ? mapPromotion(rows[0]) : null;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: () =>
        runWithSavepointFallback<Promotion | null>({
          session: this.db,
          savepointName: "sp_restaurantes_promociones_031_cambio_lectura",
          primary: async () => {
            const { rows } = await this.db.query<PromotionRow>(update(PROMOTION_COLUMNS_V3), params);
            return rows[0] ? mapPromotion(rows[0]) : null;
          },
          isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
          fallback: () =>
            runWithSavepointFallback<Promotion | null>({
              session: this.db,
              savepointName: "sp_restaurantes_promociones_2x1_cambio_lectura",
              primary: async () => {
                const { rows } = await this.db.query<PromotionRow>(update(PROMOTION_COLUMNS_V2), params);
                return rows[0] ? mapPromotion(rows[0]) : null;
              },
              isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
              fallback: async () => {
                const { rows } = await this.db.query<PromotionRow>(update(PROMOTION_COLUMNS), params);
                return rows[0] ? mapPromotion(rows[0]) : null;
              },
            }),
        }),
    });
  }

  /** `restaurantes.increment_promotion_uses` (ver migrations/010) es SECURITY
   * DEFINER — mismo patrón exacto que `create_order_idempotent` (migrations/003):
   * el UPDATE atómico re-verifica `is_active`/`max_uses` server-side, así dos
   * pedidos casi-simultáneos con el mismo código nunca lo rebasan, sin depender de
   * que el caller haya validado en memoria un momento antes. */
  async incrementPromotionUses(organizationId: string, promotionId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ increment_promotion_uses: PromotionRow | null }>(
      `select restaurantes.increment_promotion_uses($1, $2) as increment_promotion_uses;`,
      [organizationId, promotionId],
    );
    return rows[0]?.increment_promotion_uses != null;
  }

  async getBranchProductState(propertyId: string, productId: string): Promise<BranchProductState | null> {
    const { rows } = await this.db.query<BranchProductRow>(`select property_id, product_id, price, is_available from restaurantes.branch_products where property_id = $1 and product_id = $2;`, [
      propertyId,
      productId,
    ]);
    return rows[0] ? mapBranchProductState(rows[0]) : null;
  }

  async upsertBranchProductState(propertyId: string, productId: string, price: number, isAvailable: boolean): Promise<BranchProductState> {
    const { rows } = await this.db.query<BranchProductRow>(
      `insert into restaurantes.branch_products (property_id, product_id, price, is_available)
       values ($1, $2, $3, $4)
       on conflict (property_id, product_id) do update set price = excluded.price, is_available = excluded.is_available, updated_at = now()
       returning property_id, product_id, price, is_available;`,
      [propertyId, productId, price, isAvailable],
    );
    return mapBranchProductState(rows[0]!);
  }

  async setBranchProductAvailability(propertyId: string, productId: string, isAvailable: boolean): Promise<BranchProductState | null> {
    const { rows } = await this.db.query<BranchProductRow>(
      `update restaurantes.branch_products set is_available = $3, updated_at = now()
       where property_id = $1 and product_id = $2
       returning property_id, product_id, price, is_available;`,
      [propertyId, productId, isAvailable],
    );
    return rows[0] ? mapBranchProductState(rows[0]) : null;
  }

  async findOrderById(organizationId: string, orderId: string): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `select ${ORDER_COLUMNS}
       from restaurantes.orders where id = $1 and organization_id = $2;`,
      [orderId, organizationId],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async findLatestOrderByPhone(organizationId: string, customerPhone: string, sinceIso: string): Promise<Order | null | undefined> {
    // Se llama en CADA mensaje de WhatsApp, dentro de la transaccion unica del lote: un error de Postgres (p. ej. un permiso o una
    // columna que la base vieja no tiene) sin SAVEPOINT la dejaria abortada (25P02) y rompería el turno. Respaldo honesto: "no hay
    // pedido reciente conocido" (undefined: el agente no inventa un estado) y la sesion sigue viva.
    return runWithSavepointFallback<Order | null | undefined>({
      session: this.db,
      savepointName: "sp_restaurantes_pedido_reciente",
      primary: async () => {
        const { rows } = await this.db.query<OrderRow>(
          `select ${ORDER_COLUMNS}
           from restaurantes.orders
           where organization_id = $1
             and right(regexp_replace(customer_phone, '[^0-9]', '', 'g'), 10) = $2
             and created_at >= $3::timestamptz
             and status <> 'cancelado'
           order by created_at desc, id desc
           limit 1;`,
          [organizationId, customerPhone, sinceIso],
        );
        return rows[0] ? mapOrder(rows[0]) : null;
      },
      isRecoverable: esErrorSinPedidoRecienteDisponible,
      // undefined = estado DESCONOCIDO (no es lo mismo que "no hay pedido": el prompt no afirma nada).
      fallback: async () => undefined,
    });
  }

  async listOrders(organizationId: string, filter: OrderListFilter): Promise<OrderListPage> {
    const conditions: string[] = [`organization_id = $1`];
    const params: unknown[] = [organizationId];

    if (filter.propertyIds !== null) {
      params.push([...filter.propertyIds]);
      conditions.push(`property_id = any($${params.length}::uuid[])`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.dateFrom !== undefined) {
      params.push(filter.dateFrom.toISOString());
      conditions.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (filter.dateTo !== undefined) {
      params.push(filter.dateTo.toISOString());
      conditions.push(`created_at < $${params.length}::timestamptz`);
    }

    const cursor = decodeCursor(filter.cursor);
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }

    params.push(filter.limit + 1);
    const { rows } = await this.db.query<OrderRow>(
      // QA-restaurantes-R1-features-01: `pg` entrega created_at como Date (milisegundos). El cursor usa
      // la representacion TEXTO de Postgres (microsegundos exactos) para no saltar pedidos del mismo ms.
      `select ${ORDER_COLUMNS}, created_at::text as created_at_cursor
       from restaurantes.orders
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${params.length};`,
      params,
    );

    const hasMore = rows.length > filter.limit;
    const pageRows = rows.slice(0, filter.limit);
    const page = pageRows.map(mapOrder);
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.created_at_cursor ?? toIsoText(last.created_at), last.id) : null;
    return { orders: page, nextCursor };
  }

  async updateOrderStatus(organizationId: string, orderId: string, fromStatus: OrderStatus, toStatus: OrderStatus, incidentNote?: string | null): Promise<Order | null> {
    // Fix hallazgo auditoría (rubro 3, "máquina de estados de pedidos sin guarda
    // TOCTOU") — `and status = $4` es la guarda real: sin ella, el UPDATE aplica
    // ciegamente sobre CUALQUIER estado actual, incluso uno distinto al que
    // `order-lifecycle.ts` validó (con una lectura que para este punto puede ya
    // estar obsoleta por una escritura concurrente). Devuelve 0 filas (null) tanto
    // si el pedido no existe como si su estado real ya cambió — ver repository.ts.
    const run = async () => {
      const { rows } = await this.db.query<OrderRow>(
        `update restaurantes.orders
         set status = $3, delivered_at = case when $3 = 'entregado' then now() else delivered_at end,
             incident_note = case when $3 = 'problema' and $5::text is not null then $5::text else incident_note end
         where id = $1 and organization_id = $2 and status = $4
         returning ${ORDER_COLUMNS};`,
        [orderId, organizationId, toStatus, fromStatus, toStatus === "problema" ? (incidentNote ?? null) : null],
      );
      return rows[0] ? mapOrder(rows[0]) : null;
    };
    // Los estados de recoger (`listo_para_recoger`/`no_recogido`) los acepta el CHECK de la migracion 031:
    // contra la base SIN migrar el UPDATE falla con 23514 (check_violation). Este UPDATE corre dentro de la
    // transaccion unica del request, asi que el respaldo EXIGE SAVEPOINT; sin el, la transaccion quedaria
    // abortada (25P02) y el COMMIT perderia el resto del request.
    if (toStatus === "listo_para_recoger" || toStatus === "no_recogido") {
      return runWithSavepointFallback<Order | null>({
        session: this.db,
        savepointName: "sp_restaurantes_estado_recoger",
        primary: run,
        isRecoverable: (err) => (err as { code?: string } | null)?.code === "23514",
        fallback: (err) => {
          advertirModeloPmNoDisponible("orders", err, "031_recoger_promociones_automaticas_puentes.sql");
          throw new RestaurantesConfigUnavailableError();
        },
      });
    }
    return run();
  }

  // ---- Fase 8 — superficie real del rol "repartidor" (ver repository.ts para el
  // contrato completo de cada método). ----

  async assignRepartidorToOrder(organizationId: string, orderId: string, repartidorId: string, estimatedDeliveryAt: string | null): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `update restaurantes.orders
       set assigned_repartidor_id = $3, estimated_delivery_at = $4
       where id = $1 and organization_id = $2
       returning ${ORDER_COLUMNS};`,
      [orderId, organizationId, repartidorId, estimatedDeliveryAt],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async listOrdersForRepartidor(organizationId: string, repartidorId: string): Promise<readonly Order[]> {
    const { rows } = await this.db.query<OrderRow>(
      `select ${ORDER_COLUMNS}
       from restaurantes.orders
       where organization_id = $1 and assigned_repartidor_id = $2
       order by created_at desc
       limit 200;`,
      [organizationId, repartidorId],
    );
    return rows.map(mapOrder);
  }

  async listDeliveredOrdersForRepartidor(organizationId: string, repartidorId: string, fechaLocal: string, zonaHoraria: string): Promise<readonly Order[]> {
    // `delivered_at` es de la migracion 001: no hace falta fallback contra la base sin migrar. El dia local se convierte a un rango de
    // instantes en la zona de la sucursal: [00:00 local del dia, 00:00 local del dia siguiente).
    const { rows } = await this.db.query<OrderRow & { delivered_at: string | Date | null }>(
      `select ${ORDER_COLUMNS}, delivered_at
       from restaurantes.orders
       where organization_id = $1 and assigned_repartidor_id = $2 and delivered_at is not null
         and delivered_at >= ($3::date)::timestamp at time zone $4
         and delivered_at < (($3::date + 1))::timestamp at time zone $4
       order by delivered_at desc
       limit 200;`,
      [organizationId, repartidorId, fechaLocal, zonaHoraria],
    );
    return rows.map((r) => ({ ...mapOrder(r), deliveredAt: r.delivered_at === null ? null : r.delivered_at instanceof Date ? r.delivered_at.toISOString() : String(r.delivered_at) }));
  }

  async findAssignedOrderById(organizationId: string, repartidorId: string, orderId: string): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `select ${ORDER_COLUMNS}
       from restaurantes.orders
       where id = $1 and organization_id = $2 and assigned_repartidor_id = $3;`,
      [orderId, organizationId, repartidorId],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async updateAssignedOrderStatus(
    organizationId: string,
    repartidorId: string,
    orderId: string,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
    incidentNote: string | null,
  ): Promise<Order | null> {
    // Mismo fix TOCTOU que `updateOrderStatus` (`and status = $6`) — ver ese
    // comentario de cabecera.
    const { rows } = await this.db.query<OrderRow>(
      `update restaurantes.orders
       set status = $4,
           delivered_at = case when $4 = 'entregado' then now() else delivered_at end,
           incident_note = case when $4 = 'problema' then $5 else incident_note end
       where id = $1 and organization_id = $2 and assigned_repartidor_id = $3 and status = $6
       returning ${ORDER_COLUMNS};`,
      [orderId, organizationId, repartidorId, toStatus, incidentNote, fromStatus],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async findCustomerById(organizationId: string, customerId: string): Promise<Customer | null> {
    const { rows } = await this.db.query<CustomerRow>(
      `select id, organization_id, phone, name, order_count from restaurantes.customers where organization_id = $1 and id = $2;`,
      [organizationId, customerId],
    );
    return rows[0] ? mapCustomer(rows[0]) : null;
  }

  async listCustomers(organizationId: string, filter: CustomerListFilter): Promise<CustomerListPage> {
    // Migracion 054: `clientes_cartera` resuelve nivel / frecuencia / dias sin pedir / sucursal en el servidor y trae el nivel de cada cliente.
    // SAVEPOINT (la sesion es UNA transaccion por request): sin la migracion cae al listado de siempre (sin nivel) y, si se pidio un filtro
    // nuevo, a una lista vacia con `filtrosDisponibles: false` (estado honesto, nunca un 500).
    const search = filter.search?.trim();
    const cursor = filter.cursor && UUID_TEXT.test(filter.cursor) ? filter.cursor : null;
    const pidioFiltroNuevo = filter.nivel !== undefined || filter.frecuencia !== undefined || filter.inactivoDias !== undefined || filter.propertyId !== undefined;
    return runWithSavepointFallback<CustomerListPage>({
      session: this.db,
      primary: async () => {
        // La funcion SQL rechaza p_limit > 200 (22023): se pagina por dentro en bloques de <= 200 (cursor por id), de modo
        // que un llamador con limit 500 (exportaciones) siga funcionando. Todos los bloques corren en el mismo SAVEPOINT.
        const quiero = filter.limit + 1;
        const rows: CustomerCarteraRow[] = [];
        let cursorBloque = cursor;
        while (rows.length < quiero) {
          const pedir = Math.min(CARTERA_LIMITE_SQL, quiero - rows.length);
          const { rows: bloque } = await this.db.query<CustomerCarteraRow>(
            `select customer_id, phone, name, order_count, last_order_at, tier
               from restaurantes.clientes_cartera($1::uuid, $2::text, $3::text, $4::int, $5::uuid, $6::text, $7::int, $8::uuid);`,
            [organizationId, filter.nivel ?? null, filter.frecuencia ?? null, filter.inactivoDias ?? null, filter.propertyId ?? null, search ? escapeLike(search) : null, pedir, cursorBloque],
          );
          rows.push(...bloque);
          if (bloque.length < pedir) break;
          cursorBloque = bloque[bloque.length - 1]!.customer_id;
        }
        const hasMore = rows.length > filter.limit;
        const page = rows.slice(0, filter.limit).map((r) => mapCustomerCartera(organizationId, r));
        return { customers: page, nextCursor: hasMore ? page[page.length - 1]!.id : null, filtrosDisponibles: true };
      },
      isRecoverable: esErrorBaseSinMigrar054,
      fallback: async () => {
        if (pidioFiltroNuevo) return { customers: [], nextCursor: null, filtrosDisponibles: false };
        return this.listCustomersSinMigracion054(organizationId, filter);
      },
    });
  }

  /** El listado anterior a la migracion 054 (sin nivel ni filtros nuevos). */
  private async listCustomersSinMigracion054(organizationId: string, filter: CustomerListFilter): Promise<CustomerListPage> {
    const conditions: string[] = [`organization_id = $1`];
    const params: unknown[] = [organizationId];

    const search = filter.search?.trim();
    if (search) {
      // QA-restaurantes-R1-features-06b: % _ \ del texto buscado son literales, no comodines.
      params.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
      conditions.push(`(name ilike $${params.length} or phone ilike $${params.length})`);
    }
    // QA-restaurantes-R1-features-06a: un cursor que no es uuid se ignora (antes: 22P02 -> 500).
    if (filter.cursor && UUID_TEXT.test(filter.cursor)) {
      params.push(filter.cursor);
      conditions.push(`id > $${params.length}`);
    }

    params.push(filter.limit + 1);
    const { rows } = await this.db.query<CustomerRow & { readonly last_order_at: unknown }>(
      `select id, organization_id, phone, name, order_count, last_order_at from restaurantes.customers
       where ${conditions.join(" and ")}
       order by id asc
       limit $${params.length};`,
      params,
    );

    const hasMore = rows.length > filter.limit;
    const page = rows.slice(0, filter.limit).map((r) => ({ ...mapCustomer(r), tier: null, lastOrderAt: isoOrNullCustomer(r.last_order_at) }));
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;
    return { customers: page, nextCursor, filtrosDisponibles: true };
  }

  async getCarteraKpis(organizationId: string): Promise<CarteraKpis> {
    return runWithSavepointFallback<CarteraKpis>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{
          total: string | number;
          recurrentes: string | number;
          ticket_promedio: string | number | null;
          top_customer_id: string | null;
          top_order_count: number | null;
          top_last_order_at: unknown;
        }>(`select total, recurrentes, ticket_promedio, top_customer_id, top_order_count, top_last_order_at from restaurantes.cartera_kpis($1::uuid);`, [organizationId]);
        const r = rows[0];
        if (!r) return { disponible: true, total: 0, recurrentes: 0, ticketPromedio: null, masFrecuente: null };
        return {
          disponible: true,
          total: Number(r.total),
          recurrentes: Number(r.recurrentes),
          ticketPromedio: r.ticket_promedio === null ? null : Number(r.ticket_promedio),
          masFrecuente: r.top_customer_id ? { customerId: r.top_customer_id, orderCount: Number(r.top_order_count ?? 0), ultimoPedidoEn: isoOrNullCustomer(r.top_last_order_at) } : null,
        };
      },
      isRecoverable: esErrorBaseSinMigrar054,
      fallback: async () => ({ disponible: false }),
    });
  }

  async importarClientes(organizationId: string, huella: string, filas: readonly FilaImportacionCliente[]): Promise<ResultadoImportacionClientes> {
    return runWithSavepointFallback<ResultadoImportacionClientes>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ ya_importado: boolean; total: number; creados: number; actualizados: number; sin_cambios: number; rechazados: number }>(
          `select ya_importado, total, creados, actualizados, sin_cambios, rechazados from restaurantes.importar_clientes($1::uuid, $2, $3::jsonb);`,
          [organizationId, huella, JSON.stringify(filas.map((f) => ({ phone: f.phone, name: f.name, address: f.address, notes: f.notes })))],
        );
        const r = rows[0];
        if (!r) throw new Error("importar_clientes no devolvio resultado");
        return { disponible: true, yaImportado: r.ya_importado, total: Number(r.total), creados: Number(r.creados), actualizados: Number(r.actualizados), sinCambios: Number(r.sin_cambios), rechazados: Number(r.rechazados) };
      },
      isRecoverable: esErrorBaseSinMigrar054,
      fallback: async () => ({ disponible: false }),
    });
  }

  async getCustomerNotes(organizationId: string, customerId: string): Promise<string | null> {
    return runWithSavepointFallback<string | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ notes: string | null }>(`select notes from restaurantes.customers where organization_id = $1 and id = $2;`, [organizationId, customerId]);
        return rows[0]?.notes ?? null;
      },
      isRecoverable: esErrorBaseSinMigrar054,
      fallback: async () => null,
    });
  }

  // ---- FASE 3 (producto) -- bitácora de auditoría del staff ----

  /**
   * Nunca lanza -- best-effort real (regla dura de esta fase, ver AGENTS.md):
   * un error real de Postgres dentro de esta transacción compartida (misma
   * `dbSession`/`withAppSession` del request de staff) deja la transacción
   * "abortada" si no se recupera con un SAVEPOINT -- la SIGUIENTE consulta
   * (incluido el `commit` final del request) fallaría con 25P02, revirtiendo
   * la acción de negocio que ya había corrido con éxito antes de llamar aquí.
   * Mismo patrón EXACTO que `PostgresRentasRepository.registrarAuditoria`.
   */
  async registrarAuditoria(input: RegistrarAuditoriaInput): Promise<void> {
    try {
      await this.db.exec(`SAVEPOINT ${RESTAURANTES_AUDIT_LOG_WRITE_SAVEPOINT}`);
    } catch (err) {
      // Ni siquiera pudo abrirse el SAVEPOINT (sesión que no soporta SAVEPOINT,
      // p.ej. un doble de prueba angosto) -- se registra y se sale sin tocar nada
      // más, la acción de negocio sigue intacta.
      console.error("PostgresRestaurantesRepository.registrarAuditoria: no se pudo abrir el SAVEPOINT -- se omite el registro de bitácora.", err);
      return;
    }
    try {
      await this.db.query(`select restaurantes.record_audit_log($1, $2, $3, $4, $5, $6, $7);`, [
        input.organizationId,
        input.action,
        input.entityType,
        input.entityId,
        input.campo ?? null,
        input.antes ?? null,
        input.despues ?? null,
      ]);
      await this.db.exec(`RELEASE SAVEPOINT ${RESTAURANTES_AUDIT_LOG_WRITE_SAVEPOINT}`);
    } catch (err) {
      try {
        await this.db.exec(`ROLLBACK TO SAVEPOINT ${RESTAURANTES_AUDIT_LOG_WRITE_SAVEPOINT}`);
        await this.db.exec(`RELEASE SAVEPOINT ${RESTAURANTES_AUDIT_LOG_WRITE_SAVEPOINT}`);
      } catch (recoveryErr) {
        console.error("PostgresRestaurantesRepository.registrarAuditoria: fallo al recuperar el SAVEPOINT tras un error de bitácora.", recoveryErr);
      }
      if (esErrorCompatibilidadAuditLogBaseSinMigrar(err)) {
        advertirAuditLogEscrituraNoDisponible(err);
        return;
      }
      // Error inesperado (no de compatibilidad) -- se registra para diagnóstico pero
      // TAMPOCO se propaga: la regla dura de arriba no distingue "por qué" falló la
      // bitácora, solo que nunca puede tumbar ni revertir la acción de negocio ya
      // hecha.
      console.error("PostgresRestaurantesRepository.registrarAuditoria: fallo inesperado al escribir en restaurantes.audit_log (la acción de negocio ya se completó y NO se revierte).", err);
    }
  }

  async listAuditoria(organizationId: string, filtro: RestaurantesAuditLogFiltro, paginacion: RestaurantesAuditLogPaginacion): Promise<RestaurantesAuditLogPagina> {
    const limit = Math.min(200, Math.max(1, paginacion.limit ?? 50));
    const offset = Math.max(0, paginacion.offset ?? 0);

    const params: unknown[] = [organizationId];
    const condiciones = ["organization_id = $1"];
    if (filtro.entityType) {
      params.push(filtro.entityType);
      condiciones.push(`entity_type = $${params.length}`);
    }
    // Mismo criterio EXACTO que `PostgresRentasRepository.listAuditoria`: ancla
    // `desde`/`hasta` a America/Mexico_City con offset fijo `-06:00` (México no
    // tiene horario de verano nacional desde 2022) -- comparar contra
    // `created_at >= $n::date` usaría la zona horaria de la SESIÓN de Postgres
    // (UTC), y una acción de las 18:00 a las 23:59 hora de México caería en el
    // día SIGUIENTE del filtro.
    if (filtro.desde) {
      params.push(`${filtro.desde}T00:00:00-06:00`);
      condiciones.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (filtro.hasta) {
      // Extremo inclusivo -- `hasta` es una fecha (sin hora), así que compara
      // contra el INICIO del día siguiente en vez de `<=`.
      params.push(`${filtro.hasta}T00:00:00-06:00`);
      condiciones.push(`created_at < ($${params.length}::timestamptz + interval '1 day')`);
    }
    const where = condiciones.join(" and ");

    return runWithSavepointFallback<RestaurantesAuditLogPagina>({
      session: this.db,
      savepointName: RESTAURANTES_AUDIT_LOG_READ_SAVEPOINT,
      primary: async () => {
        const totalResult = await this.db.query<{ total: string }>(`select count(*)::text as total from restaurantes.audit_log where ${where};`, params);
        const total = Number(totalResult.rows[0]?.total ?? 0);

        const limitOffsetParams = [...params, limit, offset];
        // Orden TOTAL desde el día uno (`seq` ya existe en migrations/019, ver su
        // comentario de cabecera) -- a diferencia de rentas, nunca hace falta un
        // fallback anidado por "seq no existe todavía".
        const { rows } = await this.db.query<RestaurantesAuditLogRowSql>(
          `select id, actor_user_id, action, entity_type, entity_id, campo, antes, despues, created_at::text as created_at
           from restaurantes.audit_log where ${where} order by created_at desc, seq desc limit $${limitOffsetParams.length - 1} offset $${limitOffsetParams.length};`,
          limitOffsetParams,
        );

        const items = rows.map(mapRestaurantesAuditLogRow);
        return { disponible: true, items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
      },
      isRecoverable: esErrorCompatibilidadAuditLogBaseSinMigrar,
      fallback: (err) => {
        advertirAuditLogLecturaNoDisponible(err);
        return Promise.resolve({ disponible: false, items: [], total: 0, nextOffset: null });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // FASE 3 (producto) -- configuración editable del panel, ver migrations/
  // 021_restaurantes_config_editable_y_search_path_fix.sql.
  //
  // COMPATIBILIDAD CON LA BASE SIN MIGRAR -- A DIFERENCIA de audit_log (tabla
  // NUEVA, SQLSTATE 42883/42P01/42703): `whatsapp_channel_config`/`known_zone`
  // YA EXISTÍAN desde Fase 1/2, así que si la migración 021 todavía no se aplicó
  // a la base real, el INSERT/UPDATE/DELETE nuevo no falla por "objeto
  // inexistente" -- falla por RLS/GRANT ausente, SQLSTATE 42501
  // (`insufficient_privilege`, "permission denied for table ..." o "new row
  // violates row-level security policy ..."). `esErrorCompatibilidadConfig
  // BaseSinMigrar` reconoce ambos casos (42501 explícito + el trío estándar de
  // `@atiende/db::isMigrationPendingError`, por si la propia tabla tampoco
  // existiera en un entorno todavía más atrasado) -- ver AGENTS.md, REGLA DURA
  // de compatibilidad.
  // ---------------------------------------------------------------------------

  async getWhatsappChannelConfig(organizationId: string): Promise<WhatsappChannelConfig> {
    const { rows } = await this.db.query<{ phone_number_id: string }>(
      `select phone_number_id from restaurantes.whatsapp_channel_config where organization_id = $1;`,
      [organizationId],
    );
    return { phoneNumberId: rows[0]?.phone_number_id ?? null };
  }

  async upsertWhatsappChannelConfig(organizationId: string, phoneNumberId: string): Promise<WhatsappChannelConfig> {
    try {
      return await runWithSavepointFallback<WhatsappChannelConfig>({
        session: this.db,
        savepointName: "sp_restaurantes_whatsapp_config_write",
        primary: async () => {
          const { rows } = await this.db.query<{ phone_number_id: string }>(
            `insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id)
             values ($1, $2)
             on conflict (organization_id) do update set phone_number_id = excluded.phone_number_id
             returning phone_number_id;`,
            [organizationId, phoneNumberId],
          );
          return { phoneNumberId: rows[0]!.phone_number_id };
        },
        isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
        fallback: (err) => {
          advertirConfigEscrituraNoDisponible("whatsapp_channel_config", err);
          throw new RestaurantesConfigUnavailableError();
        },
      });
    } catch (err) {
      // 23505: el numero ya es de otra organizacion (UNIQUE de la tabla o guardia de
      // unicidad cruzada con los numeros por sucursal, migracion 023). El SAVEPOINT ya
      // dejo la sesion utilizable.
      if ((err as { code?: string } | null)?.code === "23505") throw new WhatsappNumberInUseError();
      throw err;
    }
  }

  async findStorefrontMarca(organizationId: string): Promise<StorefrontMarca | null> {
    // Base sin la migracion 062 (42P01/42703) o sin permiso (42501): sin marca, nunca un 500. SAVEPOINT: la sesion es una sola
    // transaccion por request y un error de Postgres la dejaria abortada.
    return runWithSavepointFallback<StorefrontMarca | null>({
      session: this.db,
      savepointName: "sp_restaurantes_storefront_marca_read",
      primary: async () => {
        const { rows } = await this.db.query<StorefrontMarcaRow>(
          `select titular, eslogan, about, portada_url, logo_url, instagram_url, facebook_url, tiktok_url, updated_at
             from restaurantes.storefront_marca where organization_id = $1;`,
          [organizationId],
        );
        return rows[0] ? mapStorefrontMarca(rows[0]) : null;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => null,
    });
  }

  async upsertStorefrontMarca(organizationId: string, input: StorefrontMarcaInput): Promise<StorefrontMarca> {
    return runWithSavepointFallback<StorefrontMarca>({
      session: this.db,
      savepointName: "sp_restaurantes_storefront_marca_write",
      primary: async () => {
        const { rows } = await this.db.query<StorefrontMarcaRow>(
          `insert into restaurantes.storefront_marca (organization_id, titular, eslogan, about, portada_url, logo_url, instagram_url, facebook_url, tiktok_url)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (organization_id) do update set
             titular = excluded.titular, eslogan = excluded.eslogan, about = excluded.about, portada_url = excluded.portada_url,
             logo_url = excluded.logo_url, instagram_url = excluded.instagram_url, facebook_url = excluded.facebook_url, tiktok_url = excluded.tiktok_url
           returning titular, eslogan, about, portada_url, logo_url, instagram_url, facebook_url, tiktok_url, updated_at;`,
          [organizationId, input.titular, input.eslogan, input.about, input.portadaUrl, input.logoUrl, input.instagramUrl, input.facebookUrl, input.tiktokUrl],
        );
        return mapStorefrontMarca(rows[0]!);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirConfigEscrituraNoDisponible("storefront_marca", err, "062_storefront_marca.sql");
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  async listKnownZones(organizationId: string): Promise<readonly KnownZone[]> {
    const { rows } = await this.db.query<KnownZoneRowSql>(
      `select id, organization_id, name, lat, lng, created_at::text as created_at
       from restaurantes.known_zone where organization_id = $1 order by created_at desc, id desc;`,
      [organizationId],
    );
    return rows.map(mapKnownZoneRow);
  }

  async listColoniasReferencia(organizationId: string): Promise<ColoniasReferenciaLectura> {
    // Columnas de la migracion 056: contra la base sin migrar (42703) el reporte dice "no disponible", sin abortar la transaccion del request.
    return runWithSavepointFallback<ColoniasReferenciaLectura>({
      session: this.db,
      savepointName: "sp_restaurantes_colonias_referencia",
      primary: async () => {
        const { rows } = await this.db.query<{
          id: string;
          name: string;
          lat: string | number | null;
          lng: string | number | null;
          fuente: string | null;
          asignacion_fuente: string | null;
          ref_sucursal_slug: string | null;
          ref_km: string | number | null;
          ref2_sucursal_slug: string | null;
          ref2_km: string | number | null;
        }>(
          `select id, name, lat, lng, fuente, asignacion_fuente, ref_sucursal_slug, ref_km, ref2_sucursal_slug, ref2_km
             from restaurantes.known_zone where organization_id = $1 order by name asc, id asc;`,
          [organizationId],
        );
        return {
          disponible: true,
          zonas: rows.map((r) => ({
            zoneId: r.id,
            name: r.name,
            lat: r.lat === null ? null : Number(r.lat),
            lng: r.lng === null ? null : Number(r.lng),
            fuente: r.fuente,
            asignacionFuente: r.asignacion_fuente,
            refSucursalSlug: r.ref_sucursal_slug,
            refKm: r.ref_km === null ? null : Number(r.ref_km),
            ref2SucursalSlug: r.ref2_sucursal_slug,
            ref2Km: r.ref2_km === null ? null : Number(r.ref2_km),
          })),
        };
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => ({ disponible: false, zonas: [] }),
    });
  }

  async createKnownZone(organizationId: string, input: NewKnownZoneInput): Promise<KnownZone> {
    return runWithSavepointFallback<KnownZone>({
      session: this.db,
      savepointName: "sp_restaurantes_known_zone_write",
      primary: async () => {
        const { rows } = await this.db.query<KnownZoneRowSql>(
          `insert into restaurantes.known_zone (organization_id, name, lat, lng)
           values ($1, $2, $3, $4)
           returning id, organization_id, name, lat, lng, created_at::text as created_at;`,
          [organizationId, input.name, input.lat, input.lng],
        );
        return mapKnownZoneRow(rows[0]!);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirConfigEscrituraNoDisponible("known_zone", err);
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  async deleteKnownZone(organizationId: string, zoneId: string): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_restaurantes_known_zone_delete",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `delete from restaurantes.known_zone where id = $1 and organization_id = $2 returning id;`,
          [zoneId, organizationId],
        );
        return rows.length > 0;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirConfigEscrituraNoDisponible("known_zone", err);
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  // ---- FASE 3 (producto) -- zona horaria por negocio (migración 022,
  // `restaurantes.branch_detail.zona_horaria`). Consulta AISLADA de `findBranch`
  // (que no cambia -- `Branch` es un tipo público usado en muchos call-sites, ver
  // el comentario de cabecera de la migración) -- corre DENTRO de la transacción
  // de `prepareCreateOrder` (que sigue con el INSERT del pedido después), así que
  // el `runWithSavepointFallback` de LECTURA es obligatorio (no opcional) aquí,
  // mismo motivo que el resto de este archivo. ----
  async findBranchZonaHoraria(propertyId: string): Promise<BranchTimezoneConfig> {
    return runWithSavepointFallback<BranchTimezoneConfig>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_zona_horaria_read",
      primary: async () => {
        const { rows } = await this.db.query<{ zona_horaria: string | null }>(`select zona_horaria from restaurantes.branch_detail where property_id = $1;`, [propertyId]);
        return { zonaHoraria: rows[0]?.zona_horaria ?? null };
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => ({ zonaHoraria: null }),
    });
  }

  /** UPDATE real, nunca upsert -- la fila de `branch_detail` de una property
   *  SIEMPRE existe (es la misma fila que resuelve `findBranch`, PK
   *  `property_id`) -- ver el comentario de cabecera de la migración 022. */
  async upsertBranchZonaHoraria(propertyId: string, zonaHoraria: string | null): Promise<BranchTimezoneConfig> {
    return runWithSavepointFallback<BranchTimezoneConfig>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_zona_horaria_write",
      primary: async () => {
        const { rows } = await this.db.query<{ zona_horaria: string | null }>(
          `update restaurantes.branch_detail set zona_horaria = $2 where property_id = $1 returning zona_horaria;`,
          [propertyId, zonaHoraria],
        );
        if (!rows[0]) throw new Error(`upsertBranchZonaHoraria: la property "${propertyId}" no existe.`);
        return { zonaHoraria: rows[0].zona_horaria };
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirConfigEscrituraNoDisponible("branch_detail.zona_horaria", err);
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Modelo PM (migracion 023) -- ver packages/domain-restaurantes/migrations/
  // 023_modelo_pm_horarios_minimos_zonas_whatsapp_sucursal.sql. Las tablas son NUEVAS:
  // contra una base sin migrar toda lectura falla con 42P01/42703 y degrada a "sin
  // configurar" (la consulta corre dentro de la transaccion unica de un request, por eso
  // SAVEPOINT obligatorio); toda escritura lanza RestaurantesConfigUnavailableError.
  // ---------------------------------------------------------------------------

  // ---- Agente de WhatsApp por organizacion/sucursal (migracion 029) ----
  async findWhatsAppAgentConfig(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null> {
    // Con la migracion 039 trae ademas el umbral de pedido grande y la espera de rafagas; sin ella (42703) cae al lector de 033/029.
    return runWithSavepointFallback<WhatsAppAgentConfigRow | null>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_agent_config_read_039",
      primary: async () => {
        const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
          `select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text,
                  greeting_text, salsas_text, promos_text, escalation_reasons_off, large_order_text, reply_debounce_seconds, version
             from restaurantes.whatsapp_agent_config
            where organization_id = $1 and enabled = true and (property_id = $2 or property_id is null)
            order by (property_id is null) asc
            limit 1;`,
          [organizationId, propertyId],
        );
        return rows[0] ? mapWhatsAppAgentConfigRow(rows[0]) : null;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: () => this.findWhatsAppAgentConfigV033(organizationId, propertyId),
    });
  }

  private async findWhatsAppAgentConfigV033(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null> {
    // Lectura dentro de la transaccion unica del turno: una base sin migrar (42P01/42703/42501/42883)
    // NO puede abortarla; con SAVEPOINT cae a "sin config" y el turno sigue con el agente generico.
    // Con la migracion 033 trae ademas los campos nuevos y la version; sin ella (42703) cae al SELECT de 029.
    return runWithSavepointFallback<WhatsAppAgentConfigRow | null>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_agent_config_read",
      primary: async () => {
        const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
          `select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text,
                  greeting_text, salsas_text, promos_text, escalation_reasons_off, version
             from restaurantes.whatsapp_agent_config
            where organization_id = $1 and enabled = true and (property_id = $2 or property_id is null)
            order by (property_id is null) asc
            limit 1;`,
          [organizationId, propertyId],
        );
        return rows[0] ? mapWhatsAppAgentConfigRow(rows[0]) : null;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: () =>
        runWithSavepointFallback<WhatsAppAgentConfigRow | null>({
          session: this.db,
          savepointName: "sp_restaurantes_whatsapp_agent_config_read_029",
          primary: async () => {
            const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
              `select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text
                 from restaurantes.whatsapp_agent_config
                where organization_id = $1 and enabled = true and (property_id = $2 or property_id is null)
                order by (property_id is null) asc
                limit 1;`,
              [organizationId, propertyId],
            );
            return rows[0] ? mapWhatsAppAgentConfigRow(rows[0]) : null;
          },
          isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
          fallback: async () => null,
        }),
    });
  }

  async findWhatsAppAgentConfigExacta(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null> {
    return runWithSavepointFallback<WhatsAppAgentConfigRow | null>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_agent_config_exacta_039",
      primary: async () => {
        const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
          `select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text,
                  greeting_text, salsas_text, promos_text, escalation_reasons_off, large_order_text, reply_debounce_seconds, version
             from restaurantes.whatsapp_agent_config
            where organization_id = $1 and property_id is not distinct from $2::uuid;`,
          [organizationId, propertyId],
        );
        return rows[0] ? mapWhatsAppAgentConfigRow(rows[0]) : null;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: () => this.findWhatsAppAgentConfigExactaV033(organizationId, propertyId),
    });
  }

  private async findWhatsAppAgentConfigExactaV033(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null> {
    return runWithSavepointFallback<WhatsAppAgentConfigRow | null>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_agent_config_exacta",
      primary: async () => {
        const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
          `select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text,
                  greeting_text, salsas_text, promos_text, escalation_reasons_off, version
             from restaurantes.whatsapp_agent_config
            where organization_id = $1 and property_id is not distinct from $2::uuid;`,
          [organizationId, propertyId],
        );
        return rows[0] ? mapWhatsAppAgentConfigRow(rows[0]) : null;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: () =>
        runWithSavepointFallback<WhatsAppAgentConfigRow | null>({
          session: this.db,
          savepointName: "sp_restaurantes_whatsapp_agent_config_exacta_029",
          primary: async () => {
            const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
              `select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text
                 from restaurantes.whatsapp_agent_config
                where organization_id = $1 and property_id is not distinct from $2::uuid;`,
              [organizationId, propertyId],
            );
            return rows[0] ? mapWhatsAppAgentConfigRow(rows[0]) : null;
          },
          isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
          fallback: async () => null,
        }),
    });
  }

  async guardarWhatsAppAgentConfig(
    organizationId: string,
    propertyId: string | null,
    config: WhatsAppAgentConfigInput,
    meta: { readonly accion: WhatsAppAgentConfigAccion; readonly actorUserId: string; readonly versionEsperada: number | null },
  ): Promise<WhatsAppAgentConfigRow> {
    return runWithSavepointFallback<WhatsAppAgentConfigRow>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_agent_config_guardar_039",
      primary: async () => {
        const previa = await this.leerConfigExactaV3(organizationId, propertyId);
        const conflict = propertyId === null ? "(organization_id) where property_id is null" : "(organization_id, property_id) where property_id is not null";
        const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
          `insert into restaurantes.whatsapp_agent_config as c
             (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, large_order_text, reply_debounce_seconds, enabled, version, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, $13, true, 1, now())
           on conflict ${conflict} do update set
             perfil = excluded.perfil,
             agent_name = excluded.agent_name,
             business_name = excluded.business_name,
             tone_style = excluded.tone_style,
             delivery_time_text = excluded.delivery_time_text,
             greeting_text = excluded.greeting_text,
             salsas_text = excluded.salsas_text,
             promos_text = excluded.promos_text,
             escalation_reasons_off = excluded.escalation_reasons_off,
             large_order_text = excluded.large_order_text,
             reply_debounce_seconds = excluded.reply_debounce_seconds,
             enabled = true,
             version = c.version + 1,
             updated_at = excluded.updated_at
             where $14::int is null or c.version = $14::int
           returning property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, large_order_text, reply_debounce_seconds, version;`,
          [
            organizationId,
            propertyId,
            config.perfil,
            config.agentName,
            config.businessName,
            config.toneStyle,
            config.deliveryTimeText,
            config.greetingText ?? null,
            config.salsasText ?? null,
            config.promosText ?? null,
            [...(config.escalationReasonsOff ?? [])],
            config.largeOrderText ?? null,
            config.replyDebounceSeconds ?? null,
            meta.versionEsperada,
          ],
        );
        // Sin fila devuelta: la fila existe con otra version (otro guardado gano) -> conflicto, no 500.
        if (!rows[0]) throw new WhatsAppAgentConfigConflictError();
        const guardada = mapWhatsAppAgentConfigRow(rows[0]);
        try {
          await this.db.query(
            `insert into restaurantes.whatsapp_agent_config_history (organization_id, property_id, version, accion, anterior, nuevo, actor_id)
             values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7);`,
            [
              organizationId,
              propertyId,
              guardada.version,
              meta.accion,
              previa ? JSON.stringify(fotoConfigAgente(previa)) : null,
              JSON.stringify(fotoConfigAgente(guardada)),
              meta.actorUserId,
            ],
          );
        } catch (err) {
          // Dos guardados con la misma version (indice unico del historial) = conflicto de concurrencia.
          if ((err as { code?: string } | null)?.code === "23505") throw new WhatsAppAgentConfigConflictError();
          throw err;
        }
        return guardada;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async (err) => {
        // Base sin la migracion 039: se puede guardar todo lo de 033/029, pero NO el umbral ni la espera (no se descartan en silencio).
        // 0 equivale a "apagada" (null): no exige la migracion 039.
        if (config.largeOrderText || (config.replyDebounceSeconds ?? 0) > 0) {
          advertirModeloPmNoDisponible("whatsapp_agent_config", err, "039_agente_config_umbral_y_rafagas.sql");
          throw new RestaurantesConfigUnavailableError();
        }
        return this.guardarWhatsAppAgentConfigV033(organizationId, propertyId, config, meta);
      },
    });
  }

  private async leerConfigExactaV3(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null> {
    const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
      `select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, large_order_text, reply_debounce_seconds, version
         from restaurantes.whatsapp_agent_config
        where organization_id = $1 and property_id is not distinct from $2::uuid;`,
      [organizationId, propertyId],
    );
    return rows[0] ? mapWhatsAppAgentConfigRow(rows[0]) : null;
  }

  private async guardarWhatsAppAgentConfigV033(
    organizationId: string,
    propertyId: string | null,
    config: WhatsAppAgentConfigInput,
    meta: { readonly accion: WhatsAppAgentConfigAccion; readonly actorUserId: string; readonly versionEsperada: number | null },
  ): Promise<WhatsAppAgentConfigRow> {
    return runWithSavepointFallback<WhatsAppAgentConfigRow>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_agent_config_guardar",
      primary: async () => {
        const previa = await this.leerConfigExactaV2(organizationId, propertyId);
        const conflict = propertyId === null ? "(organization_id) where property_id is null" : "(organization_id, property_id) where property_id is not null";
        const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
          `insert into restaurantes.whatsapp_agent_config as c
             (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, enabled, version, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], true, 1, now())
           on conflict ${conflict} do update set
             perfil = excluded.perfil,
             agent_name = excluded.agent_name,
             business_name = excluded.business_name,
             tone_style = excluded.tone_style,
             delivery_time_text = excluded.delivery_time_text,
             greeting_text = excluded.greeting_text,
             salsas_text = excluded.salsas_text,
             promos_text = excluded.promos_text,
             escalation_reasons_off = excluded.escalation_reasons_off,
             enabled = true,
             version = c.version + 1,
             updated_at = excluded.updated_at
             where $12::int is null or c.version = $12::int
           returning property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, version;`,
          [
            organizationId,
            propertyId,
            config.perfil,
            config.agentName,
            config.businessName,
            config.toneStyle,
            config.deliveryTimeText,
            config.greetingText ?? null,
            config.salsasText ?? null,
            config.promosText ?? null,
            [...(config.escalationReasonsOff ?? [])],
            meta.versionEsperada,
          ],
        );
        // Sin fila devuelta: la fila existe con otra version (otro guardado gano) -> conflicto, no 500.
        if (!rows[0]) throw new WhatsAppAgentConfigConflictError();
        const guardada = mapWhatsAppAgentConfigRow(rows[0]);
        try {
          await this.db.query(
            `insert into restaurantes.whatsapp_agent_config_history (organization_id, property_id, version, accion, anterior, nuevo, actor_id)
             values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7);`,
            [
              organizationId,
              propertyId,
              guardada.version,
              meta.accion,
              previa ? JSON.stringify(fotoConfigAgente(previa)) : null,
              JSON.stringify(fotoConfigAgente(guardada)),
              meta.actorUserId,
            ],
          );
        } catch (err) {
          // Dos guardados con la misma version (indice unico del historial) = conflicto de concurrencia.
          if ((err as { code?: string } | null)?.code === "23505") throw new WhatsAppAgentConfigConflictError();
          throw err;
        }
        return guardada;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async (err) => {
        // Base sin la migracion 033: solo se puede guardar lo que ya existia en 029 (sin historial ni version).
        const usaCamposNuevos = Boolean(config.greetingText || config.salsasText || config.promosText || (config.escalationReasonsOff?.length ?? 0) > 0);
        if (usaCamposNuevos) {
          advertirModeloPmNoDisponible("whatsapp_agent_config", err, "033_agente_config_historial_y_callbacks_estado.sql");
          throw new RestaurantesConfigUnavailableError();
        }
        return this.upsertWhatsAppAgentConfig(organizationId, propertyId, config);
      },
    });
  }

  private async leerConfigExactaV2(organizationId: string, propertyId: string | null): Promise<WhatsAppAgentConfigRow | null> {
    const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
      `select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, version
         from restaurantes.whatsapp_agent_config
        where organization_id = $1 and property_id is not distinct from $2::uuid;`,
      [organizationId, propertyId],
    );
    return rows[0] ? mapWhatsAppAgentConfigRow(rows[0]) : null;
  }

  async listWhatsAppAgentConfigHistorial(organizationId: string, propertyId: string | null, limit: number): Promise<readonly WhatsAppAgentConfigHistorialEntry[]> {
    return runWithSavepointFallback<readonly WhatsAppAgentConfigHistorialEntry[]>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_agent_config_historial",
      primary: async () => {
        const { rows } = await this.db.query<{
          version: number; accion: string; property_id: string | null; anterior: Record<string, unknown> | null; nuevo: Record<string, unknown>;
          actor_id: string | null; actor_nombre: string | null; created_at: Date | string;
        }>(
          `select h.version, h.accion, h.property_id, h.anterior, h.nuevo, h.actor_id,
                  (select su.full_name from core.staff_user su where su.id = h.actor_id) as actor_nombre, h.created_at
             from restaurantes.whatsapp_agent_config_history h
            where h.organization_id = $1 and h.property_id is not distinct from $2::uuid
            order by h.version desc
            limit $3;`,
          [organizationId, propertyId, Math.min(Math.max(Math.trunc(limit), 1), 100)],
        );
        return rows.map((r) => ({
          version: r.version,
          accion: r.accion === "restablecido" ? ("restablecido" as const) : ("actualizado" as const),
          propertyId: r.property_id,
          anterior: r.anterior,
          nuevo: r.nuevo,
          actorUserId: r.actor_id,
          actorNombre: r.actor_nombre,
          creadoAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
        }));
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => [],
    });
  }

  async upsertWhatsAppAgentConfig(organizationId: string, propertyId: string | null, config: WhatsAppAgentConfigInput): Promise<WhatsAppAgentConfigRow> {
    return runWithSavepointFallback<WhatsAppAgentConfigRow>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_agent_config_write",
      primary: async () => {
        // Dos indices unicos parciales (organizacion / sucursal): `on conflict` necesita el predicado exacto.
        const conflict = propertyId === null ? "(organization_id) where property_id is null" : "(organization_id, property_id) where property_id is not null";
        const { rows } = await this.db.query<WhatsAppAgentConfigRowSql>(
          `insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, enabled, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, true, now())
           on conflict ${conflict} do update set
             perfil = excluded.perfil,
             agent_name = excluded.agent_name,
             business_name = excluded.business_name,
             tone_style = excluded.tone_style,
             delivery_time_text = excluded.delivery_time_text,
             enabled = true,
             updated_at = excluded.updated_at
           returning property_id, perfil, agent_name, business_name, tone_style, delivery_time_text;`,
          [organizationId, propertyId, config.perfil, config.agentName, config.businessName, config.toneStyle, config.deliveryTimeText],
        );
        return mapWhatsAppAgentConfigRow(rows[0]!);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirModeloPmNoDisponible("whatsapp_agent_config", err, "029_whatsapp_agent_config.sql");
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  async listarConocimiento(organizationId: string): Promise<ConocimientoLectura> {
    return pgListarConocimiento(this.db, organizationId);
  }

  async listarConocimientoPublicado(organizationId: string, propertyId: string | null): Promise<readonly ConocimientoEntrada[]> {
    return pgListarConocimientoPublicado(this.db, organizationId, propertyId);
  }

  async crearConocimiento(organizationId: string, actorId: string, input: NuevaConocimientoEntrada): Promise<ConocimientoEntrada> {
    return pgCrearConocimiento(this.db, organizationId, actorId, input);
  }

  async actualizarConocimiento(organizationId: string, actorId: string, id: string, patch: ConocimientoPatch): Promise<ConocimientoEntrada | null> {
    return pgActualizarConocimiento(this.db, organizationId, actorId, id, patch);
  }

  async borrarConocimiento(organizationId: string, id: string): Promise<boolean> {
    return pgBorrarConocimiento(this.db, organizationId, id);
  }

  async findAgenteWhatsappActivo(propertyId: string): Promise<boolean> {
    return pgAgenteWhatsappActivo(this.db, propertyId);
  }

  async listarAgentesWhatsappApagados(organizationId: string): Promise<{ readonly disponible: boolean; readonly propertyIdsApagados: readonly string[] }> {
    return pgListarAgentesApagados(this.db, organizationId);
  }

  async fijarAgenteWhatsappActivo(organizationId: string, propertyId: string, actorId: string, activo: boolean): Promise<void> {
    return pgFijarAgenteWhatsappActivo(this.db, organizationId, propertyId, actorId, activo);
  }

  async findBranchPolicy(propertyId: string): Promise<BranchPolicy> {
    return runWithSavepointFallback<BranchPolicy>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_policy_read",
      primary: async () => {
        const { rows } = await this.db.query<BranchPolicyRowSql>(
          `select horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica,
                  visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada
             from restaurantes.branch_policy where property_id = $1;`,
          [propertyId],
        );
        return rows[0] ? mapBranchPolicyRow(rows[0]) : EMPTY_BRANCH_POLICY;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      // Base sin la migracion 057: se lee la politica de 023 (horario, minimos, propina) sin perderla.
      fallback: () => this.findBranchPolicyLegacy(propertyId),
    });
  }

  /** Lectura de `branch_policy` con las columnas de la migracion 023 (base sin la 057). */
  private async findBranchPolicyLegacy(propertyId: string): Promise<BranchPolicy> {
    return runWithSavepointFallback<BranchPolicy>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_policy_read_023",
      primary: async () => {
        const { rows } = await this.db.query<BranchPolicyRowSql>(
          `select horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica from restaurantes.branch_policy where property_id = $1;`,
          [propertyId],
        );
        return rows[0] ? mapBranchPolicyRow(rows[0]) : EMPTY_BRANCH_POLICY;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => EMPTY_BRANCH_POLICY,
    });
  }

  // ---- Puentes (migracion 031): horario por fecha ----

  async listBranchHoursExceptions(propertyId: string, fechaDesde: string, fechaHasta: string): Promise<readonly BranchHoursException[]> {
    return runWithSavepointFallback<readonly BranchHoursException[]>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_hours_exception_read",
      primary: async () => {
        const { rows } = await this.db.query<BranchHoursExceptionRow>(
          `select id, property_id, to_char(fecha_desde, 'YYYY-MM-DD') as fecha_desde, to_char(fecha_hasta, 'YYYY-MM-DD') as fecha_hasta, horario, motivo
           from restaurantes.branch_hours_exception
           where property_id = $1 and fecha_desde <= $3::date and fecha_hasta >= $2::date
           order by fecha_desde, created_at;`,
          [propertyId, fechaDesde, fechaHasta],
        );
        return rows.map(mapBranchHoursException);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => [],
    });
  }

  async listUpcomingBranchHoursExceptions(organizationId: string, desdeFecha: string): Promise<readonly BranchHoursException[]> {
    return runWithSavepointFallback<readonly BranchHoursException[]>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_hours_exception_upcoming",
      primary: async () => {
        const { rows } = await this.db.query<BranchHoursExceptionRow>(
          `select id, property_id, to_char(fecha_desde, 'YYYY-MM-DD') as fecha_desde, to_char(fecha_hasta, 'YYYY-MM-DD') as fecha_hasta, horario, motivo
           from restaurantes.branch_hours_exception
           where organization_id = $1 and fecha_hasta >= $2::date
           order by fecha_desde, created_at
           limit 200;`,
          [organizationId, desdeFecha],
        );
        return rows.map(mapBranchHoursException);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => [],
    });
  }

  async createBranchHoursException(organizationId: string, input: NewBranchHoursExceptionInput): Promise<BranchHoursException> {
    return runWithSavepointFallback<BranchHoursException>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_hours_exception_write",
      primary: async () => {
        const { rows } = await this.db.query<BranchHoursExceptionRow>(
          `insert into restaurantes.branch_hours_exception (organization_id, property_id, fecha_desde, fecha_hasta, horario, motivo)
           values ($1, $2, $3::date, $4::date, $5::jsonb, $6)
           returning id, property_id, to_char(fecha_desde, 'YYYY-MM-DD') as fecha_desde, to_char(fecha_hasta, 'YYYY-MM-DD') as fecha_hasta, horario, motivo;`,
          [organizationId, input.propertyId, input.fechaDesde, input.fechaHasta, JSON.stringify(input.horario), input.motivo ?? null],
        );
        return mapBranchHoursException(rows[0]!);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirModeloPmNoDisponible("branch_hours_exception", err, "031_recoger_promociones_automaticas_puentes.sql");
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  async deleteBranchHoursException(organizationId: string, exceptionId: string): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_hours_exception_delete",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(`delete from restaurantes.branch_hours_exception where id = $1 and organization_id = $2 returning id;`, [exceptionId, organizationId]);
        return rows.length > 0;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirModeloPmNoDisponible("branch_hours_exception", err, "031_recoger_promociones_automaticas_puentes.sql");
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  async listOrderPickupInfo(organizationId: string, orderIds: readonly string[]): Promise<readonly OrderPickupInfo[]> {
    if (orderIds.length === 0) return [];
    return runWithSavepointFallback<readonly OrderPickupInfo[]>({
      session: this.db,
      savepointName: "sp_restaurantes_order_pickup_info",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string; canal: CanalPedido | null; propina: string | null; hora_recogida: string | null }>(
          `select id, canal, propina, hora_recogida from restaurantes.orders where organization_id = $1 and id = any($2::uuid[]);`,
          [organizationId, [...orderIds]],
        );
        return rows.map((r) => ({ orderId: r.id, canal: r.canal, propina: r.propina === null ? null : Number(r.propina), horaRecogida: r.hora_recogida }));
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => [],
    });
  }

  // ---- Pedidos programados (migracion 034). Cada operacion lleva SAVEPOINT propio: corre dentro de la
  // transaccion unica del request (o del barrido) y un 42703/42883 contra la base sin migrar la dejaria
  // abortada (25P02). ----

  async supportsScheduledOrders(): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_restaurantes_programados_soporte",
      primary: async () => {
        const { rows } = await this.db.query<{ existe: boolean }>(
          `select exists (
             select 1 from information_schema.columns
             where table_schema = 'restaurantes' and table_name = 'orders' and column_name = 'programado_para'
           ) as existe;`,
        );
        return rows[0]?.existe === true;
      },
      isRecoverable: esErrorBaseSinMigrarProgramados,
      fallback: async () => false,
    });
  }

  async listOrderScheduleInfo(organizationId: string, orderIds: readonly string[]): Promise<readonly OrderScheduleInfo[]> {
    if (orderIds.length === 0) return [];
    return runWithSavepointFallback<readonly OrderScheduleInfo[]>({
      session: this.db,
      savepointName: "sp_restaurantes_order_schedule_info",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string; programado_para: string | Date | null; promovido_at: string | Date | null }>(
          `select id, programado_para, promovido_at from restaurantes.orders
           where organization_id = $1 and id = any($2::uuid[]) and programado_para is not null;`,
          [organizationId, [...orderIds]],
        );
        return rows.map((r) => ({ orderId: r.id, programadoPara: aIsoONull(r.programado_para), promovidoAt: aIsoONull(r.promovido_at) }));
      },
      isRecoverable: esErrorBaseSinMigrarProgramados,
      fallback: async () => [],
    });
  }

  async listScheduledOrders(organizationId: string, filter: { readonly propertyIds: readonly string[] | null; readonly limit: number }): Promise<ScheduledOrdersResult> {
    return runWithSavepointFallback<ScheduledOrdersResult>({
      session: this.db,
      savepointName: "sp_restaurantes_programados_listar",
      primary: async () => {
        const params: unknown[] = [organizationId];
        let scope = "";
        if (filter.propertyIds !== null) {
          params.push([...filter.propertyIds]);
          scope = `and property_id = any($${params.length}::uuid[])`;
        }
        params.push(filter.limit);
        const { rows } = await this.db.query<OrderRow>(
          `select ${ORDER_COLUMNS}, programado_para, promovido_at
           from restaurantes.orders
           where organization_id = $1 and status = 'programado' ${scope}
           order by programado_para asc, id asc
           limit $${params.length};`,
          params,
        );
        return { disponible: true, orders: rows.map(mapOrder) };
      },
      isRecoverable: esErrorBaseSinMigrarProgramados,
      fallback: async () => ({ disponible: false, orders: [] }),
    });
  }

  async promoteDueScheduledOrders(
    organizationId: string | null,
    options: { readonly now: Date; readonly anticipacionMin: number; readonly propertyIds?: readonly string[] | null },
  ): Promise<PromotedScheduledOrdersResult> {
    return runWithSavepointFallback<PromotedScheduledOrdersResult>({
      session: this.db,
      savepointName: "sp_restaurantes_programados_promover",
      primary: async () => {
        const { rows } = await this.db.query<{ promover_pedidos_programados: readonly OrderRow[] }>(
          `select restaurantes.promover_pedidos_programados($1::uuid, $2::timestamptz, $3::int, $4::uuid[]) as promover_pedidos_programados;`,
          [organizationId, options.now.toISOString(), options.anticipacionMin, options.propertyIds ? [...options.propertyIds] : null],
        );
        return { disponible: true, promoted: (rows[0]?.promover_pedidos_programados ?? []).map(mapOrder) };
      },
      isRecoverable: esErrorBaseSinMigrarProgramados,
      fallback: async () => ({ disponible: false, promoted: [] }),
    });
  }

  async listPromotedOrdersWithoutComanda(options: { readonly hours: number; readonly limit: number }): Promise<readonly Order[]> {
    return runWithSavepointFallback<readonly Order[]>({
      session: this.db,
      savepointName: "sp_restaurantes_promovidos_sin_comanda",
      primary: async () => {
        const { rows } = await this.db.query<OrderRow>(`select * from restaurantes.pos_comanda_promovidos_sin_comanda($1::int, $2::int);`, [options.hours, options.limit]);
        return rows.map(mapOrder);
      },
      // Base sin la 046 (funcion 42883) o sin la 024/034 (tabla 42P01, columna 42703): no hay nada que reconciliar.
      isRecoverable: esErrorBaseSinMigrarProgramados,
      fallback: async () => [],
    });
  }

  async upsertBranchPolicy(organizationId: string, propertyId: string, policy: BranchPolicy): Promise<BranchPolicy> {
    return runWithSavepointFallback<BranchPolicy>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_policy_write",
      primary: async () => {
        const { rows } = await this.db.query<BranchPolicyRowSql>(
          `insert into restaurantes.branch_policy (property_id, organization_id, horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica,
                                                   visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada, updated_at)
           values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::smallint[], $10, now())
           on conflict (property_id) do update set
             horario = excluded.horario,
             pedido_minimo_domicilio = excluded.pedido_minimo_domicilio,
             pedido_minimo_recoger = excluded.pedido_minimo_recoger,
             propina_politica = excluded.propina_politica,
             visible_en_directorio = excluded.visible_en_directorio,
             acepta_domicilio = excluded.acepta_domicilio,
             dias_domicilio = excluded.dias_domicilio,
             de_temporada = excluded.de_temporada,
             updated_at = excluded.updated_at
           returning horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica,
                     visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada;`,
          [
            propertyId,
            organizationId,
            policy.horario === null ? null : JSON.stringify(policy.horario),
            policy.pedidoMinimoDomicilio,
            policy.pedidoMinimoRecoger,
            policy.propinaPolitica,
            policy.visibleEnDirectorio ?? null,
            policy.aceptaDomicilio ?? true,
            policy.diasDomicilio ? `{${policy.diasDomicilio.join(",")}}` : null,
            policy.deTemporada ?? false,
          ],
        );
        return mapBranchPolicyRow(rows[0]!);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        // Base sin la 057: solo se puede guardar la politica de 023. Si el cambio trae una restriccion de
        // domicilio o de directorio, NO se descarta en silencio: la configuracion no esta disponible aun.
        if (!politicaSoloCampos023(policy)) {
          advertirModeloPmNoDisponible("branch_policy", err, "057_sucursal_directorio_y_domicilio.sql");
          throw new RestaurantesConfigUnavailableError();
        }
        return this.upsertBranchPolicyLegacy(organizationId, propertyId, policy);
      },
    });
  }

  /** Escritura de `branch_policy` con las columnas de la migracion 023 (base sin la 057). */
  private async upsertBranchPolicyLegacy(organizationId: string, propertyId: string, policy: BranchPolicy): Promise<BranchPolicy> {
    return runWithSavepointFallback<BranchPolicy>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_policy_write_023",
      primary: async () => {
        const { rows } = await this.db.query<BranchPolicyRowSql>(
          `insert into restaurantes.branch_policy (property_id, organization_id, horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica, updated_at)
           values ($1, $2, $3::jsonb, $4, $5, $6, now())
           on conflict (property_id) do update set
             horario = excluded.horario,
             pedido_minimo_domicilio = excluded.pedido_minimo_domicilio,
             pedido_minimo_recoger = excluded.pedido_minimo_recoger,
             propina_politica = excluded.propina_politica,
             updated_at = excluded.updated_at
           returning horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica;`,
          [propertyId, organizationId, policy.horario === null ? null : JSON.stringify(policy.horario), policy.pedidoMinimoDomicilio, policy.pedidoMinimoRecoger, policy.propinaPolitica],
        );
        return mapBranchPolicyRow(rows[0]!);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirModeloPmNoDisponible("branch_policy", err);
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  async listBranchDeliveryZoneIds(propertyId: string): Promise<readonly string[]> {
    return runWithSavepointFallback<readonly string[]>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_delivery_zone_read",
      primary: async () => {
        const { rows } = await this.db.query<{ zone_id: string }>(`select zone_id from restaurantes.branch_delivery_zone where property_id = $1 order by zone_id;`, [propertyId]);
        return rows.map((r) => r.zone_id);
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => [],
    });
  }

  async replaceBranchDeliveryZones(organizationId: string, propertyId: string, zoneIds: readonly string[]): Promise<readonly string[]> {
    const unique = [...new Set(zoneIds)];
    return runWithSavepointFallback<readonly string[]>({
      session: this.db,
      savepointName: "sp_restaurantes_branch_delivery_zone_write",
      primary: async () => {
        await this.db.query(`delete from restaurantes.branch_delivery_zone where property_id = $1 and organization_id = $2;`, [propertyId, organizationId]);
        for (const zoneId of unique) {
          await this.db.query(`insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id) values ($1, $2, $3);`, [propertyId, zoneId, organizationId]);
        }
        return unique;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirModeloPmNoDisponible("branch_delivery_zone", err);
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  async resolveWhatsAppChannel(phoneNumberId: string): Promise<WhatsAppChannelResolution | null> {
    const branch = await runWithSavepointFallback<WhatsAppChannelResolution | null>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_branch_channel_read",
      primary: async () => {
        const { rows } = await this.db.query<{ organization_id: string; property_id: string }>(
          `select organization_id, property_id from restaurantes.whatsapp_branch_channel where phone_number_id = $1;`,
          [phoneNumberId],
        );
        return rows[0] ? { organizationId: rows[0].organization_id, propertyId: rows[0].property_id } : null;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => null,
    });
    if (branch) return branch;
    const organizationId = await this.resolveOrganizationByPhoneNumberId(phoneNumberId);
    return organizationId ? { organizationId, propertyId: null } : null;
  }

  async listWhatsappBranchChannels(organizationId: string): Promise<readonly WhatsappBranchChannel[]> {
    return runWithSavepointFallback<readonly WhatsappBranchChannel[]>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_branch_channel_list",
      primary: async () => {
        const { rows } = await this.db.query<{ property_id: string; phone_number_id: string }>(
          `select property_id, phone_number_id from restaurantes.whatsapp_branch_channel where organization_id = $1 order by created_at, property_id;`,
          [organizationId],
        );
        return rows.map((r) => ({ propertyId: r.property_id, phoneNumberId: r.phone_number_id }));
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => [],
    });
  }

  async upsertWhatsappBranchChannel(organizationId: string, propertyId: string, phoneNumberId: string): Promise<WhatsappBranchChannel> {
    try {
      return await runWithSavepointFallback<WhatsappBranchChannel>({
        session: this.db,
        savepointName: "sp_restaurantes_whatsapp_branch_channel_write",
        primary: async () => {
          const { rows } = await this.db.query<{ property_id: string; phone_number_id: string }>(
            `insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id)
             values ($1, $2, $3)
             on conflict (property_id) do update set phone_number_id = excluded.phone_number_id
             returning property_id, phone_number_id;`,
            [phoneNumberId, organizationId, propertyId],
          );
          return { propertyId: rows[0]!.property_id, phoneNumberId: rows[0]!.phone_number_id };
        },
        isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
        fallback: (err) => {
          advertirModeloPmNoDisponible("whatsapp_branch_channel", err);
          throw new RestaurantesConfigUnavailableError();
        },
      });
    } catch (err) {
      // El SAVEPOINT de runWithSavepointFallback ya dejo la sesion utilizable antes de
      // repropagar; 23505 = el numero ya rutea a otra sucursal u otra organizacion
      // (PRIMARY KEY o guardia de unicidad cruzada de la migracion 023).
      if ((err as { code?: string } | null)?.code === "23505") throw new WhatsappNumberInUseError();
      throw err;
    }
  }

  async deleteWhatsappBranchChannel(organizationId: string, propertyId: string): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_restaurantes_whatsapp_branch_channel_delete",
      primary: async () => {
        const { rows } = await this.db.query<{ property_id: string }>(
          `delete from restaurantes.whatsapp_branch_channel where property_id = $1 and organization_id = $2 returning property_id;`,
          [propertyId, organizationId],
        );
        return rows.length > 0;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirModeloPmNoDisponible("whatsapp_branch_channel", err);
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }

  async listNoDomicilioMarks(organizationId: string): Promise<NoDomicilioMarks> {
    return runWithSavepointFallback<NoDomicilioMarks>({
      session: this.db,
      savepointName: "sp_restaurantes_no_domicilio_marks_read",
      primary: async () => {
        const products = await this.db.query<{ id: string }>(`select id from restaurantes.products where organization_id = $1 and no_domicilio;`, [organizationId]);
        const categories = await this.db.query<{ id: string }>(`select id from restaurantes.categories where organization_id = $1 and no_domicilio;`, [organizationId]);
        return { productIds: products.rows.map((r) => r.id), categoryIds: categories.rows.map((r) => r.id) };
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: async () => ({ productIds: [], categoryIds: [] }),
    });
  }

  async setProductNoDomicilio(organizationId: string, productId: string, noDomicilio: boolean): Promise<boolean> {
    return this.setNoDomicilio("products", organizationId, productId, noDomicilio);
  }

  async setCategoryNoDomicilio(organizationId: string, categoryId: string, noDomicilio: boolean): Promise<boolean> {
    return this.setNoDomicilio("categories", organizationId, categoryId, noDomicilio);
  }

  private async setNoDomicilio(table: "products" | "categories", organizationId: string, id: string, noDomicilio: boolean): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: `sp_restaurantes_${table}_no_domicilio_write`,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(`update restaurantes.${table} set no_domicilio = $3 where id = $1 and organization_id = $2 returning id;`, [id, organizationId, noDomicilio]);
        return rows.length > 0;
      },
      isRecoverable: esErrorCompatibilidadConfigBaseSinMigrar,
      fallback: (err) => {
        advertirModeloPmNoDisponible(`${table}.no_domicilio`, err);
        throw new RestaurantesConfigUnavailableError();
      },
    });
  }
}

interface BranchPolicyRowSql {
  horario: unknown;
  pedido_minimo_domicilio: string | number | null;
  pedido_minimo_recoger: string | number | null;
  propina_politica: string | null;
  // Migracion 057: ausentes cuando se consulto con el SELECT de 023.
  visible_en_directorio?: boolean | null;
  acepta_domicilio?: boolean | null;
  dias_domicilio?: number[] | string | null;
  de_temporada?: boolean | null;
}

/** `smallint[]` llega como arreglo (pg) o como literal "{5,6,0}" segun el driver. */
function leerDiasDomicilio(raw: number[] | string | null | undefined): readonly number[] | null {
  if (raw === null || raw === undefined) return null;
  const lista = Array.isArray(raw) ? raw.map(Number) : raw.replace(/[{}]/g, "").split(",").filter((x) => x.trim() !== "").map(Number);
  const dias = lista.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  // Un dato ilegible o vacio nunca bloquea el domicilio: se trata como "todos los dias".
  return dias.length > 0 ? [...new Set(dias)].sort((a, b) => a - b) : null;
}

/** true cuando la politica no usa ninguna columna de la migracion 057 (se puede guardar en una base sin ella). */
function politicaSoloCampos023(policy: BranchPolicy): boolean {
  return (
    (policy.visibleEnDirectorio ?? null) === null &&
    (policy.aceptaDomicilio ?? true) === true &&
    (policy.diasDomicilio ?? null) === null &&
    (policy.deTemporada ?? false) === false
  );
}

function mapBranchPolicyRow(row: BranchPolicyRowSql): BranchPolicy {
  const propina = row.propina_politica;
  return {
    horario: leerHorarioPersistido(row.horario),
    pedidoMinimoDomicilio: row.pedido_minimo_domicilio === null ? null : Number(row.pedido_minimo_domicilio),
    pedidoMinimoRecoger: row.pedido_minimo_recoger === null ? null : Number(row.pedido_minimo_recoger),
    propinaPolitica: propina === "nunca" || propina === "siempre" || propina === "solo_tarjeta" ? propina : null,
    visibleEnDirectorio: row.visible_en_directorio ?? null,
    aceptaDomicilio: row.acepta_domicilio ?? true,
    diasDomicilio: leerDiasDomicilio(row.dias_domicilio),
    deTemporada: row.de_temporada ?? false,
  };
}

interface WhatsAppAgentConfigRowSql {
  property_id: string | null;
  perfil: string;
  agent_name: string | null;
  business_name: string | null;
  tone_style: string | null;
  delivery_time_text: string | null;
  // Migracion 033: ausentes cuando se consulto con el SELECT de 029.
  greeting_text?: string | null;
  salsas_text?: string | null;
  promos_text?: string | null;
  escalation_reasons_off?: string[] | null;
  version?: number | null;
  // Migracion 039: ausentes cuando se consulto con el SELECT de 033.
  large_order_text?: string | null;
  reply_debounce_seconds?: number | null;
}

function mapWhatsAppAgentConfigRow(row: WhatsAppAgentConfigRowSql): WhatsAppAgentConfigRow {
  return {
    propertyId: row.property_id,
    // Un valor desconocido (fila escrita por una version futura) cae al perfil generico: nunca rompe el turno.
    perfil: row.perfil === "taqueria_pm" ? "taqueria_pm" : "generico",
    agentName: row.agent_name,
    businessName: row.business_name,
    toneStyle: (TONOS_AGENTE_WHATSAPP as readonly string[]).includes(row.tone_style ?? "") ? (row.tone_style as TonoAgenteWhatsApp) : null,
    deliveryTimeText: row.delivery_time_text,
    ...(row.version === undefined || row.version === null
      ? {}
      : {
          greetingText: row.greeting_text ?? null,
          salsasText: row.salsas_text ?? null,
          promosText: row.promos_text ?? null,
          escalationReasonsOff: (row.escalation_reasons_off ?? []).filter((m): m is MotivoEscalacionDesactivable => (MOTIVOS_ESCALACION_DESACTIVABLES as readonly string[]).includes(m)),
          version: row.version,
          largeOrderText: row.large_order_text ?? null,
          replyDebounceSeconds: row.reply_debounce_seconds === undefined || row.reply_debounce_seconds === null ? null : Number(row.reply_debounce_seconds),
        }),
  };
}

const modeloPmAdvertido = new Set<string>();
function advertirModeloPmNoDisponible(objeto: string, err: unknown, migracion = "023_modelo_pm_horarios_minimos_zonas_whatsapp_sucursal.sql"): void {
  if (modeloPmAdvertido.has(objeto)) return;
  modeloPmAdvertido.add(objeto);
  console.warn(
    `PostgresRestaurantesRepository: restaurantes.${objeto} todavía no existe/está habilitado en esta base (SQLSTATE 42501/42883/42P01/42703) -- aplica ` +
      `packages/domain-restaurantes/migrations/${migracion} (o su espejo en supabase/migrations/).`,
    err,
  );
}

interface OrderCursorBoundary {
  readonly createdAt: string;
  readonly id: string;
}

function toIsoText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor: string | undefined): OrderCursorBoundary | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separatorIndex = decoded.lastIndexOf("|");
    if (separatorIndex === -1) return null;
    const createdAt = decoded.slice(0, separatorIndex);
    const id = decoded.slice(separatorIndex + 1);
    // Cursor manipulado o viejo (p. ej. Date.toString()): se ignora en vez de llegar a Postgres como 22007/22P02.
    if (!CURSOR_TIMESTAMP.test(createdAt) || !UUID_TEXT.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
