import { describe, expect, it, vi } from "vitest";
import { LicitacionesAdminError, fetchBranches, fetchJson, postJson } from "../src/verticals/licitaciones/lib/admin-client.ts";

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
