import { describe, expect, it, vi } from "vitest";
import {
  DashboardError,
  fetchBranches,
  fetchDashboardData,
  formatDays,
  formatInt,
  formatMoney,
  formatPct,
  formatSignedPct,
  resolveActivePropertyId,
} from "../src/verticals/restaurantes/dashboard-client.ts";
import type { BranchOption } from "../src/verticals/restaurantes/dashboard-client.ts";

function fakeFetch(byUrl: Record<string, { status: number; body: unknown }>): typeof fetch {
  return vi.fn(async (input: string) => {
    const url = input;
    const match = Object.entries(byUrl).find(([key]) => url.includes(key));
    if (!match) throw new Error(`fakeFetch: URL no esperada en el test: ${url}`);
    const [, { status, body }] = match;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("fetchBranches", () => {
  it("pide /admin/branches con el token y devuelve la lista", async () => {
    const branches = [{ propertyId: "p1", name: "Centro", slug: "centro" }];
    const fetchImpl = fakeFetch({ "/admin/branches": { status: 200, body: { branches } } });
    const result = await fetchBranches(fetchImpl, "http://api.local", "tok", "los-taquitos");
    expect(result).toEqual(branches);
    expect(fetchImpl).toHaveBeenCalledWith("http://api.local/v1/restaurantes/los-taquitos/admin/branches", expect.objectContaining({ headers: { authorization: "Bearer tok" } }));
  });

  it("respuesta no-ok -> DashboardError con el mensaje del servidor", async () => {
    const fetchImpl = fakeFetch({ "/admin/branches": { status: 403, body: { message: "No perteneces a esta organización." } } });
    await expect(fetchBranches(fetchImpl, "http://api.local", "tok", "los-taquitos")).rejects.toThrow(DashboardError);
    await expect(fetchBranches(fetchImpl, "http://api.local", "tok", "los-taquitos")).rejects.toThrow("No perteneces a esta organización.");
  });
});

// Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA, "cadena de
// restaurantes con 2+ sucursales solo opera la primera"): RestaurantesShell.tsx
// fijaba `propertyId` a `branches[0]!.propertyId` siempre — mismo patrón (y misma
// función pura) que ya resolvió esto en hoteles/despachos/rentas, ver
// `resolveActivePropertyId` de hoteles/lib/discovery-client.ts (leído primero como
// plantilla). Probada aquí sin depender de un DOM/React renderer (este repo corre
// vitest en `environment: "node"`, sin jsdom/testing-library).
describe("resolveActivePropertyId", () => {
  const centro: BranchOption = { propertyId: "p1", name: "Centro", slug: "centro" };
  const norte: BranchOption = { propertyId: "p2", name: "Norte", slug: "norte" };
  const branches: readonly BranchOption[] = [centro, norte];

  it("sin selección todavía (null) -> cae a la primera sucursal de la lista", () => {
    expect(resolveActivePropertyId(branches, null)).toBe("p1");
  });

  it("con una sucursal distinta a la primera seleccionada -> la respeta (esto es lo que rompía el branches[0] fijo)", () => {
    expect(resolveActivePropertyId(branches, "p2")).toBe("p2");
  });

  it("selección obsoleta (propertyId que ya no está en la lista) -> cae a la primera, no se queda colgado", () => {
    expect(resolveActivePropertyId(branches, "propertyId-que-ya-no-existe")).toBe("p1");
  });

  it("una sola sucursal -> siempre esa, sin importar la selección", () => {
    expect(resolveActivePropertyId([centro], null)).toBe("p1");
    expect(resolveActivePropertyId([centro], "otro-id")).toBe("p1");
  });

  it("sin ninguna sucursal -> null (el Shell ya corta antes con su propio mensaje de error, pero la función no debe reventar)", () => {
    expect(resolveActivePropertyId([], "p1")).toBeNull();
  });
});

describe("fetchDashboardData", () => {
  it("pide las 4 rutas de KPIs en paralelo y arma un solo DashboardData", async () => {
    const sales = { revenue: 100, orders: 2, customers: 2, averageOrder: 50, revenueChangePct: 10, ordersChangePct: 0, customersChangePct: 0, avgOrderChangePct: 0, periodLabel: "vs 7 días anteriores" };
    const channels = { totalOrders: 2, totalRevenue: 100, voice: { orders: 1, completed: 1, cancelled: 0, revenue: 50 }, whatsapp: { orders: 0, completed: 0, cancelled: 0, revenue: 0 }, whatsappConversations: { total: 0, withOrder: 0, averageMessages: 0 }, aiAdoptionPct: 50, aiRevenuePct: 50, estimatedHoursSaved: 0.1 };
    const customers = { totalCustomers: 2, averageOrderValue: 50, recurringCustomerPct: 0, topCustomer: null, avgDaysSinceLastOrder: null, tierDistribution: { metric: "sin_datos" as const, BLACK: 0, PLATINUM: 0, GOLD: 0, BLUE: 0, withoutTier: 2 } };
    const fetchImpl = fakeFetch({
      "/kpis/sales?period=7": { status: 200, body: sales },
      "/kpis/sales/trend?period=7": { status: 200, body: { buckets: [{ label: "lun", revenue: 100, orders: 2 }] } },
      "/kpis/channels": { status: 200, body: channels },
      "/kpis/customers": { status: 200, body: customers },
    });

    const result = await fetchDashboardData(fetchImpl, "http://api.local", "tok", "prop-1", "7");
    expect(result.sales).toEqual(sales);
    expect(result.trend).toEqual([{ label: "lun", revenue: 100, orders: 2 }]);
    expect(result.channels).toEqual(channels);
    expect(result.customers).toEqual(customers);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("formato — honestidad de null (nunca $0/0%/0 fingido)", () => {
  it("formatMoney/formatInt/formatDays: null -> '—' o 'Sin datos', nunca un cero", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(1234.5)).toBe("$1,234.50");
    expect(formatInt(null)).toBe("—");
    expect(formatInt(7)).toBe("7");
    expect(formatDays(null)).toBe("Sin datos");
    expect(formatDays(3.7)).toBe("4");
  });

  it("formatSignedPct antepone el signo y formatPct usa 'Sin datos' para null", () => {
    expect(formatSignedPct(12.34)).toBe("+12.3%");
    expect(formatSignedPct(-5)).toBe("-5.0%");
    expect(formatSignedPct(null)).toBe("—");
    expect(formatPct(50)).toBe("50%");
    expect(formatPct(null)).toBe("Sin datos");
  });
});
