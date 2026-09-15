import { describe, expect, it, vi } from "vitest";
import { DespachosAdminError, fetchBranches, fetchJson, postJson, resolveActivePropertyId } from "../src/verticals/despachos/lib/admin-client.ts";
import type { BranchOption } from "../src/verticals/despachos/lib/admin-client.ts";

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

  it("respuesta no-ok -> DespachosAdminError con el mensaje real del servidor", async () => {
    const fetchImpl = fakeFetch({ "/algo": { status: 403, body: { message: "No perteneces a esta organización." } } });
    await expect(fetchJson(fetchImpl, "http://api.local/algo", "tok")).rejects.toThrow(DespachosAdminError);
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
    const result = await postJson(fetchImpl, "http://api.local/periodos", "tok", { anio: 2026 });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/periodos",
      expect.objectContaining({ method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ anio: 2026 }) }),
    );
  });

  it("respuesta no-ok -> DespachosAdminError leyendo message o error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "conflict" }), { status: 409 })) as unknown as typeof fetch;
    await expect(postJson(fetchImpl, "http://api.local/periodos", "tok")).rejects.toThrow("conflict");
  });
});

describe("fetchBranches", () => {
  it("pide /v1/despachos/:orgSlug/admin/branches con el token y devuelve la lista", async () => {
    const branches = [{ propertyId: "p1", name: "Sede principal" }];
    const fetchImpl = fakeFetch({ "/admin/branches": { status: 200, body: { branches } } });
    const result = await fetchBranches(fetchImpl, "http://api.local", "tok", "despacho-de-prueba");
    expect(result).toEqual(branches);
    expect(fetchImpl).toHaveBeenCalledWith("http://api.local/v1/despachos/despacho-de-prueba/admin/branches", expect.objectContaining({ headers: { authorization: "Bearer tok" } }));
  });

  it("404 -> DespachosAdminError", async () => {
    const fetchImpl = fakeFetch({ "/admin/branches": { status: 404, body: { message: 'Negocio "x" no encontrado o inactivo.' } } });
    await expect(fetchBranches(fetchImpl, "http://api.local", "tok", "x")).rejects.toThrow(DespachosAdminError);
  });
});

// Hallazgo de auditoría (severidad ALTA, "un despacho solo puede operar UN
// contribuyente/cliente"): DespachosShell.tsx fijaba `branches[0]` sin importar el
// resto de la lista que este mismo endpoint (`fetchBranches`, arriba) ya traía
// completa. `resolveActivePropertyId` es la lógica pura que decide qué
// contribuyente queda activo dado lo que el selector de la UI tenga elegido --
// probada aquí sin depender de un DOM/React renderer (este repo corre vitest en
// `environment: "node"`, sin jsdom/testing-library, así que un test que monte
// <DespachosShell> y simule un click real en el <select> no es viable sin sumar
// esa infraestructura -- fuera de alcance de este hallazgo). Toda página hija
// (Cfdi/Declaraciones/Vencimientos/Cobranza/etc.) consume `ctx.propertyId`
// directo, sin cachear nada propio (ver sus useEffect/handlers), así que esta
// función es exactamente el mecanismo por el que cambiar la selección aquí
// cambia lo que CADA página pide.
describe("resolveActivePropertyId", () => {
  const contribuyenteA: BranchOption = { propertyId: "p1", name: "Contribuyente A" };
  const contribuyenteB: BranchOption = { propertyId: "p2", name: "Contribuyente B" };
  const branches: readonly BranchOption[] = [contribuyenteA, contribuyenteB];

  it("sin selección todavía (null) -> cae al primer contribuyente de la lista", () => {
    expect(resolveActivePropertyId(branches, null)).toBe("p1");
  });

  it("con un contribuyente distinto al primero seleccionado -> lo respeta (esto es lo que rompía el branches[0] fijo)", () => {
    expect(resolveActivePropertyId(branches, "p2")).toBe("p2");
  });

  it("selección obsoleta (propertyId que ya no está en la lista) -> cae al primero, no se queda colgado", () => {
    expect(resolveActivePropertyId(branches, "propertyId-que-ya-no-existe")).toBe("p1");
  });

  it("un solo contribuyente -> siempre ese, sin importar la selección", () => {
    expect(resolveActivePropertyId([contribuyenteA], null)).toBe("p1");
    expect(resolveActivePropertyId([contribuyenteA], "otro-id")).toBe("p1");
  });

  it("sin ningún contribuyente -> null (el Shell ya corta antes con su propio mensaje de error, pero la función no debe reventar)", () => {
    expect(resolveActivePropertyId([], "p1")).toBeNull();
  });
});
