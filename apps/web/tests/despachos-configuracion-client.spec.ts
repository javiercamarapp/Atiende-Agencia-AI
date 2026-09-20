// FASE 3 (producto) — cliente real de configuracion.ts::GET/PATCH
// .../configuracion (zona horaria por negocio). Mismo patrón exacto que
// despachos-admin-client.spec.ts.
import { describe, expect, it, vi } from "vitest";
import { fetchConfiguracion, updateConfiguracion } from "../src/verticals/despachos/lib/configuracion-client.ts";

describe("fetchConfiguracion / updateConfiguracion", () => {
  it("GET real -- sin configurar todavía devuelve zonaHoraria null", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/configuracion");
      return new Response(JSON.stringify({ configuracion: { propertyId: "prop-1", organizationId: "org-1", zonaHoraria: null } }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchConfiguracion(fetchImpl, "http://api.local", "tok", "prop-1")).resolves.toEqual({ propertyId: "prop-1", organizationId: "org-1", zonaHoraria: null });
  });

  it("PATCH real -- configura una zona", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/configuracion");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ zona_horaria: "America/Chihuahua" });
      return new Response(JSON.stringify({ configuracion: { propertyId: "prop-1", organizationId: "org-1", zonaHoraria: "America/Chihuahua" } }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(updateConfiguracion(fetchImpl, "http://api.local", "tok", "prop-1", "America/Chihuahua")).resolves.toEqual({
      propertyId: "prop-1",
      organizationId: "org-1",
      zonaHoraria: "America/Chihuahua",
    });
  });

  it("contador/auditor/readonly (403) -> error real, nunca escribe", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(updateConfiguracion(fetchImpl, "http://api.local", "tok", "prop-1", "America/Chihuahua")).rejects.toThrow();
  });
});
