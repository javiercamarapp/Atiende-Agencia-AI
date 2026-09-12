// Test de integración end-to-end real de los 3 flujos Hono de citas: crear cita
// pública, cancelar/reagendar vía el agente (x-atiende-tool-secret), y cancelar
// desde el panel de staff (JWT + requirePropertyMembership) — sobre la app Hono
// real, con InMemoryCitasRepository en vez de Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { authedJson } from "./hoteles-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

const MONDAY_10AM_MERIDA = "2026-09-14T16:00:00.000Z"; // 10:00 hora de Mérida (UTC-6)
const MONDAY_1030AM_MERIDA = "2026-09-14T16:30:00.000Z";

describe("POST /v1/citas/:orgSlug/appointments — crear cita", () => {
  it("un cliente web crea una cita real en un slot válido", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({
        provider_id: ctx.providerId,
        service_id: ctx.serviceId,
        customer_name: "Ana Torres",
        customer_phone: "9991112233",
        starts_at: MONDAY_10AM_MERIDA,
        source: "web",
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { appointment: { id: string; status: string; starts_at: string } };
    expect(body.appointment.status).toBe("pending");
    expect(body.appointment.starts_at).toBe(MONDAY_10AM_MERIDA);
  });

  it("rechaza source=voice sin el secreto del tool", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "voice" }),
    );
    expect(res.status).toBe(401);
  });

  it("acepta source=voice CON el secreto del tool real", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit(
        { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "voice", conversation_id: "conv_abc123" },
        { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret },
      ),
    );
    expect(res.status).toBe(201);
  });

  it("un horario fuera de disponibilidad real da 409 con mensaje claro", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: "2026-09-14T09:00:00.000Z", source: "web" }), // 3am Mérida
    );
    expect(res.status).toBe(409);
  });

  it("negocio inexistente da 404", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      "/v1/citas/no-existe/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("cancelar/reagendar vía el agente (x-atiende-tool-secret)", () => {
  async function createRealAppointment(ctx: Awaited<ReturnType<typeof buildCitasTestContext>>, app: ReturnType<typeof buildApp>, phone = "9991112233") {
    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Torres", customer_phone: phone, starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    const body = (await res.json()) as { appointment: { id: string } };
    return body.appointment.id;
  }

  it("cancela una cita real con el secreto del tool", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointmentId = await createRealAppointment(ctx, app);

    const res = await app.request(`/v1/citas/clinica-dental-sonrisas/appointments/${appointmentId}/cancel`, {
      method: "POST",
      headers: { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appointment: { status: string } };
    expect(body.appointment.status).toBe("cancelled");
  });

  it("rechaza cancelar sin el secreto del tool", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointmentId = await createRealAppointment(ctx, app);
    const res = await app.request(`/v1/citas/clinica-dental-sonrisas/appointments/${appointmentId}/cancel`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("reagenda una cita real, preservando el mismo id", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointmentId = await createRealAppointment(ctx, app);

    const res = await app.request(
      `/v1/citas/clinica-dental-sonrisas/appointments/${appointmentId}/reschedule`,
      jsonRequestInit({ new_starts_at: MONDAY_1030AM_MERIDA, actor_channel: "web" }, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appointment: { id: string; starts_at: string } };
    expect(body.appointment.id).toBe(appointmentId);
    expect(body.appointment.starts_at).toBe(MONDAY_1030AM_MERIDA);
  });

  it("reagendar a un horario fuera de disponibilidad da 409 con alternative_slots reales", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointmentId = await createRealAppointment(ctx, app);

    const res = await app.request(
      `/v1/citas/clinica-dental-sonrisas/appointments/${appointmentId}/reschedule`,
      jsonRequestInit({ new_starts_at: "2026-09-14T09:00:00.000Z" }, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }), // 3am Mérida
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; alternative_slots: { starts_at: string; ends_at: string }[] };
    expect(body.alternative_slots.length).toBeGreaterThan(0);
  });
});

describe("modificar-cita vía el agente (x-atiende-tool-secret) — Fase 4", () => {
  async function createRealAppointment(ctx: Awaited<ReturnType<typeof buildCitasTestContext>>, app: ReturnType<typeof buildApp>, phone = "9994445566") {
    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Torres", customer_phone: phone, starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    const body = (await res.json()) as { appointment: { id: string } };
    return body.appointment.id;
  }

  function seedSecondProvider(ctx: Awaited<ReturnType<typeof buildCitasTestContext>>) {
    const citasRepo = ctx.citasRepo;
    const otroProviderId = randomUUID();
    citasRepo.seedProvider({ id: otroProviderId, organizationId: ctx.organizationId, propertyId: null, displayName: "Dr. Roberto Cen", roleLabel: "Dentista", isActive: true });
    citasRepo.seedProviderService(otroProviderId, ctx.serviceId);
    for (const dayOfWeek of [1, 2, 3, 4, 5]) {
      citasRepo.seedAvailabilityRule({ id: randomUUID(), providerId: otroProviderId, dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true });
    }
    return otroProviderId;
  }

  it("reasigna a un proveedor nuevo real, preservando el mismo id y el mismo horario de inicio", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const otroProviderId = seedSecondProvider(ctx);
    const appointmentId = await createRealAppointment(ctx, app);

    const res = await app.request(
      `/v1/citas/clinica-dental-sonrisas/appointments/${appointmentId}/reassign`,
      jsonRequestInit({ new_provider_id: otroProviderId, actor_channel: "web" }, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appointment: { id: string; provider_id: string; starts_at: string } };
    expect(body.appointment.id).toBe(appointmentId);
    expect(body.appointment.provider_id).toBe(otroProviderId);
    expect(body.appointment.starts_at).toBe(MONDAY_10AM_MERIDA);
  });

  it("rechaza sin el secreto del tool", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const otroProviderId = seedSecondProvider(ctx);
    const appointmentId = await createRealAppointment(ctx, app);

    const res = await app.request(`/v1/citas/clinica-dental-sonrisas/appointments/${appointmentId}/reassign`, jsonRequestInit({ new_provider_id: otroProviderId }));
    expect(res.status).toBe(401);
  });

  it("rechaza reasignar a un proveedor que no ofrece el servicio, con 400 real", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const citasRepo = ctx.citasRepo;
    const otroProviderId = randomUUID();
    citasRepo.seedProvider({ id: otroProviderId, organizationId: ctx.organizationId, propertyId: null, displayName: "Dr. sin este servicio", roleLabel: "Dentista", isActive: true });
    // Nunca se llama seedProviderService -- este proveedor no ofrece ctx.serviceId.
    const appointmentId = await createRealAppointment(ctx, app);

    const res = await app.request(
      `/v1/citas/clinica-dental-sonrisas/appointments/${appointmentId}/reassign`,
      jsonRequestInit({ new_provider_id: otroProviderId }, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }),
    );
    expect(res.status).toBe(400);
  });

  it("sin ningún campo de cambio real es 400 (nunca un no-op silencioso 200)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointmentId = await createRealAppointment(ctx, app);

    const res = await app.request(`/v1/citas/clinica-dental-sonrisas/appointments/${appointmentId}/reassign`, jsonRequestInit({}, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }));
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/citas/properties/:propertyId/appointments/:appointmentId/cancel — panel de staff", () => {
  it("un staff autenticado con membership real de esa property cancela la cita", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const createRes = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    const { appointment } = (await createRes.json()) as { appointment: { id: string } };

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${appointment.id}/cancel`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appointment: { status: string } };
    expect(body.appointment.status).toBe("cancelled");
  });

  it("rechaza sin JWT (401)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${randomUUID()}/cancel`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rechaza a un staff que no pertenece a esa property (403)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const otraPropertyId = randomUUID();
    const res = await app.request(`/v1/citas/properties/${otraPropertyId}/appointments/${randomUUID()}/cancel`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(403);
  });
});
