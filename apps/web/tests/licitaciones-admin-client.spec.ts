import { describe, expect, it, vi } from "vitest";
import { LicitacionesAdminError, fetchBranches, fetchJson, fetchTenantConfig, postJson, putJson, updateTenantConfigTimezone } from "../src/verticals/licitaciones/lib/admin-client.ts";

function fakeFetch(byUrl: Record<string, { status: number; body: unknown }>): typeof fetch {
  return vi.fn(async (input: string) => {
    const match = Object.entries(byUrl).find(([key]) => input.includes(key));
    if (!match) throw new Error(`fakeFetch: URL no esperada en el test: ${input}`);
    const [, { status, body }] = match;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("fetchJson", () => {
  it("manda el Bearer token y devuelve el JSON tal cual", async () => {
    const fetchImpl = fakeFetch({ "/algo": { status: 200, body: { ok: true } } });
    const result = await fetchJson(fetchImpl, "http://api.local/algo", "tok");
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith("http://api.local/algo", { headers: { authorization: "Bearer tok" } });
  });

  it("respuesta no-ok -> LicitacionesAdminError con el mensaje real del servidor", async () => {
    const fetchImpl = fakeFetch({ "/algo": { status: 403, body: { message: "No perteneces a esta organización." } } });
    await expect(fetchJson(fetchImpl, "http://api.local/algo", "tok")).rejects.toThrow(LicitacionesAdminError);
    await expect(fetchJson(fetchImpl, "http://api.local/algo", "tok")).rejects.toThrow("No perteneces a esta organización.");
  });

  it("respuesta no-ok sin body JSON -> mensaje genérico con status", async () => {
    const fetchImpl = vi.fn(async () => new Response("no soy json", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchJson(fetchImpl, "http://api.local/algo", "tok")).rejects.toThrow("(500)");
  });
});

describe("postJson", () => {
  it("manda POST con content-type json y el body serializado", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const result = await postJson(fetchImpl, "http://api.local/tenders", "tok", { title: "X" });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/tenders",
      expect.objectContaining({ method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ title: "X" }) }),
    );
  });

  it("respuesta no-ok -> LicitacionesAdminError leyendo message o error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "conflict" }), { status: 409 })) as unknown as typeof fetch;
    await expect(postJson(fetchImpl, "http://api.local/tenders", "tok")).rejects.toThrow("conflict");
  });

  it("acepta headers extra (idempotency-key, etc.)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await postJson(fetchImpl, "http://api.local/x", "tok", { a: 1 }, { "idempotency-key": "k1" });
    expect(fetchImpl).toHaveBeenCalledWith("http://api.local/x", expect.objectContaining({ headers: expect.objectContaining({ "idempotency-key": "k1" }) }));
  });
});

describe("putJson", () => {
  it("manda PUT con content-type json y el body serializado", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const result = await putJson(fetchImpl, "http://api.local/matching-profile", "tok", { keywords: ["x"] });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/matching-profile",
      expect.objectContaining({ method: "PUT", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ keywords: ["x"] }) }),
    );
  });

  it("respuesta no-ok -> LicitacionesAdminError leyendo message o error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso." }), { status: 403 })) as unknown as typeof fetch;
    await expect(putJson(fetchImpl, "http://api.local/matching-profile", "tok", {})).rejects.toThrow("No tienes permiso.");
  });
});

describe("fetchBranches", () => {
  it("pide /v1/licitaciones/:orgSlug/admin/branches con el token y devuelve la lista", async () => {
    const branches = [{ propertyId: "p1", name: "Sede principal" }];
    const fetchImpl = fakeFetch({ "/admin/branches": { status: 200, body: { branches } } });
    const result = await fetchBranches(fetchImpl, "http://api.local", "tok", "empresa-de-prueba");
    expect(result).toEqual(branches);
    expect(fetchImpl).toHaveBeenCalledWith("http://api.local/v1/licitaciones/empresa-de-prueba/admin/branches", expect.objectContaining({ headers: { authorization: "Bearer tok" } }));
  });

  it("404 -> LicitacionesAdminError", async () => {
    const fetchImpl = fakeFetch({ "/admin/branches": { status: 404, body: { message: 'Negocio "x" no encontrado o inactivo.' } } });
    await expect(fetchBranches(fetchImpl, "http://api.local", "tok", "x")).rejects.toThrow(LicitacionesAdminError);
  });
});

// FASE 3 (producto) — zona horaria por negocio: GET/PATCH .../admin/tenant-config.
describe("fetchTenantConfig / updateTenantConfigTimezone", () => {
  it("fetchTenantConfig pide GET .../admin/tenant-config y devuelve {organizationId, timezone} camelCase", async () => {
    const fetchImpl = fakeFetch({ "/admin/tenant-config": { status: 200, body: { tenant_config: { organization_id: "org-1", timezone: "America/Tijuana" } } } });
    const result = await fetchTenantConfig(fetchImpl, "http://api.local", "tok", "empresa-de-prueba");
    expect(result).toEqual({ organizationId: "org-1", timezone: "America/Tijuana" });
    expect(fetchImpl).toHaveBeenCalledWith("http://api.local/v1/licitaciones/empresa-de-prueba/admin/tenant-config", expect.objectContaining({ headers: { authorization: "Bearer tok" } }));
  });

  it("fetchTenantConfig -- organización sin configurar todavía -- timezone: null (nunca un default inventado en el cliente)", async () => {
    const fetchImpl = fakeFetch({ "/admin/tenant-config": { status: 200, body: { tenant_config: { organization_id: "org-1", timezone: null } } } });
    const result = await fetchTenantConfig(fetchImpl, "http://api.local", "tok", "empresa-de-prueba");
    expect(result.timezone).toBeNull();
  });

  it("updateTenantConfigTimezone manda PATCH con {timezone} y devuelve el valor guardado", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tenant_config: { organization_id: "org-1", timezone: "America/Cancun" } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const result = await updateTenantConfigTimezone(fetchImpl, "http://api.local", "tok", "empresa-de-prueba", "America/Cancun");
    expect(result).toEqual({ organizationId: "org-1", timezone: "America/Cancun" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/v1/licitaciones/empresa-de-prueba/admin/tenant-config",
      expect.objectContaining({ method: "PATCH", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ timezone: "America/Cancun" }) }),
    );
  });

  it("updateTenantConfigTimezone con timezone=null manda {timezone: null} -- borra la configuración", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tenant_config: { organization_id: "org-1", timezone: null } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await updateTenantConfigTimezone(fetchImpl, "http://api.local", "tok", "empresa-de-prueba", null);
    expect(fetchImpl).toHaveBeenCalledWith("http://api.local/v1/licitaciones/empresa-de-prueba/admin/tenant-config", expect.objectContaining({ body: JSON.stringify({ timezone: null }) }));
  });

  it("respuesta 403 (rol insuficiente) -> LicitacionesAdminError con el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Solo el owner o un admin de la organización puede editar la zona horaria." }), { status: 403 })) as unknown as typeof fetch;
    await expect(updateTenantConfigTimezone(fetchImpl, "http://api.local", "tok", "empresa-de-prueba", "America/Tijuana")).rejects.toThrow("Solo el owner o un admin");
  });
});
