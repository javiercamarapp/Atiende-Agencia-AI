// Fase 6 §2 — HTTP real de conectar/desconectar Cal.com/CalDAV por proveedor
// (mismo patrón de prueba que citas-google-calendar.spec.ts): sin credenciales
// reales, solo el flujo HTTP completo (staff autenticado -> conecta -> queda
// 'connected' en el repo -> desconecta -> vuelve a 'disconnected').
//
// Fase 6 §2 (seguimiento) — estado/prueba de conexión + Cal.com self-hosted: usa
// `FakeCalendarSyncPort` (mismo patrón que `FakeGoogleCalendarPort`, ver
// @atiende/domain-citas) inyectado vía `buildCitasTestContext({calcomPort/caldavPort})`
// -- `test-connection` hace una llamada de red REAL a `RealCalComPort`/
// `RealCalDavPort` en producción, pero en pruebas de apps/api se sustituye el
// puerto (nunca toca la red), igual que `googleCalendarPort`.
import { describe, expect, it } from "vitest";
import { CalComApiError, CalDavApiError, FakeCalendarSyncPort } from "@atiende/domain-citas";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { claveFicticia, llaveFicticia } from "./support/credenciales-ficticias.ts";

describe("Fase 6 §2 — conectar/desconectar Cal.com por proveedor", () => {
  it("un staff autenticado conecta Cal.com de su proveedor con api_key + event_type_id reales", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
      body: JSON.stringify({ api_key: "cal_test_1234567890", event_type_id: "555" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean; sync_status: string };
    expect(body.connected).toBe(true);
    expect(body.sync_status).toBe("connected");

    const account = await ctx.citasRepo.findProviderCalComAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("connected");
    expect(account?.calcomEventTypeId).toBe("555");
    // El API key nunca queda en el registro público del repo -- solo el "secreto".
    expect(await ctx.citasRepo.resolveProviderCalComApiKey(ctx.providerId)).toBe("cal_test_1234567890");
  });

  it("sin api_key/event_type_id responde 400 validation_error", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("sin JWT de staff responde 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "cal_test_1234567890", event_type_id: "555" }),
    });
    expect(res.status).toBe(401);
  });

  it("desconectar marca sync_status='disconnected' sin borrar el registro", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: "cal_test_1234567890" });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/disconnect`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(res.status).toBe(200);
    const account = await ctx.citasRepo.findProviderCalComAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("disconnected");
  });
});

describe("Fase 6 §2 — conectar/desconectar CalDAV por proveedor", () => {
  it("un staff autenticado conecta CalDAV de su proveedor con URL + credenciales reales", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
      body: JSON.stringify({ calendar_collection_url: "https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/", username: "x@y.com", password: "app-password-real" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean; sync_status: string };
    expect(body.connected).toBe(true);
    expect(body.sync_status).toBe("connected");

    const account = await ctx.citasRepo.findProviderCalDavAccount(ctx.providerId);
    expect(account?.username).toBe("x@y.com");
    expect(await ctx.citasRepo.resolveProviderCalDavPassword(ctx.providerId)).toBe("app-password-real");
  });

  it("una URL sin https:// se rechaza con 400", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
      body: JSON.stringify({ calendar_collection_url: "http://caldav.fastmail.com/x/", username: "x@y.com", password: "app-password-real" }),
    });
    expect(res.status).toBe(400);
  });

  // Hallazgo de auditoría (ALTO, SSRF real y explotable) — antes de este cambio,
  // el único chequeo era `/^https:\/\//`, así que CUALQUIERA de las URLs de abajo
  // (todas empiezan con "https://") se guardaba sin problema, y quedaba lista
  // para que `RealCalDavPort` emitiera peticiones HTTP reales contra
  // infraestructura interna (incluida la metadata de nube). Ver
  // packages/domain-citas/tests/net-validar-url-caldav.spec.ts para la prueba
  // unitaria pura de cada rango bloqueado; aquí se confirma que la ruta HTTP
  // real (no solo la función interna) rechaza con 400, y que la URL NUNCA queda
  // guardada.
  it("(b) una IP literal privada/loopback/link-local/metadata en calendar_collection_url se rechaza con 400 y no se guarda", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    for (const url of ["https://127.0.0.1/dav/", "https://169.254.169.254/latest/meta-data/", "https://10.0.0.5/dav/", "https://172.16.0.5/dav/", "https://192.168.1.5/dav/", "https://[::1]/dav/"]) {
      const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/connect`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
        body: JSON.stringify({ calendar_collection_url: url, username: "x@y.com", password: "app-password-real" }),
      });
      expect(res.status, `esperaba 400 para ${url}`).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("validation_error");
    }

    const account = await ctx.citasRepo.findProviderCalDavAccount(ctx.providerId);
    expect(account).toBeNull();
  });

  it("(c) DNS rebinding: un hostname sin pinta de privado que resuelve (vía DNS) a una IP privada se rechaza con 400", async () => {
    // El resolver DNS falso de este test simula el escenario real de ataque: un
    // hostname público en apariencia ("calendario.ejemplo-atacante.com") que en
    // el momento de conectar resuelve a una IP interna. La validación por STRING
    // original (`/^https:\/\//`) nunca habría detectado esto -- solo resolver DNS
    // de verdad lo revela.
    const ctx = await buildCitasTestContext(buildApp, { caldavDnsResolver: (hostname) => (hostname === "calendario.ejemplo-atacante.com" ? ["10.0.0.5"] : ["203.0.113.10"]) });
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
      body: JSON.stringify({ calendar_collection_url: "https://calendario.ejemplo-atacante.com/dav/x/", username: "x@y.com", password: "app-password-real" }),
    });
    expect(res.status).toBe(400);
    const account = await ctx.citasRepo.findProviderCalDavAccount(ctx.providerId);
    expect(account).toBeNull();
  });

  it("(a) con el mismo resolver DNS falso, un hostname que resuelve a IP pública se conecta con normalidad", async () => {
    const ctx = await buildCitasTestContext(buildApp, { caldavDnsResolver: (hostname) => (hostname === "calendario.ejemplo-atacante.com" ? ["10.0.0.5"] : ["203.0.113.10"]) });
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
      body: JSON.stringify({ calendar_collection_url: "https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/", username: "x@y.com", password: "app-password-real" }),
    });
    expect(res.status).toBe(200);
    const account = await ctx.citasRepo.findProviderCalDavAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("connected");
  });

  it("desconectar marca sync_status='disconnected'", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalDavAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calendarCollectionUrl: "https://caldav.example.com/x/", username: "x@y.com", password: "pw" });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/disconnect`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(res.status).toBe(200);
    const account = await ctx.citasRepo.findProviderCalDavAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("disconnected");
  });
});

describe("Fase 6 §2 (seguimiento) — Cal.com self-hosted: base_url pasa por la MISMA validación SSRF real", () => {
  it("un base_url con IP privada literal se rechaza con 400 y NO se guarda", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
      body: JSON.stringify({ api_key: llaveFicticia(), event_type_id: "555", base_url: "https://169.254.169.254/v2" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("validation_error");
    expect(await ctx.citasRepo.findProviderCalComAccount(ctx.providerId)).toBeNull();
  });

  it("un base_url público real se guarda y queda expuesto en connect/status (nunca el api_key)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
      body: JSON.stringify({ api_key: llaveFicticia("selfhosted"), event_type_id: "555", base_url: "https://calcom.miempresa.example/v2" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.calcom_base_url).toBe("https://calcom.miempresa.example/v2");
    expect(body.api_key).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(llaveFicticia("selfhosted"));

    const account = await ctx.citasRepo.findProviderCalComAccount(ctx.providerId);
    expect(account?.baseUrl).toBe("https://calcom.miempresa.example/v2");
    expect(await ctx.citasRepo.resolveProviderCalComApiKey(ctx.providerId)).toBe(llaveFicticia("selfhosted"));
  });

  it("sin base_url (SaaS oficial): connect/status devuelven calcom_base_url:null", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` },
      body: JSON.stringify({ api_key: llaveFicticia(), event_type_id: "555" }),
    });
    const body = (await res.json()) as { calcom_base_url: string | null };
    expect(body.calcom_base_url).toBeNull();
  });
});

describe("Fase 6 §2 (seguimiento) — GET .../calcom/status y .../caldav/status", () => {
  it("Cal.com sin conectar: connected:false, sync_status:'disconnected'", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/status`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, sync_status: "disconnected", sync_error: null, calcom_event_type_id: null, calcom_base_url: null, sync_issues: { count: 0, last_reason: null } });
  });

  it("Cal.com conectado: connected:true, sync_status:'connected', sin api_key", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/status`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ connected: true, sync_status: "connected", sync_error: null, calcom_event_type_id: "555", calcom_base_url: null, sync_issues: { count: 0, last_reason: null } });
    expect(JSON.stringify(body)).not.toContain(llaveFicticia());
  });

  it("CalDAV sin conectar: connected:false, sync_status:'disconnected'", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/status`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(await res.json()).toEqual({ connected: false, sync_status: "disconnected", sync_error: null, calendar_collection_url: null, username: null, sync_issues: { count: 0, last_reason: null } });
  });

  it("CalDAV conectado: connected:true, sin la contraseña de aplicación", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalDavAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calendarCollectionUrl: "https://caldav.example.com/x/", username: "x@y.com", password: claveFicticia("secreta") });
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/status`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ connected: true, sync_status: "connected", sync_error: null, calendar_collection_url: "https://caldav.example.com/x/", username: "x@y.com", sync_issues: { count: 0, last_reason: null } });
    expect(JSON.stringify(body)).not.toContain(claveFicticia("secreta"));
  });

  it("sin JWT responde 401 en ambos status", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/status`)).status).toBe(401);
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/status`)).status).toBe(401);
  });
});

describe("Fase 6 §2 (seguimiento) — POST .../calcom/test-connection", () => {
  it("sin conectar Cal.com -> 409 (nada que probar)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(409);
  });

  it("conectado + la comprobación en vivo tiene éxito -> 200 ok:true, y limpia un sync_error previo", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });
    await ctx.citasRepo.setProviderCalComAccountSyncError(ctx.providerId, "fallo previo de una sincronización");

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checked_at: string };
    expect(body.ok).toBe(true);
    expect(new Date(body.checked_at).toString()).not.toBe("Invalid Date");
    expect(calcomPort.calls.some((c) => c.method === "listAvailability")).toBe(true);

    const account = await ctx.citasRepo.findProviderCalComAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("connected");
    expect(account?.syncError).toBeNull();
  });

  it("un 401 real del proveedor -> 422 credencial inválida, y la cuenta queda en error", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    calcomPort.failNextCall = new CalComApiError("no autorizado", 401, "unauthorized");
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia("revocada") });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("calendar_provider_credencial_invalida");

    const account = await ctx.citasRepo.findProviderCalComAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("error");
    expect(account?.syncError).toBeTruthy();
  });

  it("un 500 real del proveedor (caído) -> 502, sin marcar la cuenta en error (es transitorio del lado del proveedor)", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    calcomPort.failNextCall = new CalComApiError("error de servidor", 500, "internal error");
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("calendar_provider_no_disponible");

    const account = await ctx.citasRepo.findProviderCalComAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("connected"); // nunca se tocó por un 502
  });

  it("un fallo de red genérico (no CalComApiError) también se traduce a 502, nunca a un 500 genérico", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    calcomPort.failNextCall = new Error("ECONNRESET");
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(502);
  });

  it("rate-limit real: más de 20 pruebas de conexión en 60s para el mismo proveedor responde 429", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });

    let lastStatus = 200;
    for (let i = 0; i < 21; i += 1) {
      const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("Fase 6 §2 (seguimiento) — POST .../caldav/test-connection", () => {
  it("sin conectar CalDAV -> 409", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(409);
  });

  it("conectado + comprobación en vivo exitosa -> 200 ok:true", async () => {
    const caldavPort = new FakeCalendarSyncPort("caldav");
    const ctx = await buildCitasTestContext(buildApp, { caldavPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalDavAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calendarCollectionUrl: "https://caldav.example.com/x/", username: "x@y.com", password: claveFicticia() });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("un 403 real del servidor CalDAV -> 422 credencial inválida, cuenta queda en error", async () => {
    const caldavPort = new FakeCalendarSyncPort("caldav");
    caldavPort.failNextCall = new CalDavApiError("prohibido", 403, "forbidden");
    const ctx = await buildCitasTestContext(buildApp, { caldavPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalDavAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calendarCollectionUrl: "https://caldav.example.com/x/", username: "x@y.com", password: claveFicticia("revocada") });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(422);
    const account = await ctx.citasRepo.findProviderCalDavAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("error");
  });

  it("el servidor CalDAV caído (503) -> 502, la cuenta no se toca", async () => {
    const caldavPort = new FakeCalendarSyncPort("caldav");
    caldavPort.failNextCall = new CalDavApiError("no disponible", 503, "service unavailable");
    const ctx = await buildCitasTestContext(buildApp, { caldavPort });
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.connectProviderCalDavAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calendarCollectionUrl: "https://caldav.example.com/x/", username: "x@y.com", password: claveFicticia() });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(502);
    const account = await ctx.citasRepo.findProviderCalDavAccount(ctx.providerId);
    expect(account?.syncStatus).toBe("connected");
  });

  it("sin JWT responde 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/test-connection`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("un staff que no pertenece a esta property recibe 403", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${crypto.randomUUID()}/providers/${ctx.providerId}/caldav/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(403);
  });
});
