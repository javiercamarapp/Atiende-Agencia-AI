// Fase 5 — test de integración end-to-end real de las rutas de lectura del panel
// de administración visual (agenda/proveedores/servicios/clientes) sobre la app
// Hono real, con InMemoryCitasRepository. Mismo estilo que citas-appointments.spec.ts.
// Fase 8 agrega las rutas de ESCRITURA real (crear/editar proveedores/servicios,
// checkbox de provider_services, tenant-config) — ver admin.ts para el detalle.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppointment } from "@atiende/domain-citas";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";

const MONDAY_10AM_MERIDA = "2026-09-14T16:00:00.000Z"; // 10:00 hora de Mérida (UTC-6)
const RANGE_FROM = "2026-09-14T00:00:00.000Z";
const RANGE_TO = "2026-09-15T00:00:00.000Z";

describe("GET /v1/citas/:orgSlug/admin/branches", () => {
  it("un staff con membership real ve las properties de su organización", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/admin/branches", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branches: readonly { propertyId: string; name: string }[] };
    expect(body.branches).toEqual([{ propertyId: ctx.propertyId, name: "Sucursal principal" }]);
  });

  it("rechaza sin JWT (401)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/admin/branches");
    expect(res.status).toBe(401);
  });

  it("responde 404 para un slug que no existe", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/citas/no-existe/admin/branches", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/citas/properties/:propertyId/providers(/:providerId)", () => {
  it("lista los proveedores activos de la organización", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: readonly { id: string; display_name: string }[] };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.id).toBe(ctx.providerId);
    expect(body.providers[0]!.display_name).toBe("Dra. Fernanda López");
  });

  it("la ficha de un proveedor trae sus reglas de disponibilidad y el estado de Google Calendar", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: { id: string }; availability_rules: readonly unknown[]; google_calendar: { connected: boolean } };
    expect(body.provider.id).toBe(ctx.providerId);
    expect(body.availability_rules).toHaveLength(5); // lunes-viernes, ver seed de citas-fixtures.ts
    expect(body.google_calendar.connected).toBe(false);
  });

  it("404 para un proveedor que no existe", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${randomUUID()}`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(404);
  });

  it("rechaza a un staff que no pertenece a esa property (403)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${randomUUID()}/providers`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/citas/properties/:propertyId/services(/:serviceId)", () => {
  it("lista los servicios activos", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/services`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: readonly { id: string; name: string; duration_minutes: number }[] };
    expect(body.services).toEqual([expect.objectContaining({ id: ctx.serviceId, name: "Consulta general", duration_minutes: 30 })]);
  });

  it("404 para un servicio que no existe", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${randomUUID()}`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/citas/properties/:propertyId/appointments — agenda", () => {
  it("lista las citas reales del rango pedido, enriquecidas con nombres", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointment = await createAppointment(ctx.citasRepo, {
      organizationId: ctx.organizationId,
      providerId: ctx.providerId,
      serviceId: ctx.serviceId,
      customerName: "Ana Torres",
      customerPhone: "9991112233",
      startsAt: MONDAY_10AM_MERIDA,
      source: "web",
    });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments?from=${RANGE_FROM}&to=${RANGE_TO}`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appointments: readonly { id: string; provider_name: string; service_name: string; customer_name: string }[] };
    expect(body.appointments).toHaveLength(1);
    expect(body.appointments[0]!.id).toBe(appointment.id);
    expect(body.appointments[0]!.provider_name).toBe("Dra. Fernanda López");
    expect(body.appointments[0]!.service_name).toBe("Consulta general");
    expect(body.appointments[0]!.customer_name).toBe("Ana Torres");
  });

  it("filtra por provider_id y respeta el rango de fechas (fuera de rango no aparece)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createAppointment(ctx.citasRepo, {
      organizationId: ctx.organizationId,
      providerId: ctx.providerId,
      serviceId: ctx.serviceId,
      customerName: "Ana",
      customerPhone: "9991112233",
      startsAt: MONDAY_10AM_MERIDA,
      source: "web",
    });

    const outOfRange = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments?from=2026-09-15T00:00:00.000Z&to=2026-09-16T00:00:00.000Z`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(((await outOfRange.json()) as { appointments: readonly unknown[] }).appointments).toHaveLength(0);

    const wrongProvider = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments?from=${RANGE_FROM}&to=${RANGE_TO}&provider_id=${randomUUID()}`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(((await wrongProvider.json()) as { appointments: readonly unknown[] }).appointments).toHaveLength(0);
  });

  it("responde 400 sin from/to", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/citas/properties/:propertyId/customers(/:customerId) — clientes", () => {
  it("lista clientes reales (creados por upsertCustomer al crear una cita) y pagina", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createAppointment(ctx.citasRepo, {
      organizationId: ctx.organizationId,
      providerId: ctx.providerId,
      serviceId: ctx.serviceId,
      customerName: "Ana Torres",
      customerPhone: "9991112233",
      startsAt: MONDAY_10AM_MERIDA,
      source: "web",
    });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/customers`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: readonly { full_name: string; phone: string }[]; total: number; next_offset: number | null };
    expect(body.total).toBe(1);
    expect(body.customers[0]).toMatchObject({ full_name: "Ana Torres", phone: "9991112233" });
    expect(body.next_offset).toBeNull();
  });

  it("busca por nombre/teléfono", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createAppointment(ctx.citasRepo, {
      organizationId: ctx.organizationId,
      providerId: ctx.providerId,
      serviceId: ctx.serviceId,
      customerName: "Ana Torres",
      customerPhone: "9991112233",
      startsAt: MONDAY_10AM_MERIDA,
      source: "web",
    });

    const found = await app.request(`/v1/citas/properties/${ctx.propertyId}/customers?search=torres`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(((await found.json()) as { total: number }).total).toBe(1);

    const notFound = await app.request(`/v1/citas/properties/${ctx.propertyId}/customers?search=zzz-nadie`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(((await notFound.json()) as { total: number }).total).toBe(0);
  });

  it("la ficha de un cliente trae sus citas próximas reales", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointment = await createAppointment(ctx.citasRepo, {
      organizationId: ctx.organizationId,
      providerId: ctx.providerId,
      serviceId: ctx.serviceId,
      customerName: "Ana Torres",
      customerPhone: "9991112233",
      startsAt: "2099-01-01T16:00:00.000Z",
      source: "web",
    });
    const customer = await ctx.citasRepo.findCustomerByPhone(ctx.organizationId, "9991112233");

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/customers/${customer!.id}`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customer: { id: string }; upcoming_appointments: readonly { id: string }[] };
    expect(body.customer.id).toBe(customer!.id);
    expect(body.upcoming_appointments).toEqual([expect.objectContaining({ id: appointment.id })]);
  });

  it("404 para un cliente que no existe", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/customers/${randomUUID()}`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// Fase 8 — CRUD real de proveedores/servicios + citas.tenant_config.
// ============================================================================

describe("POST/PATCH /v1/citas/properties/:propertyId/providers(/:providerId) — Fase 8", () => {
  it("crea un proveedor real con los defaults reales cuando el body no trae role_label/is_active", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Dr. Juan Pérez" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { provider: { id: string; display_name: string; role_label: string; is_active: boolean } };
    expect(body.provider.display_name).toBe("Dr. Juan Pérez");
    expect(body.provider.role_label).toBe("Proveedor");
    expect(body.provider.is_active).toBe(true);

    // El nuevo proveedor de verdad quedó en la organización — aparece en el listado.
    const list = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const listBody = (await list.json()) as { providers: readonly { id: string }[] };
    expect(listBody.providers.some((p) => p.id === body.provider.id)).toBe(true);
  });

  it("400 si display_name viene vacío", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("400 si property_id no es una sucursal real de esta organización", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Nuevo", property_id: randomUUID() }),
    });
    expect(res.status).toBe(400);
  });

  it("edita un proveedor real — un campo ausente del patch no lo toca", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ role_label: "Odontóloga en jefe" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: { display_name: string; role_label: string } };
    expect(body.provider.role_label).toBe("Odontóloga en jefe");
    expect(body.provider.display_name).toBe("Dra. Fernanda López");
  });

  it("404 al editar un proveedor que no existe", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${randomUUID()}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    });
    expect(res.status).toBe(404);
  });

  it("la ficha de un proveedor trae offered_service_ids reales", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const body = (await res.json()) as { offered_service_ids: readonly string[] };
    expect(body.offered_service_ids).toEqual([ctx.serviceId]); // seed de citas-fixtures.ts ya lo asigna
  });
});

describe("PUT /v1/citas/properties/:propertyId/providers/:providerId/services/:serviceId — checkbox real (Fase 8)", () => {
  it("offered:false quita la asignación real, offered:true (default) la vuelve a poner", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const off = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/services/${ctx.serviceId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ offered: false }),
    });
    expect(off.status).toBe(200);
    expect(await ctx.citasRepo.providerOffersService(ctx.providerId, ctx.serviceId)).toBe(false);

    const on = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/services/${ctx.serviceId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(on.status).toBe(200);
    expect(await ctx.citasRepo.providerOffersService(ctx.providerId, ctx.serviceId)).toBe(true);
  });

  it("404 si el servicio no existe (nunca asigna un id ajeno a ciegas)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/services/${randomUUID()}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ offered: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST/PATCH /v1/citas/properties/:propertyId/services(/:serviceId) — Fase 8", () => {
  it("crea un servicio real con los defaults reales", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/services`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Limpieza dental", duration_minutes: 45 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { service: { name: string; duration_minutes: number; price_cents: number | null; is_active: boolean } };
    expect(body.service.name).toBe("Limpieza dental");
    expect(body.service.duration_minutes).toBe(45);
    expect(body.service.price_cents).toBeNull();
    expect(body.service.is_active).toBe(true);
  });

  it("400 si duration_minutes no es un entero positivo", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/services`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Servicio inválido", duration_minutes: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("edita un servicio real — price_cents:null explícito sí quita el precio fijo", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${ctx.serviceId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ price_cents: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: { price_cents: number | null; duration_minutes: number } };
    expect(body.service.price_cents).toBeNull();
    expect(body.service.duration_minutes).toBe(30); // no tocado por el patch
  });

  it("404 al editar un servicio que no existe", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${randomUUID()}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "hackeado" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET/PATCH /v1/citas/properties/:propertyId/tenant-config — Fase 8", () => {
  it("GET nunca 404: sin fila todavía, devuelve los defaults reales de la columna", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant_config: { rubro: string; default_timezone: string; owner_notification_phone: string | null } };
    expect(body.tenant_config).toEqual({ rubro: "otro", default_timezone: "America/Mexico_City", owner_notification_phone: null, organization_id: ctx.organizationId });
  });

  it("PATCH edita el rubro real — el mismo campo que usa la guardia de crisis (vertical-config.ts)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ rubro: "psicologo", default_timezone: "America/Tijuana", owner_notification_phone: "5599998888" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant_config: { rubro: string; default_timezone: string; owner_notification_phone: string | null } };
    expect(body.tenant_config.rubro).toBe("psicologo");
    expect(body.tenant_config.default_timezone).toBe("America/Tijuana");
    expect(body.tenant_config.owner_notification_phone).toBe("5599998888");

    // Un patch parcial posterior conserva lo ya guardado.
    const partial = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ rubro: "dental" }),
    });
    const partialBody = (await partial.json()) as { tenant_config: { rubro: string; default_timezone: string; owner_notification_phone: string | null } };
    expect(partialBody.tenant_config.rubro).toBe("dental");
    expect(partialBody.tenant_config.default_timezone).toBe("America/Tijuana"); // no tocado
    expect(partialBody.tenant_config.owner_notification_phone).toBe("5599998888"); // no tocado
  });

  it("400 si rubro no es uno de los 14 valores reales", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ rubro: "inventado" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 si default_timezone no es un IANA timezone real", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ default_timezone: "no-es-un-timezone" }),
    });
    expect(res.status).toBe(400);
  });

  it("403 rechaza a un staff que no pertenece a esa property", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${randomUUID()}/tenant-config`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(403);
  });
});

// ---- Fase 9 — agente "Lista de espera (simple)": GET de solo-lectura +
// POST del broadcast manual (ver reminders.ts::runListaEsperaCore para la
// regla de negocio real). ----
describe("GET /v1/citas/properties/:propertyId/waitlist", () => {
  it("lista la lista de espera viva EN ORDEN DE POSICIÓN (FIFO, el primero en anotarse primero)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const first = ctx.citasRepo.seedWaitlistEntry({
      organizationId: ctx.organizationId,
      customerPhone: "9990000001",
      customerName: "Primero",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const second = ctx.citasRepo.seedWaitlistEntry({
      organizationId: ctx.organizationId,
      customerPhone: "9990000002",
      customerName: "Segundo",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T11:00:00.000Z",
    });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { waitlist: readonly { id: string; position: number }[] };
    expect(body.waitlist.map((w) => w.id)).toEqual([first, second]);
    expect(body.waitlist.map((w) => w.position)).toEqual([1, 2]);
  });

  it("403 rechaza a un staff que no pertenece a esa property", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${randomUUID()}/waitlist`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/citas/properties/:propertyId/waitlist/broadcast — Fase 9", () => {
  it("dispara el broadcast manual: encola mensajes reales vía messaging_outbox, en orden de posición, respetando el límite pedido", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const first = ctx.citasRepo.seedWaitlistEntry({
      organizationId: ctx.organizationId,
      customerPhone: "9990000001",
      customerName: "Primero en la fila",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    ctx.citasRepo.seedWaitlistEntry({
      organizationId: ctx.organizationId,
      customerPhone: "9990000002",
      customerName: "Segundo en la fila",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T11:00:00.000Z",
    });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notified: number; candidates_considered: number; skipped_no_whatsapp_config: boolean };
    expect(body).toEqual({ notified: 1, candidates_considered: 1, skipped_no_whatsapp_config: false });

    const outbox = ctx.citasRepo.getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.channel).toBe("whatsapp");
    expect(outbox[0]!.eventType).toBe("waitlist.slot_available_broadcast");
    expect(outbox[0]!.dedupeKey.startsWith(`waitlist-broadcast:${first}:`)).toBe(true);
    expect(ctx.citasRepo.getWaitlistEntry(first)?.notifiedCount).toBe(1);
  });

  it("400 si limit excede el techo real MAX_LISTA_ESPERA_LIMIT (20)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ limit: 21 }),
    });
    expect(res.status).toBe(400);
  });

  it("400 si provider_id no es un proveedor real de esta organización", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ provider_id: randomUUID() }),
    });
    expect(res.status).toBe(400);
  });

  it("con lista de espera vacía, responde 0 notificados sin lanzar", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notified: number; candidates_considered: number };
    expect(body).toEqual({ notified: 0, candidates_considered: 0, skipped_no_whatsapp_config: false });
  });

  it("403 rechaza a un staff que no pertenece a esa property", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${randomUUID()}/waitlist/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});
