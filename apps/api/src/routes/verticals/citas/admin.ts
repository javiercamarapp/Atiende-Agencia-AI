// Fase 5 — panel de administración visual (ver README de esta fase y el diseño
// Fase 5 citas §0). La Fase 5 original solo exponía/paginaba lo que domain-citas
// ya calculaba (ninguna regla de negocio nueva, ningún endpoint de escritura
// nuevo salvo cancelar una cita/conectar Google Calendar, que ya existían en
// appointments-lifecycle.ts/google-calendar-oauth.ts).
//
// Fase 8 — CIERRA ese gap real: el panel no tenía NINGUNA forma de crear/editar un
// proveedor, un servicio, ni la configuración del negocio (`citas.tenant_config`,
// incluido `rubro` — el campo que usa la guardia de crisis, ver vertical-config.ts)
// aunque el repo original SÍ lo permitía (FichaProveedor.tsx/ServiciosSection.tsx/
// ConfiguracionSection.tsx). Ver diseño Fase 8 §1-§3 y
// packages/domain-citas/src/repository.ts (NewProviderInput/ProviderPatch/
// NewServiceInput/ServicePatch/TenantConfigPatch) para el detalle de cada campo.
//
// Todas las rutas de aquí (salvo `admin/branches`) cuelgan del mismo guard que ya
// usan cancelar/conectar: JWT + `requirePropertyMembership("propertyId")`, SIN
// `allowedRoles` (igual que el resto del panel de citas — ver roles.ts: citas
// nunca distinguió quién del staff puede escribir, ni en el origen ni en las
// fases ya construidas de esta vertical).
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ALL_VERTICALS,
  AppointmentConflictError,
  AppointmentForbiddenError,
  AppointmentNotFoundError,
  AppointmentValidationError,
  createAppointmentFromPanel,
  DEFAULT_LISTA_ESPERA_LIMIT,
  MAX_LISTA_ESPERA_LIMIT,
  runListaEsperaCore,
  sortWaitlistByPosition,
  tryEnqueueAppointmentEmail,
  tryTriggerCalendarSync,
  updateCustomerEmailFromPanel,
} from "@atiende/domain-citas";
import type {
  AppointmentRecord,
  AvailabilityOverride,
  AvailabilityRule,
  CitasRepository,
  CustomerRecord,
  NewProviderInput,
  NewServiceInput,
  ProviderPatch,
  ProviderRecord,
  ServicePatch,
  ServiceRecord,
  TenantConfigPatch,
  TenantConfigRecord,
  WaitlistCandidateRow,
} from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const DEFAULT_APPOINTMENTS_LIMIT = 500;
const DEFAULT_CUSTOMERS_LIMIT = 50;
const MAX_CUSTOMERS_LIMIT = 200;

function serializeProvider(provider: ProviderRecord) {
  return { id: provider.id, organization_id: provider.organizationId, property_id: provider.propertyId, display_name: provider.displayName, role_label: provider.roleLabel, is_active: provider.isActive };
}

function serializeService(service: ServiceRecord) {
  return {
    id: service.id,
    organization_id: service.organizationId,
    name: service.name,
    duration_minutes: service.durationMinutes,
    buffer_minutes_before: service.bufferMinutesBefore,
    buffer_minutes_after: service.bufferMinutesAfter,
    price_cents: service.priceCents,
    is_active: service.isActive,
  };
}

function serializeCustomer(customer: CustomerRecord) {
  return { id: customer.id, organization_id: customer.organizationId, full_name: customer.fullName, phone: customer.phone, email: customer.email };
}

function serializeTenantConfig(config: TenantConfigRecord) {
  return { organization_id: config.organizationId, rubro: config.rubro, default_timezone: config.defaultTimezone, owner_notification_phone: config.ownerNotificationPhone };
}

// ---- Gap real de paridad — agente "Lista de espera (simple)": el broadcast
// MANUAL que el staff dispara desde el panel cuando libera un espacio "a mano"
// (ver packages/domain-citas/src/reminders.ts::runListaEsperaCore para la regla
// de negocio completa: FIFO por posición en la lista, tope real de 3
// notificaciones por cliente, encola siempre vía citas.messaging_outbox). ----

/** `position` es 1-based (posición humana en la fila, no índice de arreglo). */
function serializeWaitlistCandidate(row: WaitlistCandidateRow, position: number) {
  return {
    id: row.id,
    position,
    customer_name: row.customerName,
    customer_phone: row.customerPhone,
    provider_id: row.providerId,
    service_id: row.serviceId,
    preferred_date_from: row.preferredDateFrom,
    preferred_date_to: row.preferredDateTo,
    preferred_time_window: row.preferredTimeWindow,
    notified_count: row.notifiedCount,
    created_at: row.createdAt,
  };
}

// ============================================================================
// Fase 8 — validación de los cuerpos de escritura (proveedores/servicios/
// tenant_config). Mismo criterio y mismos helpers (nombre por nombre) que
// apps/api/src/routes/verticals/restaurantes/admin-catalog.ts::requireNonEmptyString/
// optionalNullableString/requirePrice — ambos archivos cierran el mismo tipo de
// gap ("el panel no puede crear/editar su catálogo") y comparten el mismo
// vocabulario de errores 400 para no inventar un estilo nuevo por vertical.
// ============================================================================

function requireNonEmptyString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw Errors.validation(`${field}: se esperaba un texto no vacío de hasta ${maxLength} caracteres.`);
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field, maxLength);
}

function requirePositiveInt(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
    throw Errors.validation(`${field}: se esperaba un entero > 0 y <= ${max}.`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  return requirePositiveInt(value, field, max);
}

function optionalNonNegativeInt(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw Errors.validation(`${field}: se esperaba un entero >= 0 y <= ${max}.`);
  }
  return value;
}

/** `undefined` = campo ausente del patch (no tocar la columna); `null` explícito =
 * sí quitar el precio fijo (servicio "a cotizar", mismo significado que el origen
 * `price` vacío en ServiciosSection.tsx). */
function optionalNullableNonNegativeInt(value: unknown, field: string, max: number): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw Errors.validation(`${field}: se esperaba un entero >= 0 y <= ${max}, o null.`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw Errors.validation(`${field}: se esperaba true/false.`);
  return value;
}

/** `seen` distingue "la llave no vino en el body" (`undefined`, no tocar la
 * columna) de "vino explícitamente `null`" (sí desasignar la sucursal) — mismo
 * criterio que `optionalCategoryId` de restaurantes/admin-catalog.ts. */
function optionalNullablePropertyId(raw: unknown, seen: boolean, field = "property_id"): string | null | undefined {
  if (!seen) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 100) {
    throw Errors.validation(`${field}: se esperaba un id de sucursal o null.`);
  }
  return raw;
}

/** Valida que `propertyId` (si no es null/undefined) sea una sucursal REAL de esta
 * organización — nunca confía a ciegas en un id ajeno solo porque pasó por
 * `optionalNullablePropertyId` (ver diseño Fase 8 §1: "el caller lo valida contra
 * listPropertiesForOrganization"). */
async function assertPropertyBelongsToOrganization(citasRepo: CitasRepository, organizationId: string, propertyId: string | null | undefined): Promise<void> {
  if (propertyId === null || propertyId === undefined) return;
  const branches = await citasRepo.listPropertiesForOrganization(organizationId);
  if (!branches.some((b) => b.propertyId === propertyId)) {
    throw Errors.validation(`property_id: "${propertyId}" no es una sucursal de este negocio.`);
  }
}

/** El resto del motor (`zonedTimeToUtc`/`dayOfWeekInTimeZone`, ver availability.ts)
 * confía ciegamente en que `default_timezone` es un IANA timezone real — un
 * string basura ahí no truena aquí, truena silenciosamente al calcular slots de
 * disponibilidad la próxima vez que alguien agende. Se valida con el mismo
 * `Intl.DateTimeFormat` que ya usa availability.ts, ANTES de escribir la fila. */
function optionalTimeZone(value: unknown, field = "default_timezone"): string | undefined {
  const raw = optionalNonEmptyString(value, field, 100);
  if (raw === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
  } catch {
    throw Errors.validation(`${field}: "${raw}" no es un timezone IANA válido (ej. "America/Mexico_City").`);
  }
  return raw;
}

function requireRubro(value: unknown): string {
  if (typeof value !== "string" || !(ALL_VERTICALS as readonly string[]).includes(value)) {
    throw Errors.validation(`rubro: se esperaba uno de ${ALL_VERTICALS.join(", ")}.`);
  }
  return value;
}

function optionalRubro(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireRubro(value);
}

/** Mismo check constraint real que `citas.tenant_config.owner_notification_phone`
 * (001_citas_schema.sql: `length between 1 and 32`) — se valida aquí ANTES de
 * llegar a Postgres para devolver 400 con un mensaje útil en vez de un 500 de
 * constraint violation. */
function optionalNullablePhone(value: unknown, field = "owner_notification_phone"): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 32) {
    throw Errors.validation(`${field}: se esperaba un texto de 1 a 32 caracteres, o null.`);
  }
  return value;
}

// ============================================================================
// Fase 10 — panel admin: CRUD real de horarios/excepciones (ver diseño Fase 10
// §1/§2 y repository.ts::NewAvailabilityRuleInput/AvailabilityRulePatch/
// AvailabilityOverrideInput). Mismo formato "HH:MM"/"HH:MM:SS" que ya devuelve
// `loadAvailabilityRules` (ver serialización de GET .../providers/:id de arriba) —
// se valida aquí ANTES de Postgres para un 400 claro en vez del 500 genérico de un
// `check` constraint (mismo criterio que `optionalTimeZone`/`optionalNullablePhone`).
// ============================================================================
const TIME_STRING_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const OVERRIDE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireTimeString(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIME_STRING_RE.test(value)) {
    throw Errors.validation(`${field}: se esperaba una hora "HH:MM" o "HH:MM:SS" (ej. "09:00").`);
  }
  return value;
}

function optionalTimeString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireTimeString(value, field);
}

function requireDayOfWeek(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 6) {
    throw Errors.validation("day_of_week: se esperaba un entero de 0 (domingo) a 6 (sábado).");
  }
  return value;
}

function optionalDayOfWeek(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return requireDayOfWeek(value);
}

/** Mismo check constraint real que `citas.availability_rules`/`availability_overrides`
 * (001_citas_schema.sql: `end_time > start_time`) — validado aquí con comparación de
 * texto, válida porque ambos ya pasaron `TIME_STRING_RE` (cero-rellenados). */
function assertEndAfterStart(startTime: string, endTime: string): void {
  if (endTime <= startTime) throw Errors.validation(`end_time ("${endTime}") debe ser posterior a start_time ("${startTime}").`);
}

function requireOverrideDate(raw: string): string {
  if (!OVERRIDE_DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw Errors.validation('El parámetro de fecha debe tener formato "YYYY-MM-DD".');
  }
  return raw;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw Errors.validation(`${field}: se esperaba true/false.`);
  return value;
}

/** `reason` es texto libre (motivo del cierre/excepción) — límite defensivo, sin
 * check constraint real en `citas.availability_overrides.reason` (columna `text`
 * sin límite). `seen` distingue "no vino en el body" de "vino explícitamente
 * null" (sí quita el motivo), mismo criterio que `optionalNullablePropertyId`. */
function optionalNullableReason(value: unknown, seen: boolean): string | null | undefined {
  if (!seen) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500) {
    throw Errors.validation("reason: se esperaba un texto de hasta 500 caracteres, o null.");
  }
  return value;
}

function serializeAvailabilityRule(rule: AvailabilityRule) {
  return { id: rule.id, provider_id: rule.providerId, day_of_week: rule.dayOfWeek, start_time: rule.startTime, end_time: rule.endTime, is_active: rule.isActive };
}

function serializeAvailabilityOverride(override: AvailabilityOverride) {
  return {
    provider_id: override.providerId,
    override_date: override.overrideDate,
    is_closed: override.isClosed,
    start_time: override.startTime,
    end_time: override.endTime,
    reason: override.reason,
  };
}

function serializeAppointment(appointment: AppointmentRecord) {
  return {
    id: appointment.id,
    organization_id: appointment.organizationId,
    property_id: appointment.propertyId,
    provider_id: appointment.providerId,
    service_id: appointment.serviceId,
    customer_id: appointment.customerId,
    starts_at: appointment.startsAt,
    ends_at: appointment.endsAt,
    status: appointment.status,
    source: appointment.source,
    notes: appointment.notes,
    created_at: appointment.createdAt,
    google_sync_status: appointment.googleSyncStatus,
    // Fase 6 §2 (seguimiento) — motivo NORMALIZADO/saneado del último rechazo,
    // solo tiene contenido real cuando google_sync_status es 'invalid' o 'error'
    // (ver calendar-sync.ts::sanitizeProviderSyncReason -- nunca el cuerpo crudo
    // de la respuesta del proveedor).
    google_sync_error: appointment.googleSyncError,
  };
}

/** Enriquece una lista de citas con el nombre real de proveedor/servicio/cliente —
 * la agenda del panel es ilegible con solo ids.
 *
 * Hallazgo de auditoría (rubro 10, "performance y escalabilidad", severidad MEDIA):
 * "Agenda de citas con 1+P+S+C queries por carga" -- la versión anterior YA
 * deduplicaba ids dentro de la respuesta (un `Map` de caché por id), pero seguía
 * ejecutando una llamada al repositorio POR CADA proveedor/servicio/cliente DISTINTO
 * referenciado (P+S+C llamadas, además de la que lista las citas). Ahora resuelve los
 * tres catálogos en 3 llamadas agregadas (`findProvidersByIds`/`findServicesByIds`/
 * `findCustomersByIds`, ver `CitasRepository`), sin importar cuántos ids distintos
 * traiga la página. */
async function enrichAppointments(citasRepo: CitasRepository, organizationId: string, appointments: readonly AppointmentRecord[]) {
  const providerIds = [...new Set(appointments.map((a) => a.providerId))];
  const serviceIds = [...new Set(appointments.map((a) => a.serviceId))];
  const customerIds = [...new Set(appointments.map((a) => a.customerId))];

  const [providers, services, customers] = await Promise.all([
    citasRepo.findProvidersByIds(organizationId, providerIds),
    citasRepo.findServicesByIds(organizationId, serviceIds),
    citasRepo.findCustomersByIds(organizationId, customerIds),
  ]);

  const providerById = new Map<string, ProviderRecord>(providers.map((p) => [p.id, p]));
  const serviceById = new Map<string, ServiceRecord>(services.map((s) => [s.id, s]));
  const customerById = new Map<string, CustomerRecord>(customers.map((c) => [c.id, c]));

  return appointments.map((appointment) => {
    const provider = providerById.get(appointment.providerId) ?? null;
    const service = serviceById.get(appointment.serviceId) ?? null;
    const customer = customerById.get(appointment.customerId) ?? null;
    return {
      ...serializeAppointment(appointment),
      provider_name: provider?.displayName ?? null,
      service_name: service?.name ?? null,
      customer_name: customer?.fullName ?? null,
      customer_phone: customer?.phone ?? null,
    };
  });
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function citasAdminRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // ---- Resolución de sucursales (propertyId) desde el slug de la organización —
  // mismo rol que GET /v1/restaurantes/:orgSlug/admin/branches (admin-kpis.ts): el
  // panel solo conoce el slug tras el login. ----
  app.use("/v1/citas/:orgSlug/admin/branches", authMiddleware(deps.env), dbSession(deps.engine));
  app.get("/v1/citas/:orgSlug/admin/branches", async (c) => {
    const orgSlug = c.req.param("orgSlug");
    const citasRepo = deps.citasRepo(c.get("db"));
    const org = await citasRepo.findOrganizationBySlug(orgSlug);
    if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);

    // Mismo patrón exacto que GET /v1/restaurantes/:orgSlug/admin/branches
    // (admin-kpis.ts): resuelve la org por slug + verifica membership vía
    // `coreRepo.findMembershipsByUserId` — ninguna superficie de seguridad nueva.
    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    const membership = memberships.find((m) => m.organizationId === org.id);
    if (!membership) throw Errors.forbidden("No perteneces a esta organización.");

    const branches = await citasRepo.listPropertiesForOrganization(org.id);
    const visible = membership.propertyIds === null ? branches : branches.filter((b) => membership.propertyIds!.includes(b.propertyId));
    return c.json({ branches: visible.map((b) => ({ propertyId: b.propertyId, name: b.name })) });
  });

  // ---- El resto de las rutas de este archivo comparten el mismo guard que ya usa
  // el panel para cancelar/conectar Google Calendar. ----
  const propertyScopedPaths = [
    "/v1/citas/properties/:propertyId/providers",
    "/v1/citas/properties/:propertyId/providers/:providerId",
    // Fase 8 — el checkbox real de provider_services (ver FichaProveedor.tsx del origen).
    "/v1/citas/properties/:propertyId/providers/:providerId/services/:serviceId",
    // Fase 10 — horarios/excepciones reales de un proveedor (ver diseño Fase 10 §1/§2).
    "/v1/citas/properties/:propertyId/providers/:providerId/availability-rules",
    "/v1/citas/properties/:propertyId/providers/:providerId/availability-rules/:ruleId",
    "/v1/citas/properties/:propertyId/providers/:providerId/availability-overrides",
    "/v1/citas/properties/:propertyId/providers/:providerId/availability-overrides/:overrideDate",
    "/v1/citas/properties/:propertyId/services",
    "/v1/citas/properties/:propertyId/services/:serviceId",
    "/v1/citas/properties/:propertyId/appointments",
    "/v1/citas/properties/:propertyId/customers",
    "/v1/citas/properties/:propertyId/customers/:customerId",
    // Fase 8 — citas.tenant_config (port de ConfiguracionSection.tsx del origen).
    "/v1/citas/properties/:propertyId/tenant-config",
    // Fase 9 — agente "Lista de espera (simple)": ver GET/POST más abajo.
    "/v1/citas/properties/:propertyId/waitlist",
    "/v1/citas/properties/:propertyId/waitlist/broadcast",
  ];
  for (const path of propertyScopedPaths) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  app.get("/v1/citas/properties/:propertyId/providers", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const providers = await citasRepo.listActiveProviders(organizationId);
    return c.json({ providers: providers.map(serializeProvider) });
  });

  interface ProviderBody {
    readonly display_name?: unknown;
    readonly role_label?: unknown;
    readonly property_id?: unknown;
    readonly is_active?: unknown;
  }

  // ---- Fase 8 — alta real de un proveedor (port de
  // ProveedoresSection.tsx::guardar cuando `editando === null`). ----
  app.post("/v1/citas/properties/:propertyId/providers", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const raw = await readJsonCapped<ProviderBody>(c.req.raw, 8 * 1024);

    const displayName = requireNonEmptyString(raw.display_name, "display_name", 160);
    const roleLabel = optionalNonEmptyString(raw.role_label, "role_label", 120);
    const propertyId = optionalNullablePropertyId(raw.property_id, raw.property_id !== undefined);
    const isActive = optionalBoolean(raw.is_active, "is_active");
    await assertPropertyBelongsToOrganization(citasRepo, organizationId, propertyId);

    const input: NewProviderInput = {
      organizationId,
      displayName,
      ...(roleLabel !== undefined ? { roleLabel } : {}),
      ...(propertyId !== undefined ? { propertyId } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    };
    const created = await citasRepo.createProvider(input);
    return c.json({ provider: serializeProvider(created) }, 201);
  });

  app.get("/v1/citas/properties/:propertyId/providers/:providerId", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    // Fase 8 — checkbox real de servicios que este proveedor ofrece (ver
    // FichaProveedor.tsx del origen). Acotado a servicios ACTIVOS de la
    // organización — asignar un servicio ya desactivado desde el panel es un caso
    // de borde fuera del alcance real de esta fase (el origen sí lo permitía vía
    // un `select *`, pero domain-citas no expone "listar TODOS los servicios,
    // activos o no" todavía; agregar ese método es una decisión de producto
    // separada de "cerrar el gap de que no se puede ni asignar un servicio").
    // Fase 6 §2 (seguimiento) — igual que `calendarAccount` (Google): la ficha del
    // proveedor trae el estado de las TRES plataformas en la misma respuesta (la
    // sección "Calendarios conectados" del panel las pinta juntas, un solo round
    // trip) — el secreto (api_key/contraseña de aplicación) nunca viaja aquí, solo
    // `sync_status`/`sync_error`/metadata pública de la conexión.
    const [rules, calendarAccount, calcomAccount, caldavAccount, services, syncIssues] = await Promise.all([
      citasRepo.loadAvailabilityRules(providerId),
      citasRepo.findProviderCalendarAccount(providerId),
      citasRepo.findProviderCalComAccount(providerId),
      citasRepo.findProviderCalDavAccount(providerId),
      citasRepo.listActiveServices(organizationId),
      // Fase 6 §2 (seguimiento) — UN solo resumen por proveedor (nunca por
      // plataforma, ver CalendarSyncIssuesSummary): "Calendarios conectados"
      // pinta la advertencia ámbar junto a lo que sea que esté conectado.
      citasRepo.loadProviderCalendarSyncIssues(providerId),
    ]);
    const offeredServiceIds = (
      await Promise.all(services.map(async (service) => ((await citasRepo.providerOffersService(providerId, service.id)) ? service.id : null)))
    ).filter((id): id is string => id !== null);

    return c.json({
      provider: serializeProvider(provider),
      availability_rules: rules.map((r) => ({ id: r.id, day_of_week: r.dayOfWeek, start_time: r.startTime, end_time: r.endTime, is_active: r.isActive })),
      google_calendar: calendarAccount ? { connected: true, sync_status: calendarAccount.syncStatus, sync_error: calendarAccount.syncError } : { connected: false, sync_status: "disconnected" as const, sync_error: null },
      calcom: calcomAccount
        ? { connected: calcomAccount.syncStatus !== "disconnected", sync_status: calcomAccount.syncStatus, sync_error: calcomAccount.syncError, calcom_event_type_id: calcomAccount.calcomEventTypeId, calcom_base_url: calcomAccount.baseUrl }
        : { connected: false, sync_status: "disconnected" as const, sync_error: null, calcom_event_type_id: null, calcom_base_url: null },
      caldav: caldavAccount
        ? { connected: caldavAccount.syncStatus !== "disconnected", sync_status: caldavAccount.syncStatus, sync_error: caldavAccount.syncError, calendar_collection_url: caldavAccount.calendarCollectionUrl, username: caldavAccount.username }
        : { connected: false, sync_status: "disconnected" as const, sync_error: null, calendar_collection_url: null, username: null },
      calendar_sync_issues: { count: syncIssues.count, last_reason: syncIssues.lastReason },
      offered_service_ids: offeredServiceIds,
    });
  });

  // ---- Fase 8 — edición real de un proveedor (port de
  // ProveedoresSection.tsx::guardar cuando `editando !== null`). ----
  app.patch("/v1/citas/properties/:propertyId/providers/:providerId", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const raw = await readJsonCapped<ProviderBody>(c.req.raw, 8 * 1024);

    const propertyIdSeen = raw.property_id !== undefined;
    const propertyId = optionalNullablePropertyId(raw.property_id, propertyIdSeen);
    if (propertyIdSeen) await assertPropertyBelongsToOrganization(citasRepo, organizationId, propertyId);

    const patch: ProviderPatch = {
      displayName: optionalNonEmptyString(raw.display_name, "display_name", 160),
      roleLabel: optionalNonEmptyString(raw.role_label, "role_label", 120),
      ...(propertyIdSeen ? { propertyId } : {}),
      isActive: optionalBoolean(raw.is_active, "is_active"),
    };
    const updated = await citasRepo.updateProvider(organizationId, providerId, patch);
    if (!updated) throw Errors.notFound("Proveedor no encontrado.");
    return c.json({ provider: serializeProvider(updated) });
  });

  interface ProviderServiceBody {
    readonly offered?: unknown;
  }

  // ---- Fase 8 — checkbox real de FichaProveedor.tsx::toggleServicio: marca/quita
  // que este proveedor ofrezca `serviceId`. `offered` por default `true` (mismo
  // criterio que "PUT = asignar" si el body viene vacío). ----
  app.put("/v1/citas/properties/:propertyId/providers/:providerId/services/:serviceId", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const serviceId = c.req.param("serviceId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");
    const service = await citasRepo.findService(organizationId, serviceId);
    if (!service) throw Errors.notFound("Servicio no encontrado.");

    const raw = await readJsonCapped<ProviderServiceBody>(c.req.raw, 1024);
    const offered = optionalBoolean(raw.offered, "offered") ?? true;

    await citasRepo.setProviderServiceOffering(providerId, serviceId, offered);
    return c.json({ provider_id: providerId, service_id: serviceId, offered });
  });

  interface AvailabilityRuleBody {
    readonly day_of_week?: unknown;
    readonly start_time?: unknown;
    readonly end_time?: unknown;
    readonly is_active?: unknown;
  }

  // ---- Fase 10 — alta real de una regla de disponibilidad recurrente (cierra el
  // gap real: sin esto, un negocio nuevo no podía recibir ni una cita porque
  // `availability.ts` nunca encontraba reglas, ver diseño Fase 10 §1). ----
  app.post("/v1/citas/properties/:propertyId/providers/:providerId/availability-rules", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const raw = await readJsonCapped<AvailabilityRuleBody>(c.req.raw, 2 * 1024);
    const dayOfWeek = requireDayOfWeek(raw.day_of_week);
    const startTime = requireTimeString(raw.start_time, "start_time");
    const endTime = requireTimeString(raw.end_time, "end_time");
    assertEndAfterStart(startTime, endTime);
    const isActive = optionalBoolean(raw.is_active, "is_active");

    const created = await citasRepo.createAvailabilityRule({ providerId, dayOfWeek, startTime, endTime, ...(isActive !== undefined ? { isActive } : {}) });
    return c.json({ availability_rule: serializeAvailabilityRule(created) }, 201);
  });

  // ---- Fase 10 — edición real de una regla existente (port de la sección de
  // horarios que Disponibilidad.tsx no exponía, ver diseño Fase 10 §1). Un campo
  // ausente del patch deja la columna intacta, mismo criterio que
  // `ProviderPatch`/`ServicePatch`. ----
  app.patch("/v1/citas/properties/:propertyId/providers/:providerId/availability-rules/:ruleId", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const ruleId = c.req.param("ruleId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const existingRules = await citasRepo.loadAvailabilityRules(providerId);
    const existing = existingRules.find((r) => r.id === ruleId);
    if (!existing) throw Errors.notFound("Regla de disponibilidad no encontrada.");

    const raw = await readJsonCapped<AvailabilityRuleBody>(c.req.raw, 2 * 1024);
    const dayOfWeek = optionalDayOfWeek(raw.day_of_week);
    const startTime = optionalTimeString(raw.start_time, "start_time");
    const endTime = optionalTimeString(raw.end_time, "end_time");
    const isActive = optionalBoolean(raw.is_active, "is_active");
    // Se valida la combinación FINAL (patch mezclado sobre la fila existente) —
    // mismo criterio que el `check (end_time > start_time)` real de
    // 001_citas_schema.sql, para un 400 claro en vez de un 500 de constraint.
    assertEndAfterStart(startTime ?? existing.startTime, endTime ?? existing.endTime);

    const updated = await citasRepo.updateAvailabilityRule(providerId, ruleId, {
      ...(dayOfWeek !== undefined ? { dayOfWeek } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    });
    if (!updated) throw Errors.notFound("Regla de disponibilidad no encontrada.");
    return c.json({ availability_rule: serializeAvailabilityRule(updated) });
  });

  // ---- Fase 10 — borrado real de una regla (deja de ofrecer ese horario). ----
  app.delete("/v1/citas/properties/:propertyId/providers/:providerId/availability-rules/:ruleId", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const ruleId = c.req.param("ruleId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const deleted = await citasRepo.deleteAvailabilityRule(providerId, ruleId);
    if (!deleted) throw Errors.notFound("Regla de disponibilidad no encontrada.");
    return c.json({ deleted: true });
  });

  // ---- Fase 10 — excepciones puntuales (cierre o horario especial de un día
  // concreto, ver AvailabilityOverrideInput). Lista solo las de hoy en adelante —
  // el panel edita el futuro, nunca reescribe un cierre ya pasado. ----
  app.get("/v1/citas/properties/:propertyId/providers/:providerId/availability-overrides", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const todayIso = new Date().toISOString().slice(0, 10);
    const overrides = await citasRepo.listAvailabilityOverrides(providerId, todayIso);
    return c.json({ availability_overrides: overrides.map(serializeAvailabilityOverride) });
  });

  interface AvailabilityOverrideBody {
    readonly is_closed?: unknown;
    readonly start_time?: unknown;
    readonly end_time?: unknown;
    readonly reason?: unknown;
  }

  // ---- Fase 10 — alta/edición real de una excepción (upsert real sobre la unique
  // (provider_id, override_date), ver AvailabilityOverrideInput). `is_closed: true`
  // ignora start_time/end_time si vinieran (se guardan null, mismo criterio que el
  // check constraint real de la tabla). ----
  app.put("/v1/citas/properties/:propertyId/providers/:providerId/availability-overrides/:overrideDate", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const overrideDate = requireOverrideDate(c.req.param("overrideDate"));
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const raw = await readJsonCapped<AvailabilityOverrideBody>(c.req.raw, 2 * 1024);
    const isClosed = requireBoolean(raw.is_closed, "is_closed");
    const startTime = isClosed ? null : requireTimeString(raw.start_time, "start_time");
    const endTime = isClosed ? null : requireTimeString(raw.end_time, "end_time");
    if (!isClosed) assertEndAfterStart(startTime!, endTime!);
    const reason = optionalNullableReason(raw.reason, raw.reason !== undefined);

    const upserted = await citasRepo.upsertAvailabilityOverride({
      providerId,
      overrideDate,
      isClosed,
      startTime,
      endTime,
      ...(reason !== undefined ? { reason } : {}),
    });
    return c.json({ availability_override: serializeAvailabilityOverride(upserted) });
  });

  // ---- Fase 10 — borrado real de una excepción (vuelve a regir el horario
  // recurrente normal para esa fecha). ----
  app.delete("/v1/citas/properties/:propertyId/providers/:providerId/availability-overrides/:overrideDate", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const overrideDate = requireOverrideDate(c.req.param("overrideDate"));
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const deleted = await citasRepo.deleteAvailabilityOverride(providerId, overrideDate);
    if (!deleted) throw Errors.notFound("Excepción de disponibilidad no encontrada.");
    return c.json({ deleted: true });
  });

  app.get("/v1/citas/properties/:propertyId/services", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const services = await citasRepo.listActiveServices(organizationId);
    return c.json({ services: services.map(serializeService) });
  });

  interface ServiceBody {
    readonly name?: unknown;
    readonly duration_minutes?: unknown;
    readonly buffer_minutes_before?: unknown;
    readonly buffer_minutes_after?: unknown;
    readonly price_cents?: unknown;
    readonly is_active?: unknown;
  }

  const MAX_DURATION_MINUTES = 24 * 60;
  const MAX_BUFFER_MINUTES = 8 * 60;
  const MAX_PRICE_CENTS = 100_000_000; // $1,000,000.00 MXN — techo defensivo, no un límite de negocio real

  // ---- Fase 8 — alta real de un servicio (port de
  // ServiciosSection.tsx::guardar cuando `editando === null`). ----
  app.post("/v1/citas/properties/:propertyId/services", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const raw = await readJsonCapped<ServiceBody>(c.req.raw, 8 * 1024);

    const name = requireNonEmptyString(raw.name, "name", 160);
    const durationMinutes = requirePositiveInt(raw.duration_minutes, "duration_minutes", MAX_DURATION_MINUTES);
    const bufferMinutesBefore = optionalNonNegativeInt(raw.buffer_minutes_before, "buffer_minutes_before", MAX_BUFFER_MINUTES);
    const bufferMinutesAfter = optionalNonNegativeInt(raw.buffer_minutes_after, "buffer_minutes_after", MAX_BUFFER_MINUTES);
    const priceCents = optionalNullableNonNegativeInt(raw.price_cents, "price_cents", MAX_PRICE_CENTS);
    const isActive = optionalBoolean(raw.is_active, "is_active");

    const input: NewServiceInput = {
      organizationId,
      name,
      durationMinutes,
      ...(bufferMinutesBefore !== undefined ? { bufferMinutesBefore } : {}),
      ...(bufferMinutesAfter !== undefined ? { bufferMinutesAfter } : {}),
      ...(priceCents !== undefined ? { priceCents } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    };
    const created = await citasRepo.createService(input);
    return c.json({ service: serializeService(created) }, 201);
  });

  app.get("/v1/citas/properties/:propertyId/services/:serviceId", async (c) => {
    const organizationId = c.get("organizationId");
    const serviceId = c.req.param("serviceId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const service = await citasRepo.findService(organizationId, serviceId);
    if (!service) throw Errors.notFound("Servicio no encontrado.");
    return c.json({ service: serializeService(service) });
  });

  // ---- Fase 8 — edición real de un servicio (port de
  // ServiciosSection.tsx::guardar cuando `editando !== null`). ----
  app.patch("/v1/citas/properties/:propertyId/services/:serviceId", async (c) => {
    const organizationId = c.get("organizationId");
    const serviceId = c.req.param("serviceId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const raw = await readJsonCapped<ServiceBody>(c.req.raw, 8 * 1024);

    const patch: ServicePatch = {
      name: optionalNonEmptyString(raw.name, "name", 160),
      durationMinutes: optionalPositiveInt(raw.duration_minutes, "duration_minutes", MAX_DURATION_MINUTES),
      bufferMinutesBefore: optionalNonNegativeInt(raw.buffer_minutes_before, "buffer_minutes_before", MAX_BUFFER_MINUTES),
      bufferMinutesAfter: optionalNonNegativeInt(raw.buffer_minutes_after, "buffer_minutes_after", MAX_BUFFER_MINUTES),
      priceCents: optionalNullableNonNegativeInt(raw.price_cents, "price_cents", MAX_PRICE_CENTS),
      isActive: optionalBoolean(raw.is_active, "is_active"),
    };
    const updated = await citasRepo.updateService(organizationId, serviceId, patch);
    if (!updated) throw Errors.notFound("Servicio no encontrado.");
    return c.json({ service: serializeService(updated) });
  });

  interface TenantConfigBody {
    readonly rubro?: unknown;
    readonly default_timezone?: unknown;
    readonly owner_notification_phone?: unknown;
  }

  // ---- Fase 8 — lee `citas.tenant_config` (port de ConfiguracionSection.tsx del
  // origen). Nunca 404: una organización sin fila todavía (ver diseño Fase 8 §3)
  // se ve como sus defaults reales — los MISMOS defaults de columna que
  // 001_citas_schema.sql, no inventados aquí. ----
  app.get("/v1/citas/properties/:propertyId/tenant-config", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const config = await citasRepo.findTenantConfig(organizationId);
    return c.json({ tenant_config: config ? serializeTenantConfig(config) : { organization_id: organizationId, rubro: "otro", default_timezone: "America/Mexico_City", owner_notification_phone: null } });
  });

  // ---- Fase 8 — edita `citas.tenant_config` (port de
  // ConfiguracionSection.tsx::guardar del origen, acotado a rubro/timezone/teléfono
  // de aviso — ver TenantConfigPatch para por qué `name`/`slug`/`is_active` del
  // negocio NO se editan aquí). Upsert real vía `upsertTenantConfig`: nunca 404. ----
  app.patch("/v1/citas/properties/:propertyId/tenant-config", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const raw = await readJsonCapped<TenantConfigBody>(c.req.raw, 4 * 1024);

    const patch: TenantConfigPatch = {
      rubro: optionalRubro(raw.rubro),
      defaultTimezone: optionalTimeZone(raw.default_timezone),
      ownerNotificationPhone: optionalNullablePhone(raw.owner_notification_phone),
    };
    const updated = await citasRepo.upsertTenantConfig(organizationId, patch);
    return c.json({ tenant_config: serializeTenantConfig(updated) });
  });

  interface CreateAppointmentBody {
    readonly provider_id?: unknown;
    readonly service_id?: unknown;
    readonly customer_name?: unknown;
    readonly customer_phone?: unknown;
    readonly customer_email?: unknown;
    readonly starts_at?: unknown;
    readonly notes?: unknown;
  }

  // ---- Fase 12 — hallazgo de auditoría (ALTO, "Staff no puede crear citas
  // manualmente desde la Agenda"): alta real de una cita a mano desde el panel —
  // a diferencia de POST /v1/citas/:orgSlug/appointments (appointments.ts, agente/
  // web, exige que el horario caiga dentro de la disponibilidad declarada), esta
  // ruta deliberadamente NO lo exige (ver el comentario de cabecera de
  // createAppointmentFromPanel en domain-citas/src/appointments.ts) — el único
  // invariante real que nunca se salta es el EXCLUDE using gist (dos citas del
  // mismo proveedor no pueden traslaparse). Mismo guard que el resto de este
  // archivo (requirePropertyMembership, sin distinción de rol — roles.ts). ----
  app.post("/v1/citas/properties/:propertyId/appointments", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const raw = await readJsonCapped<CreateAppointmentBody>(c.req.raw, 4 * 1024);

    const providerId = requireNonEmptyString(raw.provider_id, "provider_id", 100);
    const serviceId = requireNonEmptyString(raw.service_id, "service_id", 100);
    const customerName = requireNonEmptyString(raw.customer_name, "customer_name", 160);
    const customerPhone = requireNonEmptyString(raw.customer_phone, "customer_phone", 32);
    const customerEmail = optionalNonEmptyString(raw.customer_email, "customer_email", 200);
    const startsAt = requireNonEmptyString(raw.starts_at, "starts_at", 40);
    if (Number.isNaN(Date.parse(startsAt))) throw Errors.validation('starts_at: se esperaba una fecha ISO 8601 válida.');
    const notes = optionalNonEmptyString(raw.notes, "notes", 2000);

    try {
      const appointment = await createAppointmentFromPanel(citasRepo, {
        organizationId,
        providerId,
        serviceId,
        customerName,
        customerPhone,
        ...(customerEmail !== undefined ? { customerEmail } : {}),
        startsAt,
        ...(notes !== undefined ? { notes } : {}),
      });
      // Mismo best-effort que el resto de este vertical (nunca convierte la
      // respuesta 201 en un error, ver appointments.ts/appointments-lifecycle.ts).
      await tryEnqueueAppointmentEmail(citasRepo, organizationId, "appointment.created", appointment.id);
      await tryTriggerCalendarSync(citasRepo, deps.citasCalendarSyncPortResolver, appointment.id);
      return c.json({ appointment: serializeAppointment(appointment) }, 201);
    } catch (err) {
      if (err instanceof AppointmentForbiddenError) throw Errors.forbidden(err.message);
      if (err instanceof AppointmentConflictError) throw Errors.conflict(err.message);
      if (err instanceof AppointmentValidationError) throw Errors.validation(err.message);
      throw err;
    }
  });

  // ---- Agenda (vista mes/semana) — GET .../appointments?from=<ISO>&to=<ISO>&provider_id=<uuid> ----
  app.get("/v1/citas/properties/:propertyId/appointments", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      throw Errors.validation('Se requieren "from" y "to" como fechas ISO 8601 válidas.');
    }
    const providerId = c.req.query("provider_id") || undefined;
    const limit = parsePositiveInt(c.req.query("limit"), DEFAULT_APPOINTMENTS_LIMIT, DEFAULT_APPOINTMENTS_LIMIT);

    const appointments = await citasRepo.listAppointmentsInRange(organizationId, from, to, providerId, limit);
    const enriched = await enrichAppointments(citasRepo, organizationId, appointments);
    return c.json({ appointments: enriched });
  });

  // ---- Clientes — lista paginada + ficha con sus citas próximas ----
  app.get("/v1/citas/properties/:propertyId/customers", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const limit = parsePositiveInt(c.req.query("limit"), DEFAULT_CUSTOMERS_LIMIT, MAX_CUSTOMERS_LIMIT);
    const rawOffset = Number.parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    const search = c.req.query("search") || undefined;

    const page = await citasRepo.listCustomers(organizationId, { limit, offset, search });
    return c.json({ customers: page.items.map(serializeCustomer), total: page.total, next_offset: page.nextOffset });
  });

  app.get("/v1/citas/properties/:propertyId/customers/:customerId", async (c) => {
    const organizationId = c.get("organizationId");
    const customerId = c.req.param("customerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const customer = await citasRepo.findCustomerById(organizationId, customerId);
    if (!customer) throw Errors.notFound("Cliente no encontrado.");

    const upcoming = await citasRepo.listActiveAppointmentsForCustomer(organizationId, customerId, new Date().toISOString());
    const enriched = await enrichAppointments(citasRepo, organizationId, upcoming);
    return c.json({ customer: serializeCustomer(customer), upcoming_appointments: enriched });
  });

  interface UpdateCustomerBody {
    readonly email?: unknown;
  }

  // ---- Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — captura/edición
  // del correo OPCIONAL de un cliente YA existente (ver domain-citas/src/
  // customers.ts::updateCustomerEmailFromPanel para el porqué: `citas.customers.
  // email` existe desde Fase 1 pero nunca era editable después de la primera
  // reserva -- el único lugar del panel donde el staff puede agregarle un correo
  // a un cliente cuyas citas Cal.com rechaza por falta de `attendeeEmail`, sin
  // tener que recrear la cita). `email: null` (o ausente del body -- ambos se
  // tratan como "quitar el correo") NUNCA es un error: nunca es obligatorio. ----
  app.patch("/v1/citas/properties/:propertyId/customers/:customerId", async (c) => {
    const organizationId = c.get("organizationId");
    const customerId = c.req.param("customerId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const raw = await readJsonCapped<UpdateCustomerBody>(c.req.raw, 1024);

    if (raw.email !== undefined && raw.email !== null && typeof raw.email !== "string") {
      throw Errors.validation("email: se esperaba un texto o null.");
    }
    const email = typeof raw.email === "string" ? raw.email : null;

    try {
      const updated = await updateCustomerEmailFromPanel(citasRepo, organizationId, customerId, email);
      return c.json({ customer: serializeCustomer(updated) });
    } catch (err) {
      if (err instanceof AppointmentNotFoundError) throw Errors.notFound(err.message);
      if (err instanceof AppointmentValidationError) throw Errors.validation(err.message);
      throw err;
    }
  });

  // ---- Fase 9 — GET solo-lectura de la lista de espera viva, en el MISMO orden
  // FIFO que `runListaEsperaCore` notifica de verdad (ver sortWaitlistByPosition)
  // — para que el staff vea a quién le toca antes de decidir si dispara el
  // broadcast. Filtros opcionales por proveedor/servicio, mismo criterio que el
  // broadcast (provider_id/service_id null en la fila = "sin preferencia", nunca
  // se excluye por eso). ----
  app.get("/v1/citas/properties/:propertyId/waitlist", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const providerId = c.req.query("provider_id") || undefined;
    const serviceId = c.req.query("service_id") || undefined;

    const candidates = await citasRepo.loadLiveWaitlistCandidates(organizationId);
    const filtered = sortWaitlistByPosition(
      candidates
        .filter((row) => !providerId || row.providerId === null || row.providerId === providerId)
        .filter((row) => !serviceId || row.serviceId === null || row.serviceId === serviceId),
    );
    return c.json({ waitlist: filtered.map((row, i) => serializeWaitlistCandidate(row, i + 1)) });
  });

  interface WaitlistBroadcastBody {
    readonly provider_id?: unknown;
    readonly service_id?: unknown;
    readonly limit?: unknown;
  }

  // ---- Fase 9 — CIERRA el gap real: hasta ahora `citas.appointment_waitlist`
  // solo se leía/matcheaba AUTOMÁTICAMENTE al cancelar/reagendar
  // (runOptimizadorCore, match fino, UN solo ganador) — no había ningún
  // mecanismo de broadcast MANUAL disparado por el staff (ver
  // packages/domain-citas/src/reminders.ts::runListaEsperaCore para la regla de
  // negocio real: FIFO por posición en la lista, tope real de
  // MAX_WAITLIST_NOTIFICATIONS por cliente, encola siempre vía
  // citas.messaging_outbox — nunca habla directo con la API de WhatsApp). El
  // staff decide "notificar a la lista de espera de este horario/servicio que
  // se acaba de liberar" (ej. amplió su propio horario ese día, un caso que
  // nunca pasa por cancelar-cita/reagendar-cita) y esta ruta encola los
  // mensajes reales. ----
  app.post("/v1/citas/properties/:propertyId/waitlist/broadcast", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const raw = await readJsonCapped<WaitlistBroadcastBody>(c.req.raw, 1024);

    const providerId = optionalNonEmptyString(raw.provider_id, "provider_id", 100);
    const serviceId = optionalNonEmptyString(raw.service_id, "service_id", 100);
    // Límite razonable de destinatarios por corrida — validado aquí (400 claro
    // para el staff si pide de más) Y recortado de nuevo dentro de
    // runListaEsperaCore (defensa en profundidad para cualquier otro caller
    // futuro que no pase por esta ruta).
    const limit = optionalPositiveInt(raw.limit, "limit", MAX_LISTA_ESPERA_LIMIT) ?? DEFAULT_LISTA_ESPERA_LIMIT;

    if (providerId !== undefined) {
      const provider = await citasRepo.findProvider(organizationId, providerId);
      if (!provider) throw Errors.validation(`provider_id: "${providerId}" no es un proveedor de este negocio.`);
    }
    if (serviceId !== undefined) {
      const service = await citasRepo.findService(organizationId, serviceId);
      if (!service) throw Errors.validation(`service_id: "${serviceId}" no es un servicio de este negocio.`);
    }

    const summary = await runListaEsperaCore(citasRepo, organizationId, { providerId, serviceId }, limit);
    return c.json({
      notified: summary.notified,
      candidates_considered: summary.candidatesConsidered,
      skipped_no_whatsapp_config: summary.skippedNoWhatsappConfig,
    });
  });

  return app;
}
