// Fase 5 — panel de administración visual (ver README de esta fase y el diseño
// Fase 5 citas §0). Estas rutas SOLO exponen/paginan lo que domain-citas ya
// calculaba (mismo criterio que `listActiveServices`/`listActiveProviders` de
// Fase 2 §1.2/§1.3) — ninguna regla de negocio nueva, ningún endpoint de
// escritura nuevo. Las únicas escrituras que el panel ejerce (cancelar una cita,
// conectar Google Calendar) ya existían: `appointments-lifecycle.ts` y
// `google-calendar-oauth.ts`.
//
// Todas las rutas de aquí (salvo `admin/branches`) cuelgan del mismo guard que ya
// usan cancelar/conectar: JWT + `requirePropertyMembership("propertyId")`, SIN
// `allowedRoles` (igual que el resto del panel de citas).
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppointmentRecord, CitasRepository, CustomerRecord, ProviderRecord, ServiceRecord } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
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
    "/v1/citas/properties/:propertyId/services",
    "/v1/citas/properties/:propertyId/services/:serviceId",
    "/v1/citas/properties/:propertyId/appointments",
    "/v1/citas/properties/:propertyId/customers",
    "/v1/citas/properties/:propertyId/customers/:customerId",
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

  app.get("/v1/citas/properties/:propertyId/providers/:providerId", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const [rules, calendarAccount] = await Promise.all([citasRepo.loadAvailabilityRules(providerId), citasRepo.findProviderCalendarAccount(providerId)]);

    return c.json({
      provider: serializeProvider(provider),
      availability_rules: rules.map((r) => ({ id: r.id, day_of_week: r.dayOfWeek, start_time: r.startTime, end_time: r.endTime, is_active: r.isActive })),
      google_calendar: calendarAccount ? { connected: true, sync_status: calendarAccount.syncStatus, sync_error: calendarAccount.syncError } : { connected: false, sync_status: "disconnected" as const, sync_error: null },
    });
  });

  app.get("/v1/citas/properties/:propertyId/services", async (c) => {
    const organizationId = c.get("organizationId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const services = await citasRepo.listActiveServices(organizationId);
    return c.json({ services: services.map(serializeService) });
  });

  app.get("/v1/citas/properties/:propertyId/services/:serviceId", async (c) => {
    const organizationId = c.get("organizationId");
    const serviceId = c.req.param("serviceId");
    const citasRepo = deps.citasRepo(c.get("db"));
    const service = await citasRepo.findService(organizationId, serviceId);
    if (!service) throw Errors.notFound("Servicio no encontrado.");
    return c.json({ service: serializeService(service) });
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

  return app;
}
