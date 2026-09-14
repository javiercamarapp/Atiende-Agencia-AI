// Fase 10 hoteles (REQ-BO-010) — unit tests puros (sin Postgres) del núcleo de P&L
// USALI y punto de equilibrio dinámico. La agregación real desde `hoteles.charge`/
// `hoteles.expense_entry` se prueba por separado a nivel HTTP en
// `apps/api/tests/hoteles-pl.spec.ts` (con InMemoryHotelesRepository) — este archivo
// solo verifica la aritmética sobre filas YA agregadas, mismo criterio que
// `night-audit-engine.spec.ts` ya aplica para `night-audit/engine.ts`.
import { describe, expect, it } from "vitest";
import {
  buildDepartmentalStatements,
  buildOwnersReport,
  buildUsaliPL,
  computeDynamicBreakeven,
  USALI_ALL_DEPARTMENTS,
  USALI_REVENUE_DEPARTMENTS,
  USALI_UNDISTRIBUTED_DEPARTMENTS,
  type DepartmentExpenseRow,
  type DepartmentRevenueRow,
  type UndistributedRow,
} from "../src/pl/usaliPL.ts";

describe("buildDepartmentalStatements", () => {
  it("agrega ingresos y gastos por departamento, con margen null cuando no hubo ingreso", () => {
    const revenue: DepartmentRevenueRow[] = [
      { department: "rooms", revenue: 100_000 },
      { department: "food_beverage", revenue: 20_000 },
    ];
    const expenses: DepartmentExpenseRow[] = [
      { department: "rooms", category: "costo_ventas", amount: 10_000 },
      { department: "rooms", category: "nomina", amount: 20_000 },
      { department: "rooms", category: "otros_gastos", amount: 5_000 },
      { department: "food_beverage", category: "costo_ventas", amount: 15_000 },
    ];

    const statements = buildDepartmentalStatements(revenue, expenses);
    expect(statements).toHaveLength(3);

    const rooms = statements.find((s) => s.department === "rooms")!;
    expect(rooms.revenue).toBe(100_000);
    expect(rooms.totalExpenses).toBe(35_000);
    expect(rooms.departmentalProfit).toBe(65_000);
    expect(rooms.profitMarginPct).toBeCloseTo(65, 5);

    const otros = statements.find((s) => s.department === "otros_departamentos")!;
    expect(otros.revenue).toBe(0);
    expect(otros.departmentalProfit).toBe(0);
    // Sin ingreso -- nunca se fabrica un 0% engañoso, es null.
    expect(otros.profitMarginPct).toBeNull();
  });

  it("nunca inventa un departamento fuera de USALI_REVENUE_DEPARTMENTS", () => {
    const statements = buildDepartmentalStatements([], []);
    expect(statements.map((s) => s.department)).toEqual([...USALI_REVENUE_DEPARTMENTS]);
  });
});

describe("buildUsaliPL", () => {
  it("ensambla el Summary Operating Statement completo: ingresos -> GOP -> EBITDA -> utilidad neta", () => {
    const departmentRevenue: DepartmentRevenueRow[] = [
      { department: "rooms", revenue: 200_000 },
      { department: "food_beverage", revenue: 50_000 },
      { department: "otros_departamentos", revenue: 10_000 },
    ];
    const departmentExpenses: DepartmentExpenseRow[] = [
      { department: "rooms", category: "nomina", amount: 40_000 },
      { department: "food_beverage", category: "costo_ventas", amount: 20_000 },
    ];
    const undistributedExpenses: UndistributedRow[] = [
      { department: "admin_general", amount: 15_000 },
      { department: "utilities", amount: 8_000 },
    ];

    const pl = buildUsaliPL({
      departmentRevenue,
      departmentExpenses,
      undistributedExpenses,
      managementFeeAmount: 5_000,
      nonOperatingExpenseAmount: 2_000,
    });

    expect(pl.ingresosTotales).toBe(260_000);
    // utilidad departamental = (200000-40000) + (50000-20000) + 10000 = 160000+30000+10000
    expect(pl.utilidadDepartamentalTotal).toBe(200_000);
    expect(pl.gastosNoDistribuidos).toHaveLength(4); // los 4 UsaliUndistributedDepartment, aun los que no aparecieron
    expect(pl.totalGastosNoDistribuidos).toBe(23_000);
    expect(pl.gop).toBe(177_000);
    expect(pl.gopMarginPct).toBeCloseTo((177_000 / 260_000) * 100, 5);
    expect(pl.ebitda).toBe(172_000);
    expect(pl.utilidadNeta).toBe(170_000);
  });

  it("departamentos no distribuidos ausentes se tratan como 0, nunca se omiten de la lista", () => {
    const pl = buildUsaliPL({
      departmentRevenue: [],
      departmentExpenses: [],
      undistributedExpenses: [],
      managementFeeAmount: 0,
      nonOperatingExpenseAmount: 0,
    });
    expect(pl.gastosNoDistribuidos.map((u) => u.department)).toEqual([...USALI_UNDISTRIBUTED_DEPARTMENTS]);
    expect(pl.gastosNoDistribuidos.every((u) => u.amount === 0)).toBe(true);
    expect(pl.gopMarginPct).toBeNull(); // sin ingresos, nunca 0% fabricado
  });

  it("USALI_ALL_DEPARTMENTS cubre exactamente los 3 operados + 4 no distribuidos + 2 debajo de GOP", () => {
    expect(USALI_ALL_DEPARTMENTS).toEqual([
      "rooms",
      "food_beverage",
      "otros_departamentos",
      "admin_general",
      "ventas_marketing",
      "operacion_mantenimiento",
      "utilities",
      "cuota_administracion",
      "no_operativo",
    ]);
  });
});

describe("computeDynamicBreakeven", () => {
  it("calcula el punto de equilibrio real cuando el margen de contribución es positivo", () => {
    const result = computeDynamicBreakeven({
      fixedCosts: 100_000,
      otherDepartmentsProfit: 10_000,
      realAdr: 1_000,
      roomsVariableCostPerOccupiedRoom: 200,
      availableRoomNights: 300,
      actualOccupiedRoomNights: 150,
    });

    // fixedCostsNetOfOtherDepartments = 100000 - 10000 = 90000
    // contributionMarginPerRoom = 1000 - 200 = 800
    // breakeven = 90000 / 800 = 112.5
    expect(result.fixedCostsNetOfOtherDepartments).toBe(90_000);
    expect(result.contributionMarginPerRoom).toBe(800);
    expect(result.breakevenOccupiedRoomNights).toBeCloseTo(112.5, 5);
    expect(result.breakevenOccupancyPct).toBeCloseTo(37.5, 5);
    expect(result.actualOccupancyPct).toBe(50);
    expect(result.occupancyGapPct).toBeCloseTo(12.5, 5);
  });

  it("nunca fabrica un breakeven cuando el margen de contribución no es positivo (costo variable >= ADR)", () => {
    const result = computeDynamicBreakeven({
      fixedCosts: 50_000,
      otherDepartmentsProfit: 0,
      realAdr: 500,
      roomsVariableCostPerOccupiedRoom: 500,
      availableRoomNights: 100,
      actualOccupiedRoomNights: 60,
    });
    expect(result.contributionMarginPerRoom).toBe(0);
    expect(result.breakevenOccupiedRoomNights).toBeNull();
    expect(result.breakevenOccupancyPct).toBeNull();
    expect(result.occupancyGapPct).toBeNull();
    expect(result.actualOccupancyPct).toBe(60);
  });

  it("otros departamentos con pérdida AUMENTAN la carga fija que Rooms debe cubrir", () => {
    const result = computeDynamicBreakeven({
      fixedCosts: 100_000,
      otherDepartmentsProfit: -20_000, // F&B/Otros perdiendo dinero
      realAdr: 1_000,
      roomsVariableCostPerOccupiedRoom: 200,
      availableRoomNights: 300,
      actualOccupiedRoomNights: 150,
    });
    expect(result.fixedCostsNetOfOtherDepartments).toBe(120_000);
    expect(result.breakevenOccupiedRoomNights).toBeCloseTo(150, 5);
  });

  it("sin habitaciones disponibles, ocupación real es 0 (nunca división por 0)", () => {
    const result = computeDynamicBreakeven({
      fixedCosts: 10_000,
      otherDepartmentsProfit: 0,
      realAdr: 500,
      roomsVariableCostPerOccupiedRoom: 100,
      availableRoomNights: 0,
      actualOccupiedRoomNights: 0,
    });
    expect(result.actualOccupancyPct).toBe(0);
    expect(result.breakevenOccupancyPct).toBeNull();
  });
});

describe("buildOwnersReport", () => {
  const periodo = { desde: "2026-09-01", hasta: "2026-09-30" };

  it("sin alertas cuando GOP es positivo y la ocupación real está por encima del punto de equilibrio", () => {
    const pl = buildUsaliPL({
      departmentRevenue: [{ department: "rooms", revenue: 300_000 }],
      departmentExpenses: [],
      undistributedExpenses: [],
      managementFeeAmount: 0,
      nonOperatingExpenseAmount: 0,
    });
    const breakeven = computeDynamicBreakeven({
      fixedCosts: 50_000,
      otherDepartmentsProfit: 0,
      realAdr: 1_000,
      roomsVariableCostPerOccupiedRoom: 100,
      availableRoomNights: 300,
      actualOccupiedRoomNights: 200,
    });

    const report = buildOwnersReport({ periodo, pl, kpis: { adr: 1_000, revpar: 666, occupancyPct: 66.6 }, breakeven });
    expect(report.porEncimaDePuntoDeEquilibrio).toBe(true);
    expect(report.alertas).toEqual([]);
  });

  it("declara explícitamente cuando la ocupación real está por debajo del punto de equilibrio", () => {
    const pl = buildUsaliPL({
      departmentRevenue: [{ department: "rooms", revenue: 30_000 }],
      departmentExpenses: [],
      undistributedExpenses: [{ department: "admin_general", amount: 40_000 }],
      managementFeeAmount: 0,
      nonOperatingExpenseAmount: 0,
    });
    const breakeven = computeDynamicBreakeven({
      fixedCosts: 40_000,
      otherDepartmentsProfit: 0,
      realAdr: 1_000,
      roomsVariableCostPerOccupiedRoom: 100,
      availableRoomNights: 300,
      actualOccupiedRoomNights: 30,
    });

    const report = buildOwnersReport({ periodo, pl, kpis: { adr: 1_000, revpar: 100, occupancyPct: 10 }, breakeven });
    expect(report.porEncimaDePuntoDeEquilibrio).toBe(false);
    expect(pl.gop).toBeLessThan(0);
    expect(report.alertas.some((a) => a.includes("por debajo del punto de equilibrio"))).toBe(true);
    expect(report.alertas.some((a) => a.startsWith("GOP negativo"))).toBe(true);
  });

  it("alerta cuando ningún nivel de ocupación alcanza el punto de equilibrio (costo variable >= ADR)", () => {
    const pl = buildUsaliPL({
      departmentRevenue: [{ department: "rooms", revenue: 10_000 }],
      departmentExpenses: [],
      undistributedExpenses: [],
      managementFeeAmount: 0,
      nonOperatingExpenseAmount: 0,
    });
    const breakeven = computeDynamicBreakeven({
      fixedCosts: 5_000,
      otherDepartmentsProfit: 0,
      realAdr: 100,
      roomsVariableCostPerOccupiedRoom: 150,
      availableRoomNights: 100,
      actualOccupiedRoomNights: 50,
    });
    const report = buildOwnersReport({ periodo, pl, kpis: { adr: 100, revpar: 50, occupancyPct: 50 }, breakeven });
    expect(report.porEncimaDePuntoDeEquilibrio).toBeNull();
    expect(report.alertas.some((a) => a.includes("ninguna ocupación alcanza el punto de equilibrio"))).toBe(true);
  });
});
