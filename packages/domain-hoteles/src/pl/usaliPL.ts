// Fase 10 hoteles (REQ-BO-010, P0/BP-024/BP-041/BP-071/H16-016/H16-017/H07-032/
// H17-002/H04-023) — P&L en formato-resumen USALI ("Uniform System of Accounts for
// the Lodging Industry") 12ª edición y punto de equilibrio dinámico. Port ~conceptual
// (mismo criterio ya establecido por night-audit/engine.ts: el original vive en
// SQL/DbClient crudo, aquí la aritmética se separa en este módulo PURO -- sin I/O,
// determinista, unit-testeable sin Postgres, ver
// `packages/domain-hoteles/tests/pl-usali.spec.ts`) de
// `hoteles/packages/domain-hotel/src/pl/usaliPL.ts` (365L).
//
// Alcance real de "formato USALI 12ª edición" en este esquema: el Summary Operating
// Statement (Ingresos por departamento -> Utilidad departamental -> Gastos no
// distribuidos -> GOP -> cuota de administración -> EBITDA -> gastos no operativos ->
// Utilidad neta), NO los 11 Schedules departamentales completos del manual USALI (eso
// exigiría un catálogo contable completo, fuera de alcance de este sistema hoy) --
// documentado explícitamente para no sobre-prometer, mismo criterio que el original.
//
// GAP REAL VERIFICADO contra el original: `packages/domain-hoteles` no tenía NINGÚN
// archivo de P&L/USALI/forecast/Daily Flash antes de esta fase (domain-hoteles/
// README.md lo listaba explícitamente fuera de Fase 1, ninguna fase posterior lo
// retomó). Esta fase construye el NÚCLEO real: (1) el cálculo de P&L USALI por
// departamento a partir de ingresos/gastos YA agregados por la capa de repositorio
// (mismo principio de separación que night-audit/engine.ts: este archivo nunca toca
// Postgres, la agregación real -- reusando el mismo motor de
// `sum...ForBusinessDate`/agregación por concepto/fecha que night-audit ya construyó,
// extendido a un RANGO de fechas -- vive en
// `postgres-repository.ts::loadRevenueByDepartmentAndDateForPl` +
// `apps/api/src/routes/verticals/hoteles/pl.ts`), y (2) el punto de equilibrio
// dinámico (recalculado con costos/ADR reales del periodo, nunca un supuesto fijo
// cableado en código).
//
// DEFERIDO A UNA FASE FUTURA, documentado honestamente (no fingido): el forecast de
// 90 días y la proyección de caja a 13 semanas del original dependen de
// `forecastExponentialSmoothing` (`packages/domain-hotel/src/forecast/
// timeSeriesForecast.ts` en el origen) -- domain-hoteles NO tiene todavía ningún
// motor de forecast de series de tiempo portado (gap real distinto e independiente de
// REQ-BO-010, con su propio REQ-AGT-012 en el origen). Construir un forecast "a medias"
// solo para esta fase sería exactamente el antipatrón de "P&L de mentiras" que el
// propio original document como razón de NO implementar antes (ver header de
// `packages/db/migrations/0115_pl_usali.sql` en el repo original) -- mejor dejarlo
// pendiente y explícito que fabricar un modelo de segunda. `buildOwnersReport` de
// abajo por lo tanto NO incluye `forecastSummary`/`cashSummary` (a diferencia del
// original): solo empaqueta P&L + KPIs + breakeven + alertas, que SÍ son reales hoy.
/** Departamentos operados (tienen ingreso propio, `hoteles.charge.concept` los
 *  alimenta vía `apps/api/src/routes/verticals/hoteles/pl.ts`). */
export const USALI_REVENUE_DEPARTMENTS = ["rooms", "food_beverage", "otros_departamentos"] as const;
export type UsaliRevenueDepartment = (typeof USALI_REVENUE_DEPARTMENTS)[number];

/** Gastos no distribuidos: sin ingreso propio, viven de `hoteles.expense_entry`
 *  solamente. */
export const USALI_UNDISTRIBUTED_DEPARTMENTS = ["admin_general", "ventas_marketing", "operacion_mantenimiento", "utilities"] as const;
export type UsaliUndistributedDepartment = (typeof USALI_UNDISTRIBUTED_DEPARTMENTS)[number];

/** Universo completo de `hoteles.expense_entry.department` (los 3 operados + los 4 no
 *  distribuidos + los 2 "debajo de GOP") -- un gasto real puede caer en cualquiera de
 *  los 9, a diferencia de `UsaliRevenueDepartment`/`UsaliUndistributedDepartment` que
 *  solo cubren su propio subconjunto. Mismo orden que el `enum` de
 *  `migrations/012_pl_usali.sql`. */
export const USALI_ALL_DEPARTMENTS = [
  ...USALI_REVENUE_DEPARTMENTS,
  ...USALI_UNDISTRIBUTED_DEPARTMENTS,
  "cuota_administracion",
  "no_operativo",
] as const;
export type UsaliDepartment = (typeof USALI_ALL_DEPARTMENTS)[number];

export const USALI_EXPENSE_CATEGORIES = ["costo_ventas", "nomina", "otros_gastos"] as const;
export type UsaliExpenseCategory = (typeof USALI_EXPENSE_CATEGORIES)[number];

// ---------------------------------------------------------------------------------
// 1) P&L USALI por departamento (diario/mensual: la misma función corre para
//    cualquier corte de fechas -- quien arma el bucket diario/mensual es la capa de
//    agregación SQL, ver apps/api/src/routes/verticals/hoteles/pl.ts).
// ---------------------------------------------------------------------------------

export interface DepartmentRevenueRow {
  readonly department: UsaliRevenueDepartment;
  readonly revenue: number;
}

export interface DepartmentExpenseRow {
  readonly department: UsaliRevenueDepartment;
  readonly category: UsaliExpenseCategory;
  readonly amount: number;
}

export interface DepartmentStatement {
  readonly department: UsaliRevenueDepartment;
  readonly revenue: number;
  readonly costOfSales: number;
  readonly payroll: number;
  readonly otherExpenses: number;
  readonly totalExpenses: number;
  readonly departmentalProfit: number;
  /** `null` cuando el departamento no tuvo ingreso (nunca se fabrica un 0% engañoso,
   *  mismo criterio de honestidad que `reporteMensualDueno.ts` ya aplica). */
  readonly profitMarginPct: number | null;
}

function sumBy<T>(rows: readonly T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

export function buildDepartmentalStatements(
  revenueRows: readonly DepartmentRevenueRow[],
  expenseRows: readonly DepartmentExpenseRow[],
): DepartmentStatement[] {
  return USALI_REVENUE_DEPARTMENTS.map((department) => {
    const revenue = sumBy(
      revenueRows.filter((r) => r.department === department),
      (r) => r.revenue,
    );
    const deptExpenses = expenseRows.filter((e) => e.department === department);
    const costOfSales = sumBy(
      deptExpenses.filter((e) => e.category === "costo_ventas"),
      (e) => e.amount,
    );
    const payroll = sumBy(
      deptExpenses.filter((e) => e.category === "nomina"),
      (e) => e.amount,
    );
    const otherExpenses = sumBy(
      deptExpenses.filter((e) => e.category === "otros_gastos"),
      (e) => e.amount,
    );
    const totalExpenses = costOfSales + payroll + otherExpenses;
    const departmentalProfit = revenue - totalExpenses;

    return {
      department,
      revenue,
      costOfSales,
      payroll,
      otherExpenses,
      totalExpenses,
      departmentalProfit,
      profitMarginPct: revenue > 0 ? (departmentalProfit / revenue) * 100 : null,
    };
  });
}

export interface UndistributedRow {
  readonly department: UsaliUndistributedDepartment;
  readonly amount: number;
}

export interface UsaliPL {
  readonly departamentos: readonly DepartmentStatement[];
  readonly ingresosTotales: number;
  readonly utilidadDepartamentalTotal: number;
  readonly gastosNoDistribuidos: readonly UndistributedRow[];
  readonly totalGastosNoDistribuidos: number;
  readonly gop: number;
  readonly gopMarginPct: number | null;
  readonly cuotaAdministracion: number;
  readonly ebitda: number;
  readonly gastosNoOperativos: number;
  readonly utilidadNeta: number;
}

export interface BuildUsaliPLInput {
  readonly departmentRevenue: readonly DepartmentRevenueRow[];
  readonly departmentExpenses: readonly DepartmentExpenseRow[];
  /** Uno por cada `UsaliUndistributedDepartment` con gasto (los que no aparecen se
   *  tratan como 0, nunca se fabrica un departamento inexistente). */
  readonly undistributedExpenses: readonly UndistributedRow[];
  /** Suma de `hoteles.expense_entry` con department = 'cuota_administracion' del
   *  periodo. */
  readonly managementFeeAmount: number;
  /** Suma de `hoteles.expense_entry` con department = 'no_operativo' del periodo. */
  readonly nonOperatingExpenseAmount: number;
}

/**
 * Ensambla el Summary Operating Statement USALI 12ª edición: Ingresos -> Utilidad
 * departamental -> Gastos no distribuidos -> GOP -> cuota de administración -> EBITDA
 * -> gastos no operativos -> Utilidad neta.
 */
export function buildUsaliPL(input: BuildUsaliPLInput): UsaliPL {
  const departamentos = buildDepartmentalStatements(input.departmentRevenue, input.departmentExpenses);
  const ingresosTotales = sumBy(departamentos, (d) => d.revenue);
  const utilidadDepartamentalTotal = sumBy(departamentos, (d) => d.departmentalProfit);

  const gastosNoDistribuidos = USALI_UNDISTRIBUTED_DEPARTMENTS.map((department) => ({
    department,
    amount: sumBy(
      input.undistributedExpenses.filter((u) => u.department === department),
      (u) => u.amount,
    ),
  }));
  const totalGastosNoDistribuidos = sumBy(gastosNoDistribuidos, (u) => u.amount);

  const gop = utilidadDepartamentalTotal - totalGastosNoDistribuidos;
  const ebitda = gop - input.managementFeeAmount;
  const utilidadNeta = ebitda - input.nonOperatingExpenseAmount;

  return {
    departamentos,
    ingresosTotales,
    utilidadDepartamentalTotal,
    gastosNoDistribuidos,
    totalGastosNoDistribuidos,
    gop,
    gopMarginPct: ingresosTotales > 0 ? (gop / ingresosTotales) * 100 : null,
    cuotaAdministracion: input.managementFeeAmount,
    ebitda,
    gastosNoOperativos: input.nonOperatingExpenseAmount,
    utilidadNeta,
  };
}

// ---------------------------------------------------------------------------------
// 2) Punto de equilibrio DINÁMICO: recalculado cada vez con costos y ADR REALES del
//    periodo (nunca un supuesto fijo de "costo variable %" cableado en código). La
//    lógica clásica de breakeven hotelero: cuántas habitaciones-noche ocupadas se
//    necesitan para que el margen de contribución de Rooms cubra los costos que NO
//    varían con la ocupación (gastos no distribuidos + cuota de administración +
//    gastos no operativos), NETEADOS contra la utilidad (o pérdida) real de F&B/Otros
//    Departamentos -- si esos departamentos ya generan utilidad, reducen lo que Rooms
//    tiene que cubrir; si generan pérdida, lo aumentan.
// ---------------------------------------------------------------------------------

export interface DynamicBreakevenInput {
  /** Gastos no distribuidos + cuota de administración + gastos no operativos, del
   *  MISMO periodo que `realAdr`/`roomsVariableCostPerOccupiedRoom` -- "dinámico"
   *  significa que se recalcula por periodo, nunca un monto fijo. */
  readonly fixedCosts: number;
  /** Utilidad (o pérdida, si es negativa) departamental REAL de food_beverage +
   *  otros_departamentos del mismo periodo -- reduce (o aumenta) la carga fija que
   *  Rooms debe cubrir. */
  readonly otherDepartmentsProfit: number;
  /** Ingreso real de Rooms / habitaciones-noche ocupadas reales del periodo (nunca la
   *  tarifa de rack de `hoteles.rate_plan`) -- el ADR "real" que exige el criterio. */
  readonly realAdr: number;
  /** Gasto real del departamento Rooms (`hoteles.expense_entry`) / habitaciones-noche
   *  ocupadas reales del mismo periodo -- el costo variable real por habitación. */
  readonly roomsVariableCostPerOccupiedRoom: number;
  /** Habitaciones-noche DISPONIBLES del periodo (suma de `hoteles.availability.
   *  total_rooms` por fecha -- ver limitación documentada en
   *  `apps/api/src/routes/verticals/hoteles/pl.ts`: usa el inventario real por fecha,
   *  no un conteo estático). */
  readonly availableRoomNights: number;
  /** Habitaciones-noche REALMENTE ocupadas y cobradas en el periodo (para reportar el
   *  hueco real vs. punto de equilibrio, no solo el punto de equilibrio en sí). */
  readonly actualOccupiedRoomNights: number;
}

export interface DynamicBreakevenResult {
  readonly fixedCostsNetOfOtherDepartments: number;
  readonly contributionMarginPerRoom: number;
  /** `null` cuando el margen de contribución no es positivo: nunca se alcanza
   *  equilibrio subiendo ocupación (hace falta subir ADR o bajar costo), no se
   *  fabrica un número sin sentido. */
  readonly breakevenOccupiedRoomNights: number | null;
  readonly breakevenOccupancyPct: number | null;
  readonly actualOccupancyPct: number;
  /** `actualOccupancyPct - breakevenOccupancyPct`: positivo = por ENCIMA del punto de
   *  equilibrio. `null` cuando `breakevenOccupancyPct` es `null`. */
  readonly occupancyGapPct: number | null;
}

export function computeDynamicBreakeven(input: DynamicBreakevenInput): DynamicBreakevenResult {
  const fixedCostsNetOfOtherDepartments = input.fixedCosts - input.otherDepartmentsProfit;
  const contributionMarginPerRoom = input.realAdr - input.roomsVariableCostPerOccupiedRoom;

  const breakevenOccupiedRoomNights =
    contributionMarginPerRoom > 0 ? fixedCostsNetOfOtherDepartments / contributionMarginPerRoom : null;
  const breakevenOccupancyPct =
    breakevenOccupiedRoomNights != null && input.availableRoomNights > 0
      ? (breakevenOccupiedRoomNights / input.availableRoomNights) * 100
      : null;
  const actualOccupancyPct =
    input.availableRoomNights > 0 ? (input.actualOccupiedRoomNights / input.availableRoomNights) * 100 : 0;

  return {
    fixedCostsNetOfOtherDepartments,
    contributionMarginPerRoom,
    breakevenOccupiedRoomNights,
    breakevenOccupancyPct,
    actualOccupancyPct,
    occupancyGapPct: breakevenOccupancyPct != null ? actualOccupancyPct - breakevenOccupancyPct : null,
  };
}

// ---------------------------------------------------------------------------------
// 3) Owner's report: ensambla P&L + KPIs + breakeven reales en un solo documento para
//    el dueño, con alertas derivadas SIEMPRE de los números ya calculados (nunca
//    texto libre de un LLM inventando una cifra -- mismo criterio que
//    `reporteMensualDueno.ts` ya aplica para la regla de honestidad de ROI).
//    NO incluye forecast/cash -- ver nota de alcance en el header de este archivo.
// ---------------------------------------------------------------------------------

export interface OwnersReportKpis {
  readonly adr: number;
  readonly revpar: number;
  readonly occupancyPct: number;
}

export interface OwnersReportInput {
  readonly periodo: { readonly desde: string; readonly hasta: string };
  readonly pl: UsaliPL;
  readonly kpis: OwnersReportKpis;
  readonly breakeven: DynamicBreakevenResult;
}

export interface OwnersReport extends OwnersReportInput {
  readonly porEncimaDePuntoDeEquilibrio: boolean | null;
  readonly alertas: readonly string[];
}

export function buildOwnersReport(input: OwnersReportInput): OwnersReport {
  const alertas: string[] = [];

  const porEncimaDePuntoDeEquilibrio = input.breakeven.occupancyGapPct != null ? input.breakeven.occupancyGapPct >= 0 : null;

  if (porEncimaDePuntoDeEquilibrio === false) {
    alertas.push(
      `Ocupación real (${input.breakeven.actualOccupancyPct.toFixed(1)}%) está ${Math.abs(input.breakeven.occupancyGapPct!).toFixed(1)} pp por debajo del punto de equilibrio dinámico (${input.breakeven.breakevenOccupancyPct!.toFixed(1)}%).`,
    );
  }
  if (input.breakeven.contributionMarginPerRoom <= 0) {
    alertas.push(
      "El costo variable real por habitación ocupada iguala o supera el ADR real: ninguna ocupación alcanza el punto de equilibrio -- revisar tarifa o costo de Rooms.",
    );
  }
  if (input.pl.gop < 0) {
    alertas.push(`GOP negativo (${input.pl.gop.toFixed(2)}) en el periodo ${input.periodo.desde} a ${input.periodo.hasta}.`);
  }

  return { ...input, porEncimaDePuntoDeEquilibrio, alertas };
}
