import { describe, expect, it, vi } from "vitest";
import {
  connectCalCom,
  connectCalDav,
  createProvider,
  disconnectCalCom,
  disconnectCalDav,
  fetchCalComStatus,
  fetchCalDavStatus,
  fetchProviderDetail,
  fetchProviders,
  requestGoogleCalendarConnectUrl,
  setProviderServiceOffering,
  testCalComConnection,
  testCalDavConnection,
  updateProvider,
} from "../src/verticals/citas/lib/providers-client.ts";

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
  it("mapea proveedor + reglas de disponibilidad + estado de Google Calendar/Cal.com/CalDAV", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          provider: { id: "prov-1", property_id: null, display_name: "Dra. Fernanda López", role_label: "Dentista", is_active: true },
          availability_rules: [{ id: "r1", day_of_week: 1, start_time: "09:00:00", end_time: "17:00:00", is_active: true }],
          google_calendar: { connected: false, sync_status: "disconnected", sync_error: null },
          calcom: { connected: false, sync_status: "disconnected", sync_error: null, calcom_event_type_id: null, calcom_base_url: null },
          caldav: { connected: false, sync_status: "disconnected", sync_error: null, calendar_collection_url: null, username: null },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await fetchProviderDetail(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1");
    expect(result.provider.displayName).toBe("Dra. Fernanda López");
    expect(result.availabilityRules).toEqual([{ id: "r1", dayOfWeek: 1, startTime: "09:00:00", endTime: "17:00:00", isActive: true }]);
    expect(result.googleCalendar).toEqual({ connected: false, syncStatus: "disconnected", syncError: null });
    expect(result.calcom).toEqual({ connected: false, syncStatus: "disconnected", syncError: null, eventTypeId: null, baseUrl: null });
    expect(result.caldav).toEqual({ connected: false, syncStatus: "disconnected", syncError: null, calendarCollectionUrl: null, username: null });
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

// Fase 6 §2 (seguimiento) — Cal.com/CalDAV: conectar/desconectar/estado/prueba de
// conexión, mismo patrón de prueba (fetch inyectado, sin red real) que el resto
// de este archivo.
describe("connectCalCom", () => {
  it("POST con api_key/event_type_id (sin base_url) y mapea la respuesta, sin exponer el api_key", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/calcom/connect");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ api_key: "llave-ficticia-123", event_type_id: "555" });
      return new Response(JSON.stringify({ connected: true, provider_id: "prov-1", calcom_event_type_id: "555", calcom_base_url: null, sync_status: "connected" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await connectCalCom(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1", { apiKey: "llave-ficticia-123", eventTypeId: "555" });
    expect(result).toEqual({ connected: true, syncStatus: "connected", syncError: null, eventTypeId: "555", baseUrl: null });
  });

  it("con base_url (self-hosted) lo manda en el body y lo mapea de vuelta", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ api_key: "llave-ficticia-123", event_type_id: "555", base_url: "https://calcom.miempresa.example/v2" });
      return new Response(JSON.stringify({ connected: true, provider_id: "prov-1", calcom_event_type_id: "555", calcom_base_url: "https://calcom.miempresa.example/v2", sync_status: "connected" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await connectCalCom(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1", { apiKey: "llave-ficticia-123", eventTypeId: "555", baseUrl: "https://calcom.miempresa.example/v2" });
    expect(result.baseUrl).toBe("https://calcom.miempresa.example/v2");
  });

  it("400 (URL bloqueada por SSRF) -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'base_url no es una URL permitida ("169.254.169.254" resuelve a metadata de nube).' }), { status: 400 })) as unknown as typeof fetch;
    await expect(connectCalCom(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1", { apiKey: "x", eventTypeId: "1", baseUrl: "https://169.254.169.254/v2" })).rejects.toThrow("metadata de nube");
  });
});

describe("disconnectCalCom / fetchCalComStatus / testCalComConnection", () => {
  it("disconnectCalCom hace POST sin body real relevante", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/calcom/disconnect");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ connected: false }), { status: 200 });
    }) as unknown as typeof fetch;
    await disconnectCalCom(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetchCalComStatus mapea la respuesta y nunca ve un api_key en el body", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/calcom/status");
      return new Response(JSON.stringify({ connected: true, sync_status: "error", sync_error: "401 unauthorized", calcom_event_type_id: "555", calcom_base_url: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCalComStatus(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1");
    expect(result).toEqual({ connected: true, syncStatus: "error", syncError: "401 unauthorized", eventTypeId: "555", baseUrl: null });
  });

  it("testCalComConnection hace POST y mapea ok/checked_at", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/calcom/test-connection");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ ok: true, checked_at: "2026-09-19T12:00:00.000Z" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await testCalComConnection(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1");
    expect(result).toEqual({ ok: true, checkedAt: "2026-09-19T12:00:00.000Z" });
  });

  it("testCalComConnection ante un 422 (credencial inválida) propaga el error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "El proveedor rechazó la credencial guardada (401/403)." }), { status: 422 })) as unknown as typeof fetch;
    await expect(testCalComConnection(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1")).rejects.toThrow("rechazó la credencial");
  });

  it("testCalComConnection ante un 502 (proveedor caído) propaga el error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "El proveedor respondió con un error de servidor (500)." }), { status: 502 })) as unknown as typeof fetch;
    await expect(testCalComConnection(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1")).rejects.toThrow("error de servidor");
  });
});

describe("connectCalDav / disconnectCalDav / fetchCalDavStatus / testCalDavConnection", () => {
  it("connectCalDav hace POST con calendar_collection_url/username/password reales", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/caldav/connect");
      expect(JSON.parse(init!.body as string)).toEqual({ calendar_collection_url: "https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/", username: "x@y.com", password: "clave-ficticia-real" });
      return new Response(JSON.stringify({ connected: true, provider_id: "prov-1", calendar_collection_url: "https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/", username: "x@y.com", sync_status: "connected" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await connectCalDav(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1", { calendarCollectionUrl: "https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/", username: "x@y.com", password: "clave-ficticia-real" });
    expect(result).toEqual({ connected: true, syncStatus: "connected", syncError: null, calendarCollectionUrl: "https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/", username: "x@y.com" });
  });

  it("una URL sin https:// (400 real) propaga el error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "calendar_collection_url debe ser una URL https:// real de tu colección de calendario." }), { status: 400 })) as unknown as typeof fetch;
    await expect(connectCalDav(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1", { calendarCollectionUrl: "http://x", username: "x", password: "y" })).rejects.toThrow("https://");
  });

  it("disconnectCalDav hace POST", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/caldav/disconnect");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ connected: false }), { status: 200 });
    }) as unknown as typeof fetch;
    await disconnectCalDav(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetchCalDavStatus mapea la respuesta, nunca ve la contraseña", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/caldav/status");
      return new Response(JSON.stringify({ connected: false, sync_status: "disconnected", sync_error: null, calendar_collection_url: null, username: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCalDavStatus(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1");
    expect(result).toEqual({ connected: false, syncStatus: "disconnected", syncError: null, calendarCollectionUrl: null, username: null });
  });

  it("testCalDavConnection hace POST y mapea ok/checked_at", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/providers/prov-1/caldav/test-connection");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ ok: true, checked_at: "2026-09-19T12:00:00.000Z" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await testCalDavConnection(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1");
    expect(result).toEqual({ ok: true, checkedAt: "2026-09-19T12:00:00.000Z" });
  });

  it("testCalDavConnection ante un 409 (nunca conectado) propaga el error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Este proveedor todavía no conectó CalDAV -- conéctalo antes de probar la conexión." }), { status: 409 })) as unknown as typeof fetch;
    await expect(testCalDavConnection(fetchImpl, "http://api.local", "tok", "prop-1", "prov-1")).rejects.toThrow("todavía no conectó");
  });
});
