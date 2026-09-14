import { describe, expect, it, vi } from "vitest";
import { fetchProperties } from "../src/verticals/hoteles/lib/discovery-client.ts";

describe("fetchProperties", () => {
  it("pide GET /v1/hoteles/:orgSlug/admin/propiedades y regresa la lista", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/hoteles/hotel-de-prueba/admin/propiedades");
      return new Response(JSON.stringify({ propiedades: [{ propertyId: "p1", nombre: "Hotel Centro" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchProperties(fetchImpl, "http://api.local", "tok", "hotel-de-prueba");
    expect(result).toEqual([{ propertyId: "p1", nombre: "Hotel Centro" }]);
  });

  it("organización inexistente -> error real (404 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Organización de hoteles "no-existe" no encontrada.' }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchProperties(fetchImpl, "http://api.local", "tok", "no-existe")).rejects.toThrow(/no encontrada/i);
  });
});
