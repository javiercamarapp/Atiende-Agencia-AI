import { describe, expect, it, vi } from "vitest";
import { fetchProperties, resolveActivePropertyId } from "../src/verticals/hoteles/lib/discovery-client.ts";
import type { PropertyOption } from "../src/verticals/hoteles/lib/discovery-client.ts";

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

// Hallazgo de auditoría (severidad ALTA, "cadena con 2+ hoteles solo opera el
// primero"): HotelesShell.tsx (~línea 191-194) fijaba `propertyId` a
// `properties[0]` sin selector ni persistencia -- MISMO hallazgo/mismo remedio que
// `resolveActivePropertyId` de despachos (apps/web/tests/despachos-admin-client.spec.ts),
// leído primero como plantilla. Probada aquí sin depender de un DOM/React renderer
// (este repo corre vitest en `environment: "node"`, sin jsdom/testing-library).
describe("resolveActivePropertyId", () => {
  const hotelCentro: PropertyOption = { propertyId: "p1", nombre: "Hotel Centro" };
  const hotelPlaya: PropertyOption = { propertyId: "p2", nombre: "Hotel Playa" };
  const properties: readonly PropertyOption[] = [hotelCentro, hotelPlaya];

  it("sin selección todavía (null) -> cae al primer hotel de la lista", () => {
    expect(resolveActivePropertyId(properties, null)).toBe("p1");
  });

  it("con un hotel distinto al primero seleccionado -> lo respeta (esto es lo que rompía el properties[0] fijo)", () => {
    expect(resolveActivePropertyId(properties, "p2")).toBe("p2");
  });

  it("selección obsoleta (propertyId que ya no está en la lista) -> cae al primero, no se queda colgado", () => {
    expect(resolveActivePropertyId(properties, "propertyId-que-ya-no-existe")).toBe("p1");
  });

  it("un solo hotel -> siempre ese, sin importar la selección", () => {
    expect(resolveActivePropertyId([hotelCentro], null)).toBe("p1");
    expect(resolveActivePropertyId([hotelCentro], "otro-id")).toBe("p1");
  });

  it("sin ningún hotel -> null (el Shell ya corta antes con su propio mensaje de error, pero la función no debe reventar)", () => {
    expect(resolveActivePropertyId([], "p1")).toBeNull();
  });
});
