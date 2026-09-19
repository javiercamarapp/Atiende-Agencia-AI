// Fase 6 §2 — HTTP real de conectar/desconectar Cal.com/CalDAV por proveedor
// (mismo patrón de prueba que citas-google-calendar.spec.ts): sin credenciales
// reales, solo el flujo HTTP completo (staff autenticado -> conecta -> queda
// 'connected' en el repo -> desconecta -> vuelve a 'disconnected').
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";

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
