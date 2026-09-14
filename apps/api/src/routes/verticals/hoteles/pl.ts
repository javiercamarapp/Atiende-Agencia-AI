// Fase 10 hoteles (REQ-BO-010, P0/BP-024/BP-041/BP-071/H16-016/H16-017/H07-032/
// H17-002/H04-023) — back-office financiero: P&L en formato-resumen USALI 12ª
// edición (diario/mensual/total del periodo) + punto de equilibrio dinámico + owner's
// report, calculados a partir de ingresos REALES del folio (`hoteles.charge`, mismo
// motor de agregación por concepto/fecha de negocio que night-audit.ts ya construyó,
// extendido a un rango de fechas -- ver `HotelesRepository.
// loadRevenueByDepartmentAndDateForPl`) y gastos REALES por departamento
// (`hoteles.expense_entry`, tabla nueva de esta fase). Solo owner/gm/accountant
// (PL_ROLES) pueden ver el P&L o registrar un gasto -- ver el comentario de cabecera
// de `domain-hoteles/src/roles.ts::PL_ROLES` para por qué es más estricto que
// MONEY_ROLES.
//
// GAP REAL verificado contra el original (`hoteles/packages/domain-hotel/src/pl/
// usaliPL.ts`): `packages/domain-hoteles` no tenía NINGÚN archivo de P&L/USALI antes
// de esta fase (README.md lo listaba explícitamente fuera de Fase 1). DELIBERADAMENTE
// fuera de esta fase (documentado, no fingido): forecast de 90 días y proyección de
// caja a 13 semanas -- dependen de un motor de forecast de series de tiempo que
// domain-hoteles no tiene portado todavía (gap independiente, ver header de
// `packages/domain-hoteles/src/pl/usaliPL.ts`). Este endpoint responde
// `alcance.pendiente` con esa lista explícita en vez de fabricar esas dos superficies
// a medias.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  PL_ROLES,
  USALI_ALL_DEPARTMENTS,
  USALI_EXPENSE_CATEGORIES,
  USALI_REVENUE_DEPARTMENTS,
  USALI_UNDISTRIBUTED_DEPARTMENTS,
  buildOwnersReport,
  buildUsaliPL,
  computeDynamicBreakeven,
  type DepartmentExpenseRow,
  type DepartmentRevenueRow,
  type ExpenseEntryRecord,
  type PlExpenseByDateRow,
  type PlRevenueByDateRow,
  type UndistributedRow,
  type UsaliDepartment,
  type UsaliExpenseCategory,
  type UsaliPL,
  type UsaliRevenueDepartment,
  type UsaliUndistributedDepartment,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(desde: string, hasta: string): string[] {
  const out: string[] = [];
  let cursor = desde;
  while (cursor <= hasta) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

function monthKey(fecha: string): string {
  return fecha.slice(0, 7); // YYYY-MM
}

// ---- ensambla un UsaliPL a partir de filas YA departamentalizadas por el
// repositorio (`loadRevenueByDepartmentAndDateForPl`/`loadExpensesByDepartmentAndDateForPl`)
// -- esta ruta nunca decide por su cuenta a qué departamento pertenece un concept,
// esa autoridad vive en la capa de repositorio (mismo criterio documentado en
// `HotelesRepository`: "ninguna función de negocio de las rutas de apps/api toca SQL
// directamente"). ----

function toDepartmentRevenueRows(rows: readonly PlRevenueByDateRow[]): DepartmentRevenueRow[] {
  const totals = new Map<UsaliRevenueDepartment, number>();
  for (const r of rows) totals.set(r.department, (totals.get(r.department) ?? 0) + r.revenue);
  return USALI_REVENUE_DEPARTMENTS.map((department) => ({ department, revenue: totals.get(department) ?? 0 }));
}

function toDepartmentExpenseRows(rows: readonly PlExpenseByDateRow[]): DepartmentExpenseRow[] {
  const revenueDeptSet: readonly string[] = USALI_REVENUE_DEPARTMENTS;
  return rows
    .filter((r) => revenueDeptSet.includes(r.department))
    .map((r) => ({ department: r.department as UsaliRevenueDepartment, category: r.category, amount: r.amount }));
}

function toUndistributedRows(rows: readonly PlExpenseByDateRow[]): UndistributedRow[] {
  const undistributedDeptSet: readonly string[] = USALI_UNDISTRIBUTED_DEPARTMENTS;
  return rows
    .filter((r) => undistributedDeptSet.includes(r.department))
    .map((r) => ({ department: r.department as UsaliUndistributedDepartment, amount: r.amount }));
}

function sumWhereDepartment(rows: readonly PlExpenseByDateRow[], department: UsaliDepartment): number {
  return rows.filter((r) => r.department === department).reduce((total, r) => total + r.amount, 0);
}

function assembleUsaliPL(revenueRows: readonly PlRevenueByDateRow[], expenseRows: readonly PlExpenseByDateRow[]): UsaliPL {
  return buildUsaliPL({
    departmentRevenue: toDepartmentRevenueRows(revenueRows),
    departmentExpenses: toDepartmentExpenseRows(expenseRows),
    undistributedExpenses: toUndistributedRows(expenseRows),
    managementFeeAmount: sumWhereDepartment(expenseRows, "cuota_administracion"),
    nonOperatingExpenseAmount: sumWhereDepartment(expenseRows, "no_operativo"),
  });
}

function serializeUsaliPL(pl: UsaliPL) {
  return {
    departamentos: pl.departamentos,
    ingresosTotales: pl.ingresosTotales,
    utilidadDepartamentalTotal: pl.utilidadDepartamentalTotal,
    gastosNoDistribuidos: pl.gastosNoDistribuidos,
    totalGastosNoDistribuidos: pl.totalGastosNoDistribuidos,
    gop: pl.gop,
    gopMarginPct: pl.gopMarginPct,
    cuotaAdministracion: pl.cuotaAdministracion,
    ebitda: pl.ebitda,
    gastosNoOperativos: pl.gastosNoOperativos,
    utilidadNeta: pl.utilidadNeta,
  };
}

function serializeExpenseEntry(entry: ExpenseEntryRecord) {
  return {
    id: entry.id,
    departamento: entry.department,
    categoria: entry.category,
    descripcion: entry.description,
    monto: entry.amount,
    fecha: entry.expenseDate,
    creadoPor: entry.createdBy,
    creadoEn: entry.createdAt,
  };
}

function parseDateRange(c: { req: { query: (key: string) => string | undefined } }): { desde: string; hasta: string } {
  const desde = c.req.query("desde");
  const hasta = c.req.query("hasta");
  if (!desde || !DATE_RE.test(desde)) throw Errors.validation("desde: formato esperado YYYY-MM-DD.");
  if (!hasta || !DATE_RE.test(hasta)) throw Errors.validation("hasta: formato esperado YYYY-MM-DD.");
  if (desde > hasta) throw Errors.validation("rango_invalido: desde es posterior a hasta.");
  return { desde, hasta };
}

interface NewExpenseEntryBody {
  readonly departamento?: unknown;
  readonly categoria?: unknown;
  readonly descripcion?: unknown;
  readonly monto?: unknown;
  readonly fecha?: unknown;
}

export function hotelesPlRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/pl/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/pl", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // ---- GET .../pl?desde=&hasta= — P&L USALI diario+mensual+total del periodo,
  // KPIs (ADR/RevPAR/ocupación), punto de equilibrio dinámico y owner's report. ----
  app.get("/hoteles/:propertyId/pl", async (c) => {
    assertVerticalRole(c, PL_ROLES);
    const propertyId = c.req.param("propertyId");
    const { desde, hasta } = parseDateRange(c);
    const repo = deps.hotelesRepo(c.get("db"));

    const [revenueRows, expenseRows, roomNightsRows, availableRoomNights] = await Promise.all([
      repo.loadRevenueByDepartmentAndDateForPl(propertyId, desde, hasta),
      repo.loadExpensesByDepartmentAndDateForPl(propertyId, desde, hasta),
      repo.loadOccupiedRoomNightsByDateForPl(propertyId, desde, hasta),
      repo.sumAvailableRoomNightsForDateRange(propertyId, desde, hasta),
    ]);

    // --- P&L diario ---------------------------------------------------------
    const allDates = daysBetweenInclusive(desde, hasta);
    const diario = allDates.map((fecha) => ({
      inicio: fecha,
      fin: fecha,
      pl: serializeUsaliPL(
        assembleUsaliPL(
          revenueRows.filter((r) => r.fecha === fecha),
          expenseRows.filter((r) => r.fecha === fecha),
        ),
      ),
    }));

    // --- P&L mensual ---------------------------------------------------------
    const months = [...new Set(allDates.map(monthKey))];
    const mensual = months.map((mes) => {
      const fechasDelMes = allDates.filter((f) => monthKey(f) === mes);
      return {
        inicio: fechasDelMes[0]!,
        fin: fechasDelMes.at(-1)!,
        pl: serializeUsaliPL(
          assembleUsaliPL(
            revenueRows.filter((r) => monthKey(r.fecha) === mes),
            expenseRows.filter((r) => monthKey(r.fecha) === mes),
          ),
        ),
      };
    });

    // --- P&L total del periodo (base de KPIs/breakeven/owner's report) -------
    const total = assembleUsaliPL(revenueRows, expenseRows);

    // --- KPIs reales (ADR/RevPAR/ocupación) -----------------------------------
    const occupiedRoomNights = roomNightsRows.reduce((sum, r) => sum + r.roomNights, 0);
    const roomsRevenueGross = roomNightsRows.reduce((sum, r) => sum + r.revenue, 0);
    const adr = occupiedRoomNights > 0 ? roomsRevenueGross / occupiedRoomNights : 0;
    const revpar = availableRoomNights > 0 ? roomsRevenueGross / availableRoomNights : 0;
    const occupancyPct = availableRoomNights > 0 ? (occupiedRoomNights / availableRoomNights) * 100 : 0;
    const kpis = { adr, revpar, occupancyPct, occupiedRoomNights, availableRoomNights };

    // --- Punto de equilibrio dinámico -----------------------------------------
    const roomsStatement = total.departamentos.find((d) => d.department === "rooms")!;
    const otherDepartmentsProfit = total.departamentos
      .filter((d) => d.department !== "rooms")
      .reduce((sum, d) => sum + d.departmentalProfit, 0);
    const fixedCosts = total.totalGastosNoDistribuidos + total.cuotaAdministracion + total.gastosNoOperativos;
    const roomsVariableCostPerOccupiedRoom = occupiedRoomNights > 0 ? roomsStatement.totalExpenses / occupiedRoomNights : 0;
    const puntoEquilibrio = computeDynamicBreakeven({
      fixedCosts,
      otherDepartmentsProfit,
      realAdr: adr,
      roomsVariableCostPerOccupiedRoom,
      availableRoomNights,
      actualOccupiedRoomNights: occupiedRoomNights,
    });

    // --- Owner's report ---------------------------------------------------------
    const ownersReport = buildOwnersReport({
      periodo: { desde, hasta },
      pl: total,
      kpis: { adr, revpar, occupancyPct },
      breakeven: puntoEquilibrio,
    });

    // `pl` ya viaja en `total` arriba (mismo objeto) -- se omite aquí para no
    // duplicar el payload completo del Summary Operating Statement.
    const { pl: _plYaIncluidoEnTotal, ...ownersReportSinPl } = ownersReport;

    return c.json(
      {
        periodo: { desde, hasta },
        diario,
        mensual,
        total: serializeUsaliPL(total),
        kpis,
        puntoEquilibrio,
        ownersReport: ownersReportSinPl,
        alcance: {
          pendiente: [
            "forecast_90_dias: requiere un motor de forecast de series de tiempo que domain-hoteles no tiene portado todavía (gap independiente de REQ-BO-010).",
            "proyeccion_caja_13_semanas: depende del mismo motor de forecast pendiente.",
          ],
        },
      },
      200,
    );
  });

  // ---- POST .../pl/gastos — registra un gasto real del periodo
  // (hoteles.expense_entry, append-only: sin PUT/DELETE). ----
  app.post("/hoteles/:propertyId/pl/gastos", async (c) => {
    assertVerticalRole(c, PL_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId");
    const body = await readJsonCapped<NewExpenseEntryBody>(c.req.raw);

    if (typeof body.departamento !== "string" || !(USALI_ALL_DEPARTMENTS as readonly string[]).includes(body.departamento)) {
      throw Errors.validation(`departamento: debe ser uno de ${USALI_ALL_DEPARTMENTS.join(", ")}.`);
    }
    if (typeof body.categoria !== "string" || !(USALI_EXPENSE_CATEGORIES as readonly string[]).includes(body.categoria)) {
      throw Errors.validation(`categoria: debe ser una de ${USALI_EXPENSE_CATEGORIES.join(", ")}.`);
    }
    if (typeof body.descripcion !== "string" || body.descripcion.trim().length === 0) {
      throw Errors.validation("descripcion: requerida.");
    }
    if (typeof body.monto !== "number" || !Number.isFinite(body.monto) || body.monto < 0) {
      throw Errors.validation("monto: debe ser un número finito >= 0.");
    }
    if (typeof body.fecha !== "string" || !DATE_RE.test(body.fecha)) {
      throw Errors.validation("fecha: formato esperado YYYY-MM-DD.");
    }

    const repo = deps.hotelesRepo(c.get("db"));
    const entry = await repo.insertExpenseEntry({
      organizationId,
      propertyId,
      department: body.departamento as UsaliDepartment,
      category: body.categoria as UsaliExpenseCategory,
      description: body.descripcion,
      amount: body.monto,
      expenseDate: body.fecha,
      createdBy: userId,
    });
    return c.json(serializeExpenseEntry(entry), 201);
  });

  // ---- GET .../pl/gastos?desde=&hasta= — historial de gastos registrados. ----
  app.get("/hoteles/:propertyId/pl/gastos", async (c) => {
    assertVerticalRole(c, PL_ROLES);
    const propertyId = c.req.param("propertyId");
    const { desde, hasta } = parseDateRange(c);
    const repo = deps.hotelesRepo(c.get("db"));
    const entries = await repo.listExpenseEntries(propertyId, desde, hasta);
    return c.json(entries.map(serializeExpenseEntry), 200);
  });

  return app;
}
