import { describe, expect, it, vi } from "vitest";
import { CitasAdminError, fetchBranches, fetchJson, postJson, resolveActivePropertyId } from "../src/verticals/citas/lib/admin-client.ts";
import type { BranchOption } from "../src/verticals/citas/lib/admin-client.ts";

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

  it("respuesta no-ok -> CitasAdminError con el mensaje real del servidor", async () => {
    const fetchImpl = fakeFetch({ "/algo": { status: 403, body: { message: "No perteneces a esta organización." } } });
    await expect(fetchJson(fetchImpl, "http://api.local/algo", "tok")).rejects.toThrow(CitasAdminError);
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
    const result = await postJson(fetchImpl, "http://api.local/cancel", "tok", { a: 1 });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/cancel",
      expect.objectContaining({ method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) }),
    );
  });

  it("respuesta no-ok -> CitasAdminError leyendo message o error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "conflict" }), { status: 409 })) as unknown as typeof fetch;
    await expect(postJson(fetchImpl, "http://api.local/cancel", "tok")).rejects.toThrow("conflict");
  });
});

describe("fetchBranches", () => {
  it("pide /admin/branches con el token y devuelve la lista", async () => {
    const branches = [{ propertyId: "p1", name: "Sucursal principal" }];
    const fetchImpl = fakeFetch({ "/admin/branches": { status: 200, body: { branches } } });
    const result = await fetchBranches(fetchImpl, "http://api.local", "tok", "clinica-dental-sonrisas");
    expect(result).toEqual(branches);
    expect(fetchImpl).toHaveBeenCalledWith("http://api.local/v1/citas/clinica-dental-sonrisas/admin/branches", expect.objectContaining({ headers: { authorization: "Bearer tok" } }));
  });

  it("404 -> CitasAdminError", async () => {
    const fetchImpl = fakeFetch({ "/admin/branches": { status: 404, body: { message: 'Negocio "x" no encontrado o inactivo.' } } });
    await expect(fetchBranches(fetchImpl, "http://api.local", "tok", "x")).rejects.toThrow(CitasAdminError);
  });
});

// Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA, "negocio de
// citas con 2+ sucursales solo opera la primera"): CitasShell.tsx fijaba
// `propertyId` a `branches[0]!.propertyId` siempre — mismo patrón (y misma función
// pura) que ya resolvió esto en hoteles/despachos/rentas/restaurantes, ver
// `resolveActivePropertyId` de hoteles/lib/discovery-client.ts (leído primero como
// plantilla).
describe("resolveActivePropertyId", () => {
  const principal: BranchOption = { propertyId: "p1", name: "Sucursal principal" };
  const norte: BranchOption = { propertyId: "p2", name: "Sucursal norte" };
  const branches: readonly BranchOption[] = [principal, norte];

  it("sin selección todavía (null) -> cae a la primera sucursal de la lista", () => {
    expect(resolveActivePropertyId(branches, null)).toBe("p1");
  });

  it("con una sucursal distinta a la primera seleccionada -> la respeta (esto es lo que rompía el branches[0] fijo)", () => {
    expect(resolveActivePropertyId(branches, "p2")).toBe("p2");
  });

  it("selección obsoleta (propertyId que ya no está en la lista) -> cae a la primera, no se queda colgado", () => {
    expect(resolveActivePropertyId(branches, "propertyId-que-ya-no-existe")).toBe("p1");
  });

  it("una sola sucursal -> siempre esa, sin importar la selección", () => {
    expect(resolveActivePropertyId([principal], null)).toBe("p1");
    expect(resolveActivePropertyId([principal], "otro-id")).toBe("p1");
  });

  it("sin ninguna sucursal -> null (el Shell ya corta antes con su propio mensaje de error, pero la función no debe reventar)", () => {
    expect(resolveActivePropertyId([], "p1")).toBeNull();
  });
});
