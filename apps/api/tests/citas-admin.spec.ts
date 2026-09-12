// Fase 5 — test de integración end-to-end real de las rutas de lectura del panel
// de administración visual (agenda/proveedores/servicios/clientes) sobre la app
// Hono real, con InMemoryCitasRepository. Mismo estilo que citas-appointments.spec.ts.
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
