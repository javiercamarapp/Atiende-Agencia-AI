import { describe, expect, it, vi } from "vitest";
import { fetchServiceDetail, fetchServices } from "../src/verticals/citas/lib/services-client.ts";

const SERVICE_ROW = { id: "svc-1", name: "Consulta general", duration_minutes: 30, buffer_minutes_before: 0, buffer_minutes_after: 5, price_cents: 50000, is_active: true };

describe("fetchServices", () => {
  it("mapea la lista real de servicios", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/services");
      return new Response(JSON.stringify({ services: [SERVICE_ROW] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchServices(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([{ id: "svc-1", name: "Consulta general", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 5, priceCents: 50000, isActive: true }]);
  });
});

describe("fetchServiceDetail", () => {
  it("mapea la ficha de un servicio, incluyendo precio null (honesto)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ service: { ...SERVICE_ROW, price_cents: null } }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchServiceDetail(fetchImpl, "http://api.local", "tok", "prop-1", "svc-1");
    expect(result.priceCents).toBeNull();
  });

  it("404 -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Servicio no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchServiceDetail(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe")).rejects.toThrow("Servicio no encontrado.");
  });
});
