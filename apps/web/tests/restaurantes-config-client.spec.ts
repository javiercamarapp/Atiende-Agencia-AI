// FASE 3 (producto) — cliente real de admin-config.ts (GET/PUT config de
// WhatsApp, GET/POST/DELETE zonas conocidas). Mismo patrón exacto que
// restaurantes-staff-client.spec.ts.
import { describe, expect, it, vi } from "vitest";
import { createKnownZone, deleteKnownZone, fetchKnownZones, fetchWhatsappConfig, updateWhatsappConfig } from "../src/verticals/restaurantes/lib/config-client.ts";

describe("fetchWhatsappConfig / updateWhatsappConfig", () => {
  it("GET real -- sin configurar todavía devuelve phoneNumberId null", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/config/whatsapp");
      return new Response(JSON.stringify({ phoneNumberId: null }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchWhatsappConfig(fetchImpl, "http://api.local", "tok", "prop-1")).resolves.toEqual({ phoneNumberId: null });
  });

  it("PUT real -- conecta un número", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/config/whatsapp");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body as string)).toEqual({ phoneNumberId: "15550001111" });
      return new Response(JSON.stringify({ phoneNumberId: "15550001111" }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(updateWhatsappConfig(fetchImpl, "http://api.local", "tok", "prop-1", "15550001111")).resolves.toEqual({ phoneNumberId: "15550001111" });
  });

  it("staff fuera de owner/admin (403) -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(updateWhatsappConfig(fetchImpl, "http://api.local", "tok", "prop-1", "15550001111")).rejects.toThrow();
  });
});

describe("fetchKnownZones / createKnownZone / deleteKnownZone", () => {
  it("GET real -- lista de zonas", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/config/zonas");
      return new Response(JSON.stringify({ zonas: [{ id: "zone-1", name: "Altabrisa", lat: 21.06, lng: -89.62, createdAt: "2026-09-20T00:00:00.000Z" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchKnownZones(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "zone-1", name: "Altabrisa" });
  });

  it("POST real -- crea una zona", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/config/zonas");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ name: "Altabrisa", lat: 21.06, lng: -89.62 });
      return new Response(JSON.stringify({ id: "zone-1", name: "Altabrisa", lat: 21.06, lng: -89.62, createdAt: "2026-09-20T00:00:00.000Z" }), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await createKnownZone(fetchImpl, "http://api.local", "tok", "prop-1", { name: "Altabrisa", lat: 21.06, lng: -89.62 });
    expect(result.id).toBe("zone-1");
  });

  it("DELETE real -- borra una zona", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/config/zonas/zone-1");
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(deleteKnownZone(fetchImpl, "http://api.local", "tok", "prop-1", "zone-1")).resolves.toBeUndefined();
  });

  it("zona inexistente (404) -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Esa zona conocida no existe, o pertenece a otra organización." }), { status: 404 })) as unknown as typeof fetch;
    await expect(deleteKnownZone(fetchImpl, "http://api.local", "tok", "prop-1", "zone-nope")).rejects.toThrow();
  });
});
