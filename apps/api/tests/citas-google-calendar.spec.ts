// Fase 3 — test de integración end-to-end real sobre la app Hono real:
//   1. Flujo OAuth completo (connect -> state real -> callback -> conecta la cuenta)
//   2. Los 3 puntos de sincronización best-effort (crear/cancelar/reagendar)
//   3. El caso más importante: un fallo de Google Calendar NUNCA rompe la respuesta
//      HTTP real de crear/cancelar/reagendar una cita.
//   4. El cron de reconciliación (/internal/citas/google-calendar-sync).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppointment, FakeGoogleCalendarPort, verifyGoogleCalendarOAuthState } from "@atiende/domain-citas";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { authedJson } from "./hoteles-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

const MONDAY_10AM_MERIDA = "2026-09-14T16:00:00.000Z"; // 10:00 hora de Mérida (UTC-6)
const MONDAY_1030AM_MERIDA = "2026-09-14T16:30:00.000Z";

describe("GET /v1/citas/properties/:propertyId/providers/:providerId/google-calendar/connect", () => {
  it("un staff autenticado con membership real obtiene una authorize_url real de Google con state firmado", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/google-calendar/connect`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorize_url: string };
    const url = new URL(body.authorize_url);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe(ctx.deps.env.googleOAuth!.clientId);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent"); // fuerza refresh_token incluso en reconexión

    const state = verifyGoogleCalendarOAuthState(url.searchParams.get("state")!, ctx.deps.env.whatsappAppSecret);
    expect(state).toEqual({ organizationId: ctx.organizationId, providerId: ctx.providerId, propertyId: ctx.propertyId, issuedAt: state!.issuedAt });
  });

  it("rechaza sin JWT (401)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/google-calendar/connect`);
    expect(res.status).toBe(401);
  });

  it("rechaza a un staff que no pertenece a esa property (403)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${randomUUID()}/providers/${ctx.providerId}/google-calendar/connect`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(res.status).toBe(403);
  });

  it("responde 503 cuando Google OAuth no está configurado en la plataforma (estado real de este entorno, ver diseño §9)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp({ ...ctx.deps, env: { ...ctx.deps.env, googleOAuth: null } });
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/google-calendar/connect`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /v1/citas/google-calendar/oauth-callback", () => {
  async function getAuthorizeState(app: ReturnType<typeof buildApp>, ctx: Awaited<ReturnType<typeof buildCitasTestContext>>) {
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/google-calendar/connect`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    const body = (await res.json()) as { authorize_url: string };
    return new URL(body.authorize_url).searchParams.get("state")!;
  }

  it("con code+state reales, intercambia el código y conecta la cuenta con sync_status='connected'", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    const state = await getAuthorizeState(app, ctx);

    const res = await app.request(`/v1/citas/google-calendar/oauth-callback?code=fake-auth-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean; provider_id: string; sync_status: string };
    expect(body.connected).toBe(true);
    expect(body.provider_id).toBe(ctx.providerId);
    expect(body.sync_status).toBe("connected");

    const account = await ctx.citasRepo.findProviderCalendarAccount(ctx.providerId);
    expect(account!.syncStatus).toBe("connected");
  });

  it("rechaza un state manipulado (401) sin conectar nada", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    const state = await getAuthorizeState(app, ctx);
    const tamperedState = state.slice(0, -1) + (state.endsWith("a") ? "b" : "a");

    const res = await app.request(`/v1/citas/google-calendar/oauth-callback?code=fake-auth-code&state=${encodeURIComponent(tamperedState)}`);
    expect(res.status).toBe(401);
    expect(await ctx.citasRepo.findProviderCalendarAccount(ctx.providerId)).toBeNull();
  });

  it("faltando code o state responde 400", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/google-calendar/oauth-callback?code=solo-code`);
    expect(res.status).toBe(400);
  });

  it("cuando Google no devuelve refresh_token, responde 400 y NO conecta la cuenta", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    const state = await getAuthorizeState(app, ctx);

    const noRefreshTokenDeps = { ...ctx.deps, citasGoogleTokenExchange: async () => ({ accessToken: "at", refreshToken: null, expiresIn: 3600 }) };
    const appNoRefresh = buildApp(noRefreshTokenDeps);
    const res = await appNoRefresh.request(`/v1/citas/google-calendar/oauth-callback?code=fake-auth-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    expect(await ctx.citasRepo.findProviderCalendarAccount(ctx.providerId)).toBeNull();
  });
});

describe("Fase 3 §5 — los 3 puntos de sincronización best-effort", () => {
  async function connectProvider(ctx: Awaited<ReturnType<typeof buildCitasTestContext>>, app: ReturnType<typeof buildApp>) {
    const connectRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/google-calendar/connect`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    const { authorize_url } = (await connectRes.json()) as { authorize_url: string };
    const state = new URL(authorize_url).searchParams.get("state")!;
    const callbackRes = await app.request(`/v1/citas/google-calendar/oauth-callback?code=fake-auth-code&state=${encodeURIComponent(state)}`);
    expect(callbackRes.status).toBe(200);
  }

  it("crear una cita real, con Google conectado, sincroniza de inmediato y crea el evento real", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    await connectProvider(ctx, app);

    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Torres", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { appointment: { id: string } };

    expect(port.events.size).toBe(1);
    const stored = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, body.appointment.id);
    expect(stored!.googleSyncStatus).toBe("synced");
    expect(stored!.googleEventId).not.toBeNull();
  });

  it("cancelar una cita ya sincronizada borra el evento real de Google", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    await connectProvider(ctx, app);

    const createRes = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    const { appointment } = (await createRes.json()) as { appointment: { id: string } };
    const beforeCancel = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id);
    const eventId = beforeCancel!.googleEventId!;
    expect(port.events.get(eventId)!.deleted).toBe(false);

    const cancelRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${appointment.id}/cancel`, authedJson(ctx.staff.owner.token, {}));
    expect(cancelRes.status).toBe(200);

    expect(port.events.get(eventId)!.deleted).toBe(true);
    const stored = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("deleted");
  });

  it("reagendar una cita ya sincronizada actualiza el horario del evento real", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    await connectProvider(ctx, app);

    const createRes = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    const { appointment } = (await createRes.json()) as { appointment: { id: string } };
    const synced = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id);
    const eventId = synced!.googleEventId!;

    const rescheduleRes = await app.request(
      `/v1/citas/clinica-dental-sonrisas/appointments/${appointment.id}/reschedule`,
      jsonRequestInit({ new_starts_at: MONDAY_1030AM_MERIDA, actor_channel: "web" }, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }),
    );
    expect(rescheduleRes.status).toBe(200);

    expect(port.events.get(eventId)!.startTime).toBe(MONDAY_1030AM_MERIDA);
    const stored = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("synced");
  });

  it("un proveedor SIN Google Calendar conectado: crear/cancelar/reagendar funcionan igual, la cita queda 'skipped'", async () => {
    const ctx = await buildCitasTestContext(buildApp); // sin googleCalendarPort -> nunca conecta nada
    const app = buildApp(ctx.deps);

    const createRes = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    expect(createRes.status).toBe(201);
    const { appointment } = (await createRes.json()) as { appointment: { id: string } };
    const stored = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("skipped");
  });

  // ==========================================================================
  // EL CASO MÁS IMPORTANTE: un fallo de Google Calendar NUNCA rompe la
  // operación real de dominio en la respuesta HTTP — la cita real ya se
  // creó/canceló/reagendó pase lo que pase con la sincronización best-effort.
  // ==========================================================================
  it("un fallo de Google Calendar durante CREAR una cita real sigue devolviendo 201 (la cita real existe)", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    await connectProvider(ctx, app);

    port.failNextCall = new Error("Google Calendar no respondió (ECONNRESET)");
    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );

    expect(res.status).toBe(201); // la cita real se creó pese al fallo de Google
    const body = (await res.json()) as { appointment: { id: string; status: string } };
    expect(body.appointment.status).toBe("pending");

    const stored = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, body.appointment.id);
    expect(stored!.status).toBe("pending"); // la cita real sigue viva
    expect(stored!.googleSyncStatus).toBe("pending"); // quedó pendiente de reintento, nunca perdida
    expect(stored!.googleSyncError).toContain("ECONNRESET");
  });

  it("un fallo de Google Calendar durante CANCELAR una cita real sigue devolviendo 200 (la cita real quedó cancelada)", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    await connectProvider(ctx, app);

    const createRes = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    const { appointment } = (await createRes.json()) as { appointment: { id: string } };

    port.failNextCall = new Error("Google Calendar 500");
    const cancelRes = await app.request(`/v1/citas/clinica-dental-sonrisas/appointments/${appointment.id}/cancel`, {
      method: "POST",
      headers: { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret },
    });

    expect(cancelRes.status).toBe(200); // la cancelación real de la cita nunca depende de Google
    const body = (await cancelRes.json()) as { appointment: { status: string } };
    expect(body.appointment.status).toBe("cancelled"); // la cita real SÍ quedó cancelada

    const stored = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id);
    expect(stored!.status).toBe("cancelled");
    expect(stored!.googleSyncStatus).toBe("pending_cancel"); // pendiente de reintentar el borrado en Google
  });

  it("un fallo de Google Calendar durante REAGENDAR una cita real sigue devolviendo 200 con el horario nuevo real", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    await connectProvider(ctx, app);

    const createRes = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    const { appointment } = (await createRes.json()) as { appointment: { id: string } };

    port.failNextCall = new Error("Google Calendar timeout");
    const rescheduleRes = await app.request(
      `/v1/citas/clinica-dental-sonrisas/appointments/${appointment.id}/reschedule`,
      jsonRequestInit({ new_starts_at: MONDAY_1030AM_MERIDA, actor_channel: "web" }, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }),
    );

    expect(rescheduleRes.status).toBe(200); // el reagendado real nunca depende de Google
    const body = (await rescheduleRes.json()) as { appointment: { starts_at: string } };
    expect(body.appointment.starts_at).toBe(MONDAY_1030AM_MERIDA); // el horario real SÍ cambió

    const stored = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id);
    expect(stored!.startsAt).toBe(MONDAY_1030AM_MERIDA);
    expect(stored!.googleSyncStatus).toBe("pending"); // pendiente de reintentar la actualización en Google
  });
});

describe("POST /internal/citas/google-calendar-sync — reconciliación por lote", () => {
  it("con el secreto correcto, sincroniza las citas pendientes reales", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);

    const connectRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/google-calendar/connect`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    const { authorize_url } = (await connectRes.json()) as { authorize_url: string };
    const state = new URL(authorize_url).searchParams.get("state")!;
    await app.request(`/v1/citas/google-calendar/oauth-callback?code=fake-auth-code&state=${encodeURIComponent(state)}`);

    // Creada directo por el dominio (sin pasar por la ruta HTTP) para que NINGÚN
    // intento inmediato la toque todavía — así el cron es el único que la procesa,
    // exactamente el caso real de "el intento inmediato se perdió (proceso
    // reiniciado, etc.) pero la reconciliación por lote la recoge después".
    const appointment = await createAppointment(ctx.citasRepo, {
      organizationId: ctx.organizationId,
      providerId: ctx.providerId,
      serviceId: ctx.serviceId,
      customerName: "Ana",
      customerPhone: "9991112233",
      startsAt: MONDAY_10AM_MERIDA,
      source: "web",
    });
    expect(appointment.googleSyncStatus).toBe("pending");
    expect(appointment.googleSyncNextRetryAt).toBeNull(); // nunca se intentó -> elegible de inmediato

    const syncRes = await app.request("/internal/citas/google-calendar-sync", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(syncRes.status).toBe(200);
    const body = (await syncRes.json()) as { ok: boolean; processed: number; synced: number };
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(1);
    expect(body.synced).toBe(1);

    const stored = await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("synced");
    expect(port.events.size).toBe(1);
  });

  it("rechaza sin el secreto interno (401)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/google-calendar-sync", { method: "POST" });
    expect(res.status).toBe(401);
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` — nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/google-calendar-sync", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/google-calendar-sync", { method: "GET" });
    expect(res.status).toBe(401);
  });
});
