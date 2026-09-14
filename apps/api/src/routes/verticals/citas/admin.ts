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
import { ALL_VERTICALS, DEFAULT_LISTA_ESPERA_LIMIT, MAX_LISTA_ESPERA_LIMIT, runListaEsperaCore, sortWaitlistByPosition } from "@atiende/domain-citas";
import type {
  AppointmentRecord,
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
  };
}

/** Enriquece una lista de citas con el nombre real de proveedor/servicio/cliente —
 * la agenda del panel es ilegible con solo ids. Deduplica lookups por id dentro de
 * la misma respuesta (una organización real tiene pocas decenas de proveedores/
 * servicios, nunca uno por cita) — sigue sin ser una regla de negocio nueva, solo
 * composición de lecturas que ya existían (`findProvider`/`findService`/
 * `findCustomerById`). */
async function enrichAppointments(citasRepo: CitasRepository, organizationId: string, appointments: readonly AppointmentRecord[]) {
  const providerCache = new Map<string, ProviderRecord | null>();
  const serviceCache = new Map<string, ServiceRecord | null>();
  const customerCache = new Map<string, CustomerRecord | null>();

  async function cachedProvider(id: string) {
    if (!providerCache.has(id)) providerCache.set(id, await citasRepo.findProvider(organizationId, id));
    return providerCache.get(id) ?? null;
  }
  async function cachedService(id: string) {
    if (!serviceCache.has(id)) serviceCache.set(id, await citasRepo.findService(organizationId, id));
    return serviceCache.get(id) ?? null;
  }
  async function cachedCustomer(id: string) {
    if (!customerCache.has(id)) customerCache.set(id, await citasRepo.findCustomerById(organizationId, id));
    return customerCache.get(id) ?? null;
  }

  return Promise.all(
    appointments.map(async (appointment) => {
      const [provider, service, customer] = await Promise.all([cachedProvider(appointment.providerId), cachedService(appointment.serviceId), cachedCustomer(appointment.customerId)]);
      return {
        ...serializeAppointment(appointment),
        provider_name: provider?.displayName ?? null,
        service_name: service?.name ?? null,
        customer_name: customer?.fullName ?? null,
        customer_phone: customer?.phone ?? null,
      };
    }),
  );
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
    const [rules, calendarAccount, services] = await Promise.all([
      citasRepo.loadAvailabilityRules(providerId),
      citasRepo.findProviderCalendarAccount(providerId),
      citasRepo.listActiveServices(organizationId),
    ]);
    const offeredServiceIds = (
      await Promise.all(services.map(async (service) => ((await citasRepo.providerOffersService(providerId, service.id)) ? service.id : null)))
    ).filter((id): id is string => id !== null);

    return c.json({
      provider: serializeProvider(provider),
      availability_rules: rules.map((r) => ({ id: r.id, day_of_week: r.dayOfWeek, start_time: r.startTime, end_time: r.endTime, is_active: r.isActive })),
      google_calendar: calendarAccount ? { connected: true, sync_status: calendarAccount.syncStatus, sync_error: calendarAccount.syncError } : { connected: false, sync_status: "disconnected" as const, sync_error: null },
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
