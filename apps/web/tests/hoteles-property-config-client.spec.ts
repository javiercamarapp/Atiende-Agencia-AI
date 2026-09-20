import { describe, expect, it, vi } from "vitest";
import { fetchPropertyConfig, updatePropertyTimezone } from "../src/verticals/hoteles/lib/property-config-client.ts";

describe("fetchPropertyConfig", () => {
  it("pide GET /hoteles/:propertyId/configuracion", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/configuracion");
      return new Response(JSON.stringify({ timezone: null, timezonePorDefecto: "America/Mexico_City", timezoneEfectiva: "America/Mexico_City" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchPropertyConfig(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual({ timezone: null, timezonePorDefecto: "America/Mexico_City", timezoneEfectiva: "America/Mexico_City" });
  });
});

describe("updatePropertyTimezone", () => {
  it("hace PUT real con el timezone elegido", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/configuracion");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body as string)).toEqual({ timezone: "America/Cancun" });
      return new Response(JSON.stringify({ timezone: "America/Cancun", timezonePorDefecto: "America/Mexico_City", timezoneEfectiva: "America/Cancun" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await updatePropertyTimezone(fetchImpl, "http://api.local", "tok", "prop-1", "America/Cancun");
    expect(result.timezoneEfectiva).toBe("America/Cancun");
  });

  it("timezone: null se envía tal cual (limpia la configuración)", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ timezone: null });
      return new Response(JSON.stringify({ timezone: null, timezonePorDefecto: "America/Mexico_City", timezoneEfectiva: "America/Mexico_City" }), { status: 200 });
    }) as unknown as typeof fetch;
    await updatePropertyTimezone(fetchImpl, "http://api.local", "tok", "prop-1", null);
  });

  it("rol insuficiente -> error real (403 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(updatePropertyTimezone(fetchImpl, "http://api.local", "tok", "prop-1", "America/Cancun")).rejects.toThrow(/permiso/);
  });
});
