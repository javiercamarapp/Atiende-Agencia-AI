// Lógica de datos del P&L USALI (Fase 16 agregó el resumen ejecutivo del Dashboard;
// esta fase -- hallazgo de auditoría severidad ALTA "P&L USALI (P0) y checador de
// asistencia LFT sin UI", porción restante -- agrega el back-office financiero
// completo) — consume GET /hoteles/:propertyId/pl?desde=&hasta= y
// POST/GET .../pl/gastos (apps/api/src/routes/verticals/hoteles/pl.ts, REQ-BO-010,
// ya construido en Fase 10). `fetchPlSummary`/`PlSummaryResponse` (Dashboard, resumen
// ejecutivo) NO se duplican: `fetchPlFull`/`PlFullResponse` son la versión completa
// del MISMO endpoint (el desglose por departamento + gastos no distribuidos + punto
// de equilibrio + owner's report que el resumen ejecutivo omite a propósito), y
// `fetchPlExpenses`/`createPlExpense` cubren `.../pl/gastos` (historial + registro de
// gastos), que hasta esta fase no tenía NINGÚN cliente propio. Consumidos por
// pages/Pl.tsx (back-office de P&L, link "Ver P&L completo →" desde
// pages/Dashboard.tsx).
//
// Solo owner/gm/accountant (PL_ROLES en domain-hoteles/src/roles.ts) pueden llamar
// esto sin que el servidor responda 403 — mismo criterio que el resto de lib/*.ts de
// este vertical: el gate real vive SIEMPRE en el servidor (`assertVerticalRole` en
// pl.ts), Dashboard.tsx/HotelesShell.tsx/Pl.tsx solo evitan ofrecer esta sección a
// quien el servidor rechazaría igual.
//
// Tipos REDECLARADOS aquí a propósito (nunca importados de @atiende/domain-hoteles):
// apps/web no depende de ningún paquete domain-* (ver package.json — solo
// react/react-dom/react-router-dom), mismo aislamiento que ya mantiene el resto de
// lib/*.ts de este vertical (ver comentario de cabecera de reservas-client.ts).
import { fetchJson, sendJson } from "./admin-client.ts";

export interface PlKpis {
  readonly adr: number;
  readonly revpar: number;
  readonly occupancyPct: number;
  readonly occupiedRoomNights: number;
  readonly availableRoomNights: number;
}

/** Espejo parcial de `serializeUsaliPL` (pl.ts) — solo los campos-resumen que este
 * Dashboard muestra (ingresos/GOP/margen/EBITDA/utilidad neta). El desglose por
 * departamento (`departamentos`) y de gastos no distribuidos vive completo en la
 * respuesta real del servidor pero esta pantalla no lo consume. */
export interface PlTotalsSummary {
  readonly ingresosTotales: number;
  readonly gop: number;
  readonly gopMarginPct: number;
  readonly ebitda: number;
  readonly utilidadNeta: number;
}

export interface PlSummaryResponse {
  readonly periodo: { readonly desde: string; readonly hasta: string };
  readonly kpis: PlKpis;
  readonly total: PlTotalsSummary;
}

/** `desde`/`hasta` en formato YYYY-MM-DD (mismo formato que exige `DATE_RE` del
 * servidor en pl.ts) — el caller (Dashboard.tsx) es quien decide el rango, este
 * cliente nunca calcula fechas por su cuenta. */
export async function fetchPlSummary(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, desde: string, hasta: string): Promise<PlSummaryResponse> {
  return fetchJson<PlSummaryResponse>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pl?desde=${desde}&hasta=${hasta}`, token);
}

// ---------------------------------------------------------------------------------
// P&L completo (back-office) — mismo endpoint que `fetchPlSummary`, tipado completo.
// Espejo de `USALI_REVENUE_DEPARTMENTS`/`USALI_UNDISTRIBUTED_DEPARTMENTS`/
// `USALI_ALL_DEPARTMENTS`/`USALI_EXPENSE_CATEGORIES` (domain-hoteles/src/pl/
// usaliPL.ts) — redeclarados como arreglos de string (nunca importados, ver
// comentario de cabecera) para poblar los `<select>` del formulario de gasto y
// resolver la etiqueta en español de cada fila.
// ---------------------------------------------------------------------------------

export const USALI_REVENUE_DEPARTMENTS = ["rooms", "food_beverage", "otros_departamentos"] as const;
export type UsaliRevenueDepartment = (typeof USALI_REVENUE_DEPARTMENTS)[number];

export const USALI_UNDISTRIBUTED_DEPARTMENTS = ["admin_general", "ventas_marketing", "operacion_mantenimiento", "utilities"] as const;
export type UsaliUndistributedDepartment = (typeof USALI_UNDISTRIBUTED_DEPARTMENTS)[number];

export const USALI_ALL_DEPARTMENTS = [...USALI_REVENUE_DEPARTMENTS, ...USALI_UNDISTRIBUTED_DEPARTMENTS, "cuota_administracion", "no_operativo"] as const;
export type UsaliDepartment = (typeof USALI_ALL_DEPARTMENTS)[number];

export const USALI_EXPENSE_CATEGORIES = ["costo_ventas", "nomina", "otros_gastos"] as const;
export type UsaliExpenseCategory = (typeof USALI_EXPENSE_CATEGORIES)[number];

export const USALI_DEPARTMENT_LABELS: Record<UsaliDepartment, string> = {
  rooms: "Habitaciones (Rooms)",
  food_beverage: "Alimentos y Bebidas",
  otros_departamentos: "Otros Departamentos Operados",
  admin_general: "Administración General",
  ventas_marketing: "Ventas y Marketing",
  operacion_mantenimiento: "Operación y Mantenimiento",
  utilities: "Servicios (Utilities)",
  cuota_administracion: "Cuota de Administración",
  no_operativo: "Gastos No Operativos",
};

export const USALI_EXPENSE_CATEGORY_LABELS: Record<UsaliExpenseCategory, string> = {
  costo_ventas: "Costo de ventas",
  nomina: "Nómina",
  otros_gastos: "Otros gastos",
};

/** Espejo de `DepartmentStatement` (usaliPL.ts) — una fila del bloque "Ingresos por
 * departamento -> Utilidad departamental" del Summary Operating Statement. */
export interface PlDepartmentStatement {
  readonly department: UsaliRevenueDepartment;
  readonly revenue: number;
  readonly costOfSales: number;
  readonly payroll: number;
  readonly otherExpenses: number;
  readonly totalExpenses: number;
  readonly departmentalProfit: number;
  readonly profitMarginPct: number | null;
}

/** Espejo de `UndistributedRow` (usaliPL.ts) — una fila de "Gastos no distribuidos". */
export interface PlUndistributedRow {
  readonly department: UsaliUndistributedDepartment;
  readonly amount: number;
}

/** Espejo COMPLETO de `UsaliPL`/`serializeUsaliPL` (usaliPL.ts/pl.ts) — el Summary
 * Operating Statement entero: Ingresos -> Utilidad departamental -> Gastos no
 * distribuidos -> GOP -> cuota de administración -> EBITDA -> gastos no operativos ->
 * Utilidad neta. `PlTotalsSummary` (arriba) es un subconjunto de este tipo, para el
 * resumen ejecutivo del Dashboard. */
export interface PlFull {
  readonly departamentos: readonly PlDepartmentStatement[];
  readonly ingresosTotales: number;
  readonly utilidadDepartamentalTotal: number;
  readonly gastosNoDistribuidos: readonly PlUndistributedRow[];
  readonly totalGastosNoDistribuidos: number;
  readonly gop: number;
  readonly gopMarginPct: number | null;
  readonly cuotaAdministracion: number;
  readonly ebitda: number;
  readonly gastosNoOperativos: number;
  readonly utilidadNeta: number;
}

/** Espejo de `DynamicBreakevenResult` (usaliPL.ts) — punto de equilibrio dinámico
 * recalculado con costos/ADR reales del periodo. */
export interface PlBreakeven {
  readonly fixedCostsNetOfOtherDepartments: number;
  readonly contributionMarginPerRoom: number;
  readonly breakevenOccupiedRoomNights: number | null;
  readonly breakevenOccupancyPct: number | null;
  readonly actualOccupancyPct: number;
  readonly occupancyGapPct: number | null;
}

/** Espejo del subconjunto de `OwnersReport` (usaliPL.ts) que el servidor no omite en
 * `ownersReportSinPl` (pl.ts) — `pl` se descarta ahí porque ya viaja en `total`. */
export interface PlOwnersReport {
  readonly porEncimaDePuntoDeEquilibrio: boolean | null;
  readonly alertas: readonly string[];
}

/** Respuesta completa de `GET .../pl` (pl.ts) — a diferencia de `PlSummaryResponse`,
 * incluye el desglose por departamento (`total.departamentos`), gastos no
 * distribuidos, punto de equilibrio dinámico y owner's report/alertas. `diario`/
 * `mensual` (cortes por fecha) no se tipan aquí: este back-office muestra el TOTAL
 * del periodo elegido, mismo alcance que pide el hallazgo ("desglose completo por
 * departamento, no solo el total ya mostrado en Dashboard.tsx"). */
export interface PlFullResponse {
  readonly periodo: { readonly desde: string; readonly hasta: string };
  readonly total: PlFull;
  readonly kpis: PlKpis;
  readonly puntoEquilibrio: PlBreakeven;
  readonly ownersReport: PlOwnersReport;
  readonly alcance: { readonly pendiente: readonly string[] };
}

export async function fetchPlFull(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, desde: string, hasta: string): Promise<PlFullResponse> {
  return fetchJson<PlFullResponse>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pl?desde=${desde}&hasta=${hasta}`, token);
}

// ---------------------------------------------------------------------------------
// Gastos (`hoteles.expense_entry`, append-only: sin PUT/DELETE — un gasto mal
// registrado se corrige con una contrapartida nueva, nunca editándolo).
// ---------------------------------------------------------------------------------

/** Espejo de `serializeExpenseEntry` (pl.ts). */
export interface PlExpenseEntry {
  readonly id: string;
  readonly departamento: UsaliDepartment;
  readonly categoria: UsaliExpenseCategory;
  readonly descripcion: string;
  readonly monto: number;
  readonly fecha: string;
  readonly creadoPor: string | null;
  readonly creadoEn: string;
}

export interface NewPlExpenseInput {
  readonly departamento: UsaliDepartment;
  readonly categoria: UsaliExpenseCategory;
  readonly descripcion: string;
  readonly monto: number;
  readonly fecha: string;
}

export async function fetchPlExpenses(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, desde: string, hasta: string): Promise<readonly PlExpenseEntry[]> {
  return fetchJson<readonly PlExpenseEntry[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pl/gastos?desde=${desde}&hasta=${hasta}`, token);
}

/** POST .../pl/gastos no exige `Idempotency-Key` (a diferencia de reservas/folios) —
 * ver comentario de cabecera de `hotelesPlRoutes` (pl.ts): un gasto duplicado por
 * doble clic se corrige con la disciplina append-only normal, no con deduplicación de
 * request. */
export async function createPlExpense(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NewPlExpenseInput): Promise<PlExpenseEntry> {
  return sendJson<PlExpenseEntry>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pl/gastos`, token, "POST", input);
}
