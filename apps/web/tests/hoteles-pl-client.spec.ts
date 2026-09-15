import { describe, expect, it, vi } from "vitest";
import { fetchPlSummary } from "../src/verticals/hoteles/lib/pl-client.ts";

const PL_RESPONSE = {
  periodo: { desde: "2026-08-01", hasta: "2026-08-30" },
  diario: [],
  mensual: [],
  total: {
    departamentos: [],
    ingresosTotales: 500000,
    utilidadDepartamentalTotal: 300000,
    gastosNoDistribuidos: 100000,
    totalGastosNoDistribuidos: 100000,
    gop: 200000,
    gopMarginPct: 40,
    cuotaAdministracion: 10000,
    ebitda: 190000,
    gastosNoOperativos: 5000,
    utilidadNeta: 185000,
  },
  kpis: { adr: 1800, revpar: 1200, occupancyPct: 66.7, occupiedRoomNights: 200, availableRoomNights: 300 },
  puntoEquilibrio: {},
  ownersReport: {},
  alcance: { pendiente: [] },
};

describe("fetchPlSummary", () => {
  it("pide GET .../pl con desde/hasta y regresa kpis + total", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/pl?desde=2026-08-01&hasta=2026-08-30");
      return new Response(JSON.stringify(PL_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchPlSummary(fetchImpl, "http://api.local", "tok", "prop-1", "2026-08-01", "2026-08-30");
    expect(result.kpis.occupancyPct).toBeCloseTo(66.7);
    expect(result.total.gop).toBe(200000);
  });

  it("un rol sin acceso -> error real (403 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para ver el P&L de esta property." }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchPlSummary(fetchImpl, "http://api.local", "tok", "prop-1", "2026-08-01", "2026-08-30")).rejects.toThrow(/permiso/);
  });
});
