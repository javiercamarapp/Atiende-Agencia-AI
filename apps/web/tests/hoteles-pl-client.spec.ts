import { describe, expect, it, vi } from "vitest";
import { createPlExpense, fetchPlExpenses, fetchPlFull, fetchPlSummary } from "../src/verticals/hoteles/lib/pl-client.ts";

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

const PL_FULL_RESPONSE = {
  ...PL_RESPONSE,
  total: {
    departamentos: [
      { department: "rooms", revenue: 400000, costOfSales: 20000, payroll: 60000, otherExpenses: 5000, totalExpenses: 85000, departmentalProfit: 315000, profitMarginPct: 78.75 },
      { department: "food_beverage", revenue: 100000, costOfSales: 30000, payroll: 20000, otherExpenses: 5000, totalExpenses: 55000, departmentalProfit: 45000, profitMarginPct: 45 },
      { department: "otros_departamentos", revenue: 0, costOfSales: 0, payroll: 0, otherExpenses: 0, totalExpenses: 0, departmentalProfit: 0, profitMarginPct: null },
    ],
    ingresosTotales: 500000,
    utilidadDepartamentalTotal: 360000,
    gastosNoDistribuidos: [
      { department: "admin_general", amount: 40000 },
      { department: "ventas_marketing", amount: 30000 },
      { department: "operacion_mantenimiento", amount: 20000 },
      { department: "utilities", amount: 10000 },
    ],
    totalGastosNoDistribuidos: 100000,
    gop: 260000,
    gopMarginPct: 52,
    cuotaAdministracion: 10000,
    ebitda: 250000,
    gastosNoOperativos: 5000,
    utilidadNeta: 245000,
  },
  puntoEquilibrio: {
    fixedCostsNetOfOtherDepartments: 60000,
    contributionMarginPerRoom: 1200,
    breakevenOccupiedRoomNights: 50,
    breakevenOccupancyPct: 16.7,
    actualOccupancyPct: 66.7,
    occupancyGapPct: 50,
  },
  ownersReport: { porEncimaDePuntoDeEquilibrio: true, alertas: [] },
  alcance: { pendiente: ["forecast_90_dias: requiere un motor de forecast."] },
};

describe("fetchPlFull", () => {
  it("pide GET .../pl y regresa el desglose completo por departamento", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/pl?desde=2026-08-01&hasta=2026-08-30");
      return new Response(JSON.stringify(PL_FULL_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchPlFull(fetchImpl, "http://api.local", "tok", "prop-1", "2026-08-01", "2026-08-30");
    expect(result.total.departamentos).toHaveLength(3);
    expect(result.total.departamentos[0]!.department).toBe("rooms");
    expect(result.total.gastosNoDistribuidos).toHaveLength(4);
    expect(result.puntoEquilibrio.breakevenOccupancyPct).toBeCloseTo(16.7);
    expect(result.ownersReport.porEncimaDePuntoDeEquilibrio).toBe(true);
  });
});

describe("fetchPlExpenses", () => {
  it("pide GET .../pl/gastos con desde/hasta y regresa el historial", async () => {
    const entry = { id: "exp-1", departamento: "admin_general", categoria: "nomina", descripcion: "Sueldo recepción", monto: 12000, fecha: "2026-08-05", creadoPor: "user-1", creadoEn: "2026-08-05T10:00:00.000Z" };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/pl/gastos?desde=2026-08-01&hasta=2026-08-30");
      return new Response(JSON.stringify([entry]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchPlExpenses(fetchImpl, "http://api.local", "tok", "prop-1", "2026-08-01", "2026-08-30");
    expect(result).toHaveLength(1);
    expect(result[0]!.monto).toBe(12000);
  });

  it("un rol sin acceso -> error real (403 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para ver el P&L de esta property." }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchPlExpenses(fetchImpl, "http://api.local", "tok", "prop-1", "2026-08-01", "2026-08-30")).rejects.toThrow(/permiso/);
  });
});

describe("createPlExpense", () => {
  it("hace POST real a .../pl/gastos con el gasto nuevo", async () => {
    const input = { departamento: "utilities" as const, categoria: "otros_gastos" as const, descripcion: "Recibo de luz agosto", monto: 8500, fecha: "2026-08-10" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/pl/gastos");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual(input);
      return new Response(
        JSON.stringify({ id: "exp-2", departamento: input.departamento, categoria: input.categoria, descripcion: input.descripcion, monto: input.monto, fecha: input.fecha, creadoPor: "user-1", creadoEn: "2026-08-10T09:00:00.000Z" }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const result = await createPlExpense(fetchImpl, "http://api.local", "tok", "prop-1", input);
    expect(result.id).toBe("exp-2");
    expect(result.monto).toBe(8500);
  });

  it("monto negativo -> error real (400 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "monto: debe ser un número finito >= 0." }), { status: 400 })) as unknown as typeof fetch;
    await expect(
      createPlExpense(fetchImpl, "http://api.local", "tok", "prop-1", { departamento: "utilities", categoria: "otros_gastos", descripcion: "x", monto: -1, fecha: "2026-08-10" }),
    ).rejects.toThrow(/monto/);
  });
});
