// Fase 8 — lectura/edición real de citas.tenant_config desde el panel.
import { describe, expect, it, vi } from "vitest";
import { fetchTenantConfig, RUBRO_OPTIONS, updateTenantConfig } from "../src/verticals/citas/lib/tenant-config-client.ts";

describe("fetchTenantConfig", () => {
  it("mapea la fila real", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/tenant-config");
      return new Response(JSON.stringify({ tenant_config: { organization_id: "org-1", rubro: "dental", default_timezone: "America/Merida", owner_notification_phone: "5599998888" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchTenantConfig(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual({ rubro: "dental", defaultTimezone: "America/Merida", ownerNotificationPhone: "5599998888" });
  });
});

describe("updateTenantConfig", () => {
  it("PATCH con el body real (snake_case) y mapea la respuesta", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/tenant-config");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ rubro: "psicologo", default_timezone: undefined, owner_notification_phone: undefined });
      return new Response(JSON.stringify({ tenant_config: { organization_id: "org-1", rubro: "psicologo", default_timezone: "America/Mexico_City", owner_notification_phone: null } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await updateTenantConfig(fetchImpl, "http://api.local", "tok", "prop-1", { rubro: "psicologo" });
    expect(result.rubro).toBe("psicologo");
  });

  it("400 si el rubro no es válido -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "rubro: se esperaba uno de medico, dental, ..." }), { status: 400 })) as unknown as typeof fetch;
    await expect(updateTenantConfig(fetchImpl, "http://api.local", "tok", "prop-1", { rubro: "inventado" })).rejects.toThrow("rubro");
  });
});

describe("RUBRO_OPTIONS", () => {
  it("trae los 14 rubros reales de ALL_VERTICALS (vertical-config.ts)", () => {
    expect(RUBRO_OPTIONS).toHaveLength(14);
    expect(RUBRO_OPTIONS.map((o) => o.value)).toContain("otro");
  });
});
