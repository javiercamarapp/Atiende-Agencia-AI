// Fase 10 hoteles (REQ-BO-010, P0) — integración HTTP real del back-office
// financiero: P&L USALI a partir de cargos/pagos reales del folio (hoteles.charge,
// ya sembrados por los fixtures de disponibilidad/tarifas) + gastos reales
// (hoteles.expense_entry, registrados vía POST .../pl/gastos), punto de equilibrio
// dinámico y owner's report -- protegido por PL_ROLES (owner/gm/accountant).
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

interface DepartmentStatementBody {
  department: string;
  revenue: number;
  totalExpenses: number;
  departmentalProfit: number;
  profitMarginPct: number | null;
}

interface UsaliPLBody {
  departamentos: DepartmentStatementBody[];
  ingresosTotales: number;
  utilidadDepartamentalTotal: number;
  totalGastosNoDistribuidos: number;
  gop: number;
  cuotaAdministracion: number;
  ebitda: number;
  gastosNoOperativos: number;
  utilidadNeta: number;
}

interface PlReportBody {
  periodo: { desde: string; hasta: string };
  diario: { inicio: string; fin: string; pl: UsaliPLBody }[];
  mensual: { inicio: string; fin: string; pl: UsaliPLBody }[];
  total: UsaliPLBody;
  kpis: { adr: number; revpar: number; occupancyPct: number; occupiedRoomNights: number; availableRoomNights: number };
  puntoEquilibrio: {
    contributionMarginPerRoom: number;
    breakevenOccupiedRoomNights: number | null;
    breakevenOccupancyPct: number | null;
    actualOccupancyPct: number;
    occupancyGapPct: number | null;
  };
  ownersReport: { porEncimaDePuntoDeEquilibrio: boolean | null; alertas: string[] };
  alcance: { pendiente: string[] };
}

/** Siembra un periodo real (2026-12-01..03, mismas fechas con disponibilidad/tarifas
 *  ya sembradas por buildHotelesTestContext): 2 noches de hospedaje reales,
 *  A&B/extras/descuento/propina, un reverso que neta "extras" a 0, y el lado de
 *  gastos vía la ruta HTTP real (nunca insertado directo al repo, para probar el
 *  endpoint de escritura también). */
async function seedPeriodoCompleto(ctx: HotelesTestContext, app: ReturnType<typeof buildApp>) {
  const { hotelesRepo, organizationId, propertyId, folioId } = ctx;

  await hotelesRepo.insertCharge({ organizationId, propertyId, folioId, description: "Hospedaje 12-01", amount: 1500, taxAmount: 240, concept: "hospedaje", stayDate: "2026-12-01" });
  await hotelesRepo.insertCharge({ organizationId, propertyId, folioId, description: "Hospedaje 12-02", amount: 1500, taxAmount: 240, concept: "hospedaje", stayDate: "2026-12-02" });
  await hotelesRepo.insertCharge({ organizationId, propertyId, folioId, description: "Cena", amount: 800, taxAmount: 128, concept: "ab", stayDate: "2026-12-01" });
  const extras = await hotelesRepo.insertCharge({ organizationId, propertyId, folioId, description: "Spa", amount: 200, taxAmount: 32, concept: "extras", stayDate: "2026-12-02" });
  await hotelesRepo.insertCharge({ organizationId, propertyId, folioId, description: "Reverso de Spa", amount: -200, taxAmount: -32, concept: "reverso", reversesChargeId: extras.id, stayDate: "2026-12-02" });
  await hotelesRepo.insertCharge({ organizationId, propertyId, folioId, description: "Descuento", amount: -100, taxAmount: 0, concept: "descuento", stayDate: "2026-12-01" });
  await hotelesRepo.insertCharge({ organizationId, propertyId, folioId, description: "Propina", amount: 50, taxAmount: 0, concept: "propina", stayDate: "2026-12-01" });

  const gastos = [
    { departamento: "rooms", categoria: "nomina", descripcion: "Turno recepción", monto: 500, fecha: "2026-12-01" },
    { departamento: "rooms", categoria: "costo_ventas", descripcion: "Amenities", monto: 200, fecha: "2026-12-02" },
    { departamento: "food_beverage", categoria: "costo_ventas", descripcion: "Insumos cocina", monto: 300, fecha: "2026-12-01" },
    { departamento: "admin_general", categoria: "otros_gastos", descripcion: "Papelería", monto: 400, fecha: "2026-12-01" },
    { departamento: "utilities", categoria: "otros_gastos", descripcion: "CFE", monto: 150, fecha: "2026-12-02" },
    { departamento: "cuota_administracion", categoria: "otros_gastos", descripcion: "Fee de administración", monto: 100, fecha: "2026-12-01" },
    { departamento: "no_operativo", categoria: "otros_gastos", descripcion: "Multa municipal", monto: 50, fecha: "2026-12-02" },
  ];
  for (const gasto of gastos) {
    const res = await app.request(`/hoteles/${ctx.propertyId}/pl/gastos`, authedJson(ctx.staff.owner.token, gasto));
    if (res.status !== 201) throw new Error(`seed de gasto falló: ${res.status} ${await res.text()}`);
  }
}

describe("GET /hoteles/:propertyId/pl -- P&L USALI + punto de equilibrio dinámico", () => {
  it("rechaza un rol sin acceso a PL_ROLES (frontdesk)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/pl?desde=2026-12-01&hasta=2026-12-03`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(403);
  });

  it("rechaza fechas mal formadas o un rango invertido", async () => {
    const app = buildApp(ctx.deps);
    const owner = ctx.staff.owner.token;
    expect((await app.request(`/hoteles/${ctx.propertyId}/pl?desde=01-12-2026&hasta=2026-12-03`, authedJson(owner))).status).toBe(400);
    expect((await app.request(`/hoteles/${ctx.propertyId}/pl?desde=2026-12-03&hasta=2026-12-01`, authedJson(owner))).status).toBe(400);
    expect((await app.request(`/hoteles/${ctx.propertyId}/pl`, authedJson(owner))).status).toBe(400);
  });

  it("calcula ingresos por departamento reales (concept -> departamento, reverso neteado, propina excluida)", async () => {
    const app = buildApp(ctx.deps);
    await seedPeriodoCompleto(ctx, app);

    const res = await app.request(`/hoteles/${ctx.propertyId}/pl?desde=2026-12-01&hasta=2026-12-03`, authedJson(ctx.staff.accountant.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlReportBody;

    const rooms = body.total.departamentos.find((d) => d.department === "rooms")!;
    const fb = body.total.departamentos.find((d) => d.department === "food_beverage")!;
    const otros = body.total.departamentos.find((d) => d.department === "otros_departamentos")!;

    // rooms = 1500 + 1500 (hospedaje) - 100 (descuento) = 2900 -- nunca amount+tax_amount.
    expect(rooms.revenue).toBe(2900);
    expect(fb.revenue).toBe(800);
    // extras (200) neteado exactamente por su reverso (-200): la propina (50) NUNCA cuenta en ningún departamento.
    expect(otros.revenue).toBe(0);
    expect(body.total.ingresosTotales).toBe(3700);
  });

  it("ensambla el Summary Operating Statement completo con gastos reales, y el punto de equilibrio dinámico", async () => {
    const app = buildApp(ctx.deps);
    await seedPeriodoCompleto(ctx, app);

    const res = await app.request(`/hoteles/${ctx.propertyId}/pl?desde=2026-12-01&hasta=2026-12-03`, authedJson(ctx.staff.owner.token));
    const body = (await res.json()) as PlReportBody;

    const rooms = body.total.departamentos.find((d) => d.department === "rooms")!;
    const fb = body.total.departamentos.find((d) => d.department === "food_beverage")!;
    expect(rooms.totalExpenses).toBe(700); // 500 nómina + 200 costo de ventas
    expect(rooms.departmentalProfit).toBe(2200); // 2900 - 700
    expect(fb.totalExpenses).toBe(300);
    expect(fb.departmentalProfit).toBe(500); // 800 - 300

    expect(body.total.utilidadDepartamentalTotal).toBe(2700); // 2200 + 500 + 0
    expect(body.total.totalGastosNoDistribuidos).toBe(550); // 400 admin_general + 150 utilities
    expect(body.total.gop).toBe(2150); // 2700 - 550
    expect(body.total.cuotaAdministracion).toBe(100);
    expect(body.total.ebitda).toBe(2050); // 2150 - 100
    expect(body.total.gastosNoOperativos).toBe(50);
    expect(body.total.utilidadNeta).toBe(2000); // 2050 - 50

    // KPIs reales: 2 habitaciones-noche ocupadas (1500 c/u), 2 habitaciones x 3 noches disponibles.
    expect(body.kpis.occupiedRoomNights).toBe(2);
    expect(body.kpis.availableRoomNights).toBe(6);
    expect(body.kpis.adr).toBe(1500);
    expect(body.kpis.revpar).toBeCloseTo(500, 5); // 3000 / 6
    expect(body.kpis.occupancyPct).toBeCloseTo((2 / 6) * 100, 5);

    // Punto de equilibrio: roomsVariableCostPerOccupiedRoom = 700/2 = 350; margen = 1500-350=1150.
    // fixedCostsNetOfOtherDepartments = (550+100+50) - (500 [fb+otros]) = 700-500=200.
    // breakeven = 200/1150.
    expect(body.puntoEquilibrio.contributionMarginPerRoom).toBe(1150);
    expect(body.puntoEquilibrio.breakevenOccupiedRoomNights).toBeCloseTo(200 / 1150, 5);
    expect(body.puntoEquilibrio.breakevenOccupancyPct).toBeCloseTo((200 / 1150 / 6) * 100, 5);
    expect(body.ownersReport.porEncimaDePuntoDeEquilibrio).toBe(true);
    expect(body.ownersReport.alertas).toEqual([]);

    // Documenta honestamente lo que esta fase deliberadamente no construye.
    expect(body.alcance.pendiente.some((p) => p.includes("forecast_90_dias"))).toBe(true);
    expect(body.alcance.pendiente.some((p) => p.includes("proyeccion_caja_13_semanas"))).toBe(true);
  });

  it("diario/mensual usan la MISMA función de cálculo por corte de fechas -- el total del rango coincide con la suma de los diarios", async () => {
    const app = buildApp(ctx.deps);
    await seedPeriodoCompleto(ctx, app);

    const res = await app.request(`/hoteles/${ctx.propertyId}/pl?desde=2026-12-01&hasta=2026-12-03`, authedJson(ctx.staff.gm.token));
    const body = (await res.json()) as PlReportBody;

    expect(body.diario).toHaveLength(3);
    const sumaIngresosDiarios = body.diario.reduce((sum, d) => sum + d.pl.ingresosTotales, 0);
    expect(sumaIngresosDiarios).toBe(body.total.ingresosTotales);

    expect(body.mensual).toHaveLength(1);
    expect(body.mensual[0]!.pl.ingresosTotales).toBe(body.total.ingresosTotales);
  });

  it("sin ingresos ni gastos en el periodo: GOP/margen son honestos (0 real, no null fabricado; margen null solo sin ingreso)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/pl?desde=2027-01-01&hasta=2027-01-02`, authedJson(ctx.staff.owner.token));
    const body = (await res.json()) as PlReportBody;

    expect(body.total.ingresosTotales).toBe(0);
    expect(body.total.gop).toBe(0);
    expect(body.total.departamentos.every((d) => d.profitMarginPct === null)).toBe(true);
    expect(body.puntoEquilibrio.breakevenOccupancyPct).toBeNull();
    expect(body.ownersReport.porEncimaDePuntoDeEquilibrio).toBeNull();
  });
});

describe("POST /hoteles/:propertyId/pl/gastos -- registrar un gasto real del P&L", () => {
  it("rechaza un rol sin acceso a PL_ROLES (housekeeping)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/pl/gastos`,
      authedJson(ctx.staff.housekeeping.token, { departamento: "rooms", categoria: "nomina", descripcion: "x", monto: 100, fecha: "2026-12-01" }),
    );
    expect(res.status).toBe(403);
  });

  it("owner/gm/accountant registran un gasto real; queda en el historial", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/pl/gastos`,
      authedJson(ctx.staff.accountant.token, { departamento: "operacion_mantenimiento", categoria: "otros_gastos", descripcion: "Reparación bomba", monto: 1200, fecha: "2026-12-05" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; departamento: string; monto: number; creadoPor: string | null };
    expect(body.departamento).toBe("operacion_mantenimiento");
    expect(body.monto).toBe(1200);
    expect(body.creadoPor).toBe(ctx.staff.accountant.id);

    const historial = await app.request(`/hoteles/${ctx.propertyId}/pl/gastos?desde=2026-12-01&hasta=2026-12-31`, authedJson(ctx.staff.owner.token));
    expect(historial.status).toBe(200);
    const entries = (await historial.json()) as { id: string }[];
    expect(entries.some((e) => e.id === body.id)).toBe(true);
  });

  it("rechaza un monto negativo, un departamento inválido y una categoría inválida", async () => {
    const app = buildApp(ctx.deps);
    const owner = ctx.staff.owner.token;
    expect(
      (await app.request(`/hoteles/${ctx.propertyId}/pl/gastos`, authedJson(owner, { departamento: "rooms", categoria: "nomina", descripcion: "x", monto: -1, fecha: "2026-12-01" }))).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/hoteles/${ctx.propertyId}/pl/gastos`,
          authedJson(owner, { departamento: "departamento_inventado", categoria: "nomina", descripcion: "x", monto: 1, fecha: "2026-12-01" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/hoteles/${ctx.propertyId}/pl/gastos`,
          authedJson(owner, { departamento: "rooms", categoria: "categoria_inventada", descripcion: "x", monto: 1, fecha: "2026-12-01" }),
        )
      ).status,
    ).toBe(400);
  });
});
