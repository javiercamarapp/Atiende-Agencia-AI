// FASE 3 (producto) — cliente real de admin-config.ts::GET/PATCH
// .../admin/config/zona-horaria. Mismo patrón exacto que
// restaurantes-config-client.spec.ts (whatsapp/zonas conocidas).
import { describe, expect, it, vi } from "vitest";
import { fetchBranchTimezone, updateBranchTimezone } from "../src/verticals/restaurantes/lib/config-client.ts";

describe("fetchBranchTimezone / updateBranchTimezone", () => {
  it("GET real -- sin configurar todavía devuelve zonaHoraria null", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/config/zona-horaria");
      return new Response(JSON.stringify({ zonaHoraria: null }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchBranchTimezone(fetchImpl, "http://api.local", "tok", "prop-1")).resolves.toEqual({ zonaHoraria: null });
  });

  it("PATCH real -- configura una zona", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/config/zona-horaria");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ zona_horaria: "America/Cancun" });
      return new Response(JSON.stringify({ zonaHoraria: "America/Cancun" }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(updateBranchTimezone(fetchImpl, "http://api.local", "tok", "prop-1", "America/Cancun")).resolves.toEqual({ zonaHoraria: "America/Cancun" });
  });

  it("PATCH con null -- borra la configuración explícita", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ zona_horaria: null });
      return new Response(JSON.stringify({ zonaHoraria: null }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(updateBranchTimezone(fetchImpl, "http://api.local", "tok", "prop-1", null)).resolves.toEqual({ zonaHoraria: null });
  });

  it("staff fuera de owner/admin (403) -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(updateBranchTimezone(fetchImpl, "http://api.local", "tok", "prop-1", "America/Cancun")).rejects.toThrow();
  });
});
