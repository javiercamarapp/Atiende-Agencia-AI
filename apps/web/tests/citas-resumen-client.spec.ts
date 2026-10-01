import { describe, expect, it, vi } from "vitest";
import { fetchCitasResumen, formatDiaCorto, formatDiaNegocio } from "../src/verticals/citas/lib/resumen-client.ts";

const BODY = {
  timezone: "America/Merida",
  generated_at: "2026-09-30T05:00:00.000Z",
  today: { date: "2026-09-29", total: 3, by_status: { pending: 1, confirmed: 2, completed: 0, cancelled: 1, no_show: 0 } },
  week: { from_date: "2026-09-28", to_date: "2026-10-04", total: 9, by_status: { pending: 2, confirmed: 5, completed: 2, cancelled: 1, no_show: 0 } },
  pending_to_confirm: 4,
  no_shows_last_30_days: 2,
  new_customers_last_30_days: 7,
};

describe("fetchCitasResumen", () => {
  it("pide la ruta de la sucursal con el token y mapea snake_case a camelCase", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/resumen");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      return new Response(JSON.stringify(BODY), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await fetchCitasResumen(fetchImpl, "http://api.local", "tok", "prop-1");

    expect(r).toEqual({
      timezone: "America/Merida",
      generatedAt: "2026-09-30T05:00:00.000Z",
      today: { date: "2026-09-29", total: 3, byStatus: BODY.today.by_status },
      week: { fromDate: "2026-09-28", toDate: "2026-10-04", total: 9, byStatus: BODY.week.by_status },
      pendingToConfirm: 4,
      noShowsLast30Days: 2,
      newCustomersLast30Days: 7,
    });
  });

  it("un error del servidor se propaga (nunca se inventa un resumen en ceros)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 })) as unknown as typeof fetch;
    await expect(fetchCitasResumen(fetchImpl, "http://api.local", "tok", "prop-1")).rejects.toThrow();
  });
});

describe("formatDiaNegocio -- el día del negocio no se corre por la zona del navegador", () => {
  it("'2026-09-29' sigue siendo 29 de septiembre aunque el navegador esté en UTC-12 o UTC+14", () => {
    expect(formatDiaNegocio("2026-09-29")).toContain("29 de septiembre");
    expect(formatDiaNegocio("2026-09-29")).toContain("martes");
    expect(formatDiaCorto("2026-10-04")).toMatch(/4/);
  });
});
