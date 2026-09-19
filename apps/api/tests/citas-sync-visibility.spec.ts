// Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — HTTP real de punta a
// punta para el hueco que documentó el autor del PR #135: un rechazo PERMANENTE
// de validación (Cal.com exige attendeeEmail, p.ej.) dejaba la cita reintentando
// a ciegas y sin ninguna señal visible en el panel. Mismo patrón de prueba que
// citas-calendar-providers.spec.ts: `buildCitasTestContext({calcomPort})` inyecta
// un `FakeCalendarSyncPort` (nunca toca la red).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CalComApiError, FakeCalendarSyncPort } from "@atiende/domain-citas";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { authedJson } from "./hoteles-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { llaveFicticia } from "./support/credenciales-ficticias.ts";

const MONDAY_10AM_MERIDA = "2027-09-13T16:00:00.000Z"; // 10:00 hora de Mérida (UTC-6)

async function createRealAppointmentFromWeb(ctx: Awaited<ReturnType<typeof buildCitasTestContext>>, app: ReturnType<typeof buildApp>, customerPhone = "9991112233") {
  const res = await app.request(
    "/v1/citas/clinica-dental-sonrisas/appointments",
    jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Torres", customer_phone: customerPhone, starts_at: MONDAY_10AM_MERIDA, source: "web" }),
  );
  const body = (await res.json()) as { appointment: { id: string; customer_id: string } };
  return body.appointment;
}

/** `authedJson` (hoteles-fixtures.ts) solo arma GET/POST -- PATCH real para las
 * pruebas nuevas de esta fase. */
function authedPatch(token: string, body: unknown): RequestInit {
  return { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("un rechazo de validación de Cal.com (422, sin attendeeEmail) deja la cita 'invalid' visible de inmediato", () => {
  it("crear la cita: la Agenda del panel ve google_sync_status='invalid' con un motivo legible, sin marcar la cuenta", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    calcomPort.failNextCall = new CalComApiError("Cal.com API error en /bookings", 422, JSON.stringify({ message: "attendee.email es requerido" }));
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });

    const createRes = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Torres", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    expect(createRes.status).toBe(201); // crear la cita real NUNCA falla por esto -- el fallo de Cal.com es best-effort.

    // La Agenda del panel SÍ ve el estado + el motivo (GET admin.ts, enrichAppointments).
    const agendaRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments?from=2027-09-01T00:00:00.000Z&to=2027-09-30T00:00:00.000Z`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(agendaRes.status).toBe(200);
    const agendaBody = (await agendaRes.json()) as { appointments: { google_sync_status: string; google_sync_error: string | null }[] };
    expect(agendaBody.appointments).toHaveLength(1);
    expect(agendaBody.appointments[0]!.google_sync_status).toBe("invalid");
    expect(agendaBody.appointments[0]!.google_sync_error).toContain("Cal.com exige el correo del cliente");

    // Nunca marca la cuenta -- la credencial sigue sirviendo.
    const account = await ctx.citasRepo.findProviderCalComAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("connected");
  });

  it("el resumen de sincronizaciones con problema del proveedor aparece en la ficha del proveedor (GET .../providers/:id) y en GET .../calcom/status", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    calcomPort.failNextCall = new CalComApiError("Cal.com API error", 422, JSON.stringify({ message: "attendee.email es requerido" }));
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });
    await createRealAppointmentFromWeb(ctx, app);

    const providerRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(providerRes.status).toBe(200);
    const providerBody = (await providerRes.json()) as { calendar_sync_issues: { count: number; last_reason: string | null } };
    expect(providerBody.calendar_sync_issues.count).toBe(1);
    expect(providerBody.calendar_sync_issues.last_reason).toContain("Cal.com exige el correo del cliente");

    const statusRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/status`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as { sync_status: string; sync_issues: { count: number; last_reason: string | null } };
    // La cuenta sigue 'connected' (nunca marcada en error) -- el resumen es la
    // única señal, ver diseño.
    expect(statusBody.sync_status).toBe("connected");
    expect(statusBody.sync_issues.count).toBe(1);
  });

  it("PATCH .../customers/:id agrega el correo, y POST .../retry-sync sincroniza de verdad de inmediato", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    calcomPort.failNextCall = new CalComApiError("Cal.com API error", 422, JSON.stringify({ message: "attendee.email es requerido" }));
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });
    const appointment = await createRealAppointmentFromWeb(ctx, app);

    const patchRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/customers/${appointment.customer_id}`, authedPatch(ctx.staff.owner.token, { email: "ana.torres@example.test" }));
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { customer: { email: string | null } };
    expect(patchBody.customer.email).toBe("ana.torres@example.test");

    const retryRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${appointment.id}/retry-sync`, authedJson(ctx.staff.owner.token, {}));
    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as { appointment: { google_sync_status: string } };
    expect(retryBody.appointment.google_sync_status).toBe("synced");

    // El PRIMER createEvent (antes de agregar el correo, el que 422'd) también
    // quedó registrado -- el que importa es el ÚLTIMO (el reintento real).
    const createEventCalls = calcomPort.calls.filter((c) => c.method === "createEvent");
    expect((createEventCalls.at(-1)!.input as { attendeeEmail?: string }).attendeeEmail).toBe("ana.torres@example.test");
  });

  it("reintentar una cita que NO está 'invalid' (recién creada, 'skipped' sin calendario conectado) da 409", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointment = await createRealAppointmentFromWeb(ctx, app);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${appointment.id}/retry-sync`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(409);
  });

  it("reintentar sin JWT da 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${randomUUID()}/retry-sync`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("un formato de correo inválido en PATCH .../customers/:id da 400, nunca se guarda a medias", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointment = await createRealAppointmentFromWeb(ctx, app);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/customers/${appointment.customer_id}`, authedPatch(ctx.staff.owner.token, { email: "no-es-un-correo" }));
    expect(res.status).toBe(400);
  });

  it("PATCH .../customers/:id con email:null quita el correo -- nunca es obligatorio", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const appointment = await createRealAppointmentFromWeb(ctx, app);
    await app.request(`/v1/citas/properties/${ctx.propertyId}/customers/${appointment.customer_id}`, authedPatch(ctx.staff.owner.token, { email: "ana.torres@example.test" }));

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/customers/${appointment.customer_id}`, authedPatch(ctx.staff.owner.token, { email: null }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customer: { email: string | null } };
    expect(body.customer.email).toBeNull();
  });

  it("un customerId inexistente en PATCH .../customers/:id da 404", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/customers/${randomUUID()}`, authedPatch(ctx.staff.owner.token, { email: "ana.torres@example.test" }));
    expect(res.status).toBe(404);
  });
});
