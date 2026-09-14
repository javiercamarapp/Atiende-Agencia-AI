import { describe, expect, it, vi } from "vitest";
import { createProvider, fetchProviderDetail, fetchProviders, requestGoogleCalendarConnectUrl, setProviderServiceOffering, updateProvider } from "../src/verticals/citas/lib/providers-client.ts";

describe("fetchProviders", () => {
  it("mapea la lista real de proveedores", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers");
      return new Response(JSON.stringify({ providers: [{ id: "prov-1", property_id: null, display_name: "Dra. Fernanda López", role_label: "Dentista", is_active: true }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchProviders(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([{ id: "prov-1", propertyId: null, displayName: "Dra. Fernanda López", roleLabel: "Dentista", isActive: true }]);
  });
});

describe("fetchProviderDetail", () => {
  it("mapea proveedor + reglas de disponibilidad + estado de Google Calendar", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          provider: { id: "prov-1", property_id: null, display_name: "Dra. Fernanda López", role_label: "Dentista", is_active: true },
          availability_rules: [{ id: "r1", day_of_week: 1, start_time: "09:00:00", end_time: "17:00:00", is_active: true }],
          google_calendar: { connected: false, sync_status: "disconnected", sync_error: null },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await fetchProviderDetail(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1");
    expect(result.provider.displayName).toBe("Dra. Fernanda López");
    expect(result.availabilityRules).toEqual([{ id: "r1", dayOfWeek: 1, startTime: "09:00:00", endTime: "17:00:00", isActive: true }]);
    expect(result.googleCalendar).toEqual({ connected: false, syncStatus: "disconnected", syncError: null });
  });

  it("404 -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Proveedor no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchProviderDetail(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe")).rejects.toThrow("Proveedor no encontrado.");
  });
});

describe("requestGoogleCalendarConnectUrl", () => {
  it("devuelve la authorize_url real", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/google-calendar/connect");
      return new Response(JSON.stringify({ authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" }), { status: 200 });
    }) as unknown as typeof fetch;

    const url = await requestGoogleCalendarConnectUrl(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1");
    expect(url).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
  });

  it("503 cuando Google no está configurado en la plataforma -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Google Calendar no está configurado en esta plataforma todavía." }), { status: 503 })) as unknown as typeof fetch;
    await expect(requestGoogleCalendarConnectUrl(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1")).rejects.toThrow("Google Calendar no está configurado");
  });
});

// Fase 8 — alta/edición real de proveedores + checkbox de provider_services.
describe("createProvider", () => {
  it("POST con el body real (snake_case) y mapea la respuesta", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ display_name: "Dr. Juan Pérez", role_label: undefined, property_id: undefined, is_active: undefined });
      return new Response(JSON.stringify({ provider: { id: "prov-2", property_id: null, display_name: "Dr. Juan Pérez", role_label: "Proveedor", is_active: true } }), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await createProvider(fetchImpl, "http://api.local", "tok", "prop-1", { displayName: "Dr. Juan Pérez" });
    expect(result).toEqual({ id: "prov-2", propertyId: null, displayName: "Dr. Juan Pérez", roleLabel: "Proveedor", isActive: true });
  });

  it("400 -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "display_name: se esperaba un texto no vacío." }), { status: 400 })) as unknown as typeof fetch;
    await expect(createProvider(fetchImpl, "http://api.local", "tok", "prop-1", { displayName: "" })).rejects.toThrow("display_name");
  });
});

describe("updateProvider", () => {
  it("PATCH con el body real y mapea la respuesta", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1");
      expect(init?.method).toBe("PATCH");
      return new Response(JSON.stringify({ provider: { id: "prov-1", property_id: null, display_name: "Dra. Fernanda López", role_label: "Odontóloga en jefe", is_active: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await updateProvider(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1", { roleLabel: "Odontóloga en jefe" });
    expect(result.roleLabel).toBe("Odontóloga en jefe");
  });
});

describe("setProviderServiceOffering", () => {
  it("PUT con {offered} real", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/services/serv-1");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body as string)).toEqual({ offered: false });
      return new Response(JSON.stringify({ provider_id: "prov-1", service_id: "serv-1", offered: false }), { status: 200 });
    }) as unknown as typeof fetch;

    await setProviderServiceOffering(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1", "serv-1", false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
