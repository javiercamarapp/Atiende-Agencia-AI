import { describe, expect, it, vi } from "vitest";
import { createService, fetchServiceDetail, fetchServices, updateService } from "../src/verticals/citas/lib/services-client.ts";

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

// Fase 8 — alta/edición real de servicios.
describe("createService", () => {
  it("POST con el body real (snake_case) y mapea la respuesta", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/services");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ service: { ...SERVICE_ROW, id: "svc-2", name: "Limpieza dental" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await createService(fetchImpl, "http://api.local", "tok", "prop-1", { name: "Limpieza dental", durationMinutes: 45 });
    expect(result.name).toBe("Limpieza dental");
  });
});

describe("updateService", () => {
  it("PATCH con priceCents:null explícito envía null real (no lo descarta)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/services/svc-1");
      expect(init?.method).toBe("PATCH");
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      expect(body.price_cents).toBeNull();
      return new Response(JSON.stringify({ service: { ...SERVICE_ROW, price_cents: null } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await updateService(fetchImpl, "http://api.local", "tok", "prop-1", "svc-1", { priceCents: null });
    expect(result.priceCents).toBeNull();
  });
});
