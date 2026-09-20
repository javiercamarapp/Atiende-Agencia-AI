import { describe, expect, it, vi } from "vitest";
import { fetchAuditoria } from "../src/verticals/citas/lib/auditoria-client.ts";

describe("fetchAuditoria (citas)", () => {
  it("pide GET .../admin/auditoria sin ningún filtro cuando no se pasa ninguno", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/property-1/admin/auditoria");
      return new Response(JSON.stringify({ disponible: true, total: 0, nextOffset: null, items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchAuditoria(fetchImpl, "http://api.local", "tok", "property-1");
    expect(result).toEqual({ disponible: true, total: 0, nextOffset: null, items: [] });
  });

  it("arma el query string con tipo/desde/hasta/limit/offset cuando vienen presentes", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/citas/properties/property-1/admin/auditoria");
      expect(parsed.searchParams.get("tipo")).toBe("servicio");
      expect(parsed.searchParams.get("desde")).toBe("2026-01-01");
      expect(parsed.searchParams.get("hasta")).toBe("2026-01-31");
      expect(parsed.searchParams.get("limit")).toBe("25");
      expect(parsed.searchParams.get("offset")).toBe("25");
      return new Response(JSON.stringify({ disponible: true, total: 1, nextOffset: null, items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchAuditoria(fetchImpl, "http://api.local", "tok", "property-1", { tipo: "servicio", desde: "2026-01-01", hasta: "2026-01-31", limit: 25, offset: 25 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("disponible:false (base sin migrar) se propaga tal cual, nunca se confunde con una lista vacía", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ disponible: false, total: 0, nextOffset: null, items: [] }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchAuditoria(fetchImpl, "http://api.local", "tok", "property-1");
    expect(result.disponible).toBe(false);
  });

  it("un 403 real del servidor se propaga como error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Tu rol (staff) no puede leer la bitácora de auditoría." }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchAuditoria(fetchImpl, "http://api.local", "tok", "property-1")).rejects.toThrow(/rol/);
  });
});
