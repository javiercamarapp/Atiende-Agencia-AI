import { describe, expect, it, vi } from "vitest";
import { createPromotion, fetchPromotions, setPromotionActive, updatePromotion } from "../src/verticals/restaurantes/lib/promotions-client.ts";

const PROMOTION_ROW = {
  id: "promo-1",
  code: "BIENVENIDA10",
  name: "Bienvenida",
  description: null,
  type: "percentage" as const,
  value: 10,
  minOrderTotal: null,
  startsAt: null,
  endsAt: null,
  daysOfWeek: null,
  startTime: null,
  endTime: null,
  maxUses: null,
  timesUsed: 0,
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("fetchPromotions / createPromotion", () => {
  it("lista promociones reales", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/promotions");
      return new Response(JSON.stringify({ promotions: [PROMOTION_ROW] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchPromotions(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([PROMOTION_ROW]);
  });

  it("crea un código nuevo (POST)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/promotions");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ code: "VERANO20", name: "Verano", type: "percentage", value: 20 });
      return new Response(JSON.stringify({ promotion: { ...PROMOTION_ROW, id: "promo-2", code: "VERANO20", name: "Verano", value: 20 } }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createPromotion(fetchImpl, "http://api.local", "tok", "prop-1", { code: "VERANO20", name: "Verano", type: "percentage", value: 20 });
    expect(result.id).toBe("promo-2");
  });

  it("propaga el mensaje real del servidor en un código duplicado (422)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Ya existe una promoción con el código "VERANO20" en esta organización.' }), { status: 422 })) as unknown as typeof fetch;
    await expect(createPromotion(fetchImpl, "http://api.local", "tok", "prop-1", { code: "VERANO20", name: "Verano", type: "percentage", value: 20 })).rejects.toThrow(
      'Ya existe una promoción con el código "VERANO20" en esta organización.',
    );
  });
});

describe("updatePromotion / setPromotionActive", () => {
  it("edita la vigencia de una promoción (PATCH)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/promotions/promo-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ startsAt: "2026-02-01T00:00:00.000Z", endsAt: "2026-02-28T23:59:59.000Z" });
      return new Response(JSON.stringify({ promotion: { ...PROMOTION_ROW, startsAt: "2026-02-01T00:00:00.000Z", endsAt: "2026-02-28T23:59:59.000Z" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await updatePromotion(fetchImpl, "http://api.local", "tok", "prop-1", "promo-1", {
      startsAt: "2026-02-01T00:00:00.000Z",
      endsAt: "2026-02-28T23:59:59.000Z",
    });
    expect(result.startsAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("desactiva una promoción reusando el PATCH genérico -- nunca una ruta separada", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/promotions/promo-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ isActive: false });
      return new Response(JSON.stringify({ promotion: { ...PROMOTION_ROW, isActive: false } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await setPromotionActive(fetchImpl, "http://api.local", "tok", "prop-1", "promo-1", false);
    expect(result.isActive).toBe(false);
  });

  it("404 -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Promoción no encontrada." }), { status: 404 })) as unknown as typeof fetch;
    await expect(updatePromotion(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe", { isActive: true })).rejects.toThrow("Promoción no encontrada.");
  });
});
