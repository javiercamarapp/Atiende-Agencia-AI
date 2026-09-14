import { describe, expect, it, vi } from "vitest";
import { cancelAppointment, completeAppointment, confirmAppointment, fetchAppointments, markAppointmentNoShow } from "../src/verticals/citas/lib/appointments-client.ts";

const APPOINTMENT_ROW = {
  id: "apt-1",
  property_id: "prop-1",
  provider_id: "prov-1",
  service_id: "svc-1",
  customer_id: "cus-1",
  starts_at: "2026-09-14T16:00:00.000Z",
  ends_at: "2026-09-14T16:30:00.000Z",
  status: "pending",
  source: "web",
  notes: null,
  google_sync_status: "skipped",
  provider_name: "Dra. Fernanda López",
  service_name: "Consulta general",
  customer_name: "Ana Torres",
  customer_phone: "9991112233",
};

describe("fetchAppointments", () => {
  it("pide el rango con from/to y mapea las citas enriquecidas", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/v1/citas/properties/prop-1/appointments?from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-30T00%3A00%3A00.000Z");
      return new Response(JSON.stringify({ appointments: [APPOINTMENT_ROW] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchAppointments(fetchImpl, "http://api.local", "tok", "prop-1", { fromIso: "2026-09-01T00:00:00.000Z", toIso: "2026-09-30T00:00:00.000Z" });
    expect(result).toEqual([
      {
        id: "apt-1",
        propertyId: "prop-1",
        providerId: "prov-1",
        serviceId: "svc-1",
        customerId: "cus-1",
        startsAt: "2026-09-14T16:00:00.000Z",
        endsAt: "2026-09-14T16:30:00.000Z",
        status: "pending",
        source: "web",
        notes: null,
        googleSyncStatus: "skipped",
        providerName: "Dra. Fernanda López",
        serviceName: "Consulta general",
        customerName: "Ana Torres",
        customerPhone: "9991112233",
      },
    ]);
  });

  it("agrega provider_id a la query cuando se filtra por proveedor", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("provider_id=prov-1");
      return new Response(JSON.stringify({ appointments: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAppointments(fetchImpl, "http://api.local", "tok", "prop-1", { fromIso: "2026-09-01T00:00:00.000Z", toIso: "2026-09-30T00:00:00.000Z", providerId: "prov-1" });
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe("cancelAppointment", () => {
  it("hace POST a .../appointments/:id/cancel y mapea la respuesta (sin enriquecer)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/appointments/apt-1/cancel");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ appointment: { ...APPOINTMENT_ROW, status: "cancelled", provider_name: undefined, service_name: undefined, customer_name: undefined, customer_phone: undefined } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await cancelAppointment(fetchImpl, "http://api.local", "tok", "prop-1", "apt-1");
    expect(result.status).toBe("cancelled");
    expect(result.providerName).toBeNull();
  });

  it("un conflicto (409) propaga el error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "La cita ya está cancelada." }), { status: 409 })) as unknown as typeof fetch;
    await expect(cancelAppointment(fetchImpl, "http://api.local", "tok", "prop-1", "apt-1")).rejects.toThrow("La cita ya está cancelada.");
  });
});

// Fase 7 — mismo shape de respuesta ({ appointment }, sin enriquecer) que cancel.
describe("confirmAppointment / completeAppointment / markAppointmentNoShow", () => {
  it("confirmAppointment hace POST a .../confirm y mapea la respuesta", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/appointments/apt-1/confirm");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ appointment: { ...APPOINTMENT_ROW, status: "confirmed", provider_name: undefined, service_name: undefined, customer_name: undefined, customer_phone: undefined } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await confirmAppointment(fetchImpl, "http://api.local", "tok", "prop-1", "apt-1");
    expect(result.status).toBe("confirmed");
  });

  it("completeAppointment hace POST a .../complete y mapea la respuesta", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/appointments/apt-1/complete");
      return new Response(JSON.stringify({ appointment: { ...APPOINTMENT_ROW, status: "completed", provider_name: undefined, service_name: undefined, customer_name: undefined, customer_phone: undefined } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await completeAppointment(fetchImpl, "http://api.local", "tok", "prop-1", "apt-1");
    expect(result.status).toBe("completed");
  });

  it("markAppointmentNoShow hace POST a .../no-show y mapea la respuesta", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/appointments/apt-1/no-show");
      return new Response(JSON.stringify({ appointment: { ...APPOINTMENT_ROW, status: "no_show", provider_name: undefined, service_name: undefined, customer_name: undefined, customer_phone: undefined } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await markAppointmentNoShow(fetchImpl, "http://api.local", "tok", "prop-1", "apt-1");
    expect(result.status).toBe("no_show");
  });

  it("un conflicto (409) al completar propaga el error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No se puede completar una cita en estado 'cancelled'." }), { status: 409 })) as unknown as typeof fetch;
    await expect(completeAppointment(fetchImpl, "http://api.local", "tok", "prop-1", "apt-1")).rejects.toThrow("No se puede completar una cita en estado 'cancelled'.");
  });
});
