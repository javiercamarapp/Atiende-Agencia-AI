// Lógica de datos del checklist de cierre mensual (Fase 9) — separada de
// pages/CierreMensual*.tsx a propósito, mismo motivo que el resto de lib/*.ts de
// este panel: probarla con vitest en entorno "node" sin DOM. Llama a
// `GET/POST /despachos/:propertyId/cierre-mensual/periodos*` (apps/api/.../
// despachos/cierre-mensual.ts) — el motor real (checklist/estado/validaciones de
// balance/bloqueo de edición de movimientos ya cerrados) vive por completo en
// @atiende/domain-despachos; este cliente solo transporta lo que la ruta ya
// serializa (`c.json(periodo)`/`c.json(tareas)` directo, camelCase, sin
// snake_case — a diferencia de otras verticales, cierre-mensual.ts no define un
// `serializeX` propio).
import { fetchJson, postJson } from "./admin-client.ts";

export type ClosePeriodStatus = "open" | "closed" | "overdue";
export type TaskStatus = "pending" | "in_progress" | "blocked" | "done" | "skipped";
export type TaskCategory = "cfdi" | "bank" | "nomina" | "declaracion" | "electronica" | "custom";

export interface ClosePeriod {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly year: number;
  readonly month: number;
  readonly status: ClosePeriodStatus;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
}

export interface CloseTask {
  readonly id: string;
  readonly periodId: string;
  readonly title: string;
  readonly description: string;
  readonly category: TaskCategory;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
  readonly dueDate: string | null;
  readonly autoCheckQuery: string | null;
  readonly required: boolean;
  readonly completedAt: string | null;
  readonly completedBy: string | null;
}

export interface EstadoPeriodoCierre {
  readonly totalTasks: number;
  readonly done: number;
  readonly skipped: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly progressPercent: number;
  readonly blocked: readonly CloseTask[];
  readonly overdue: readonly CloseTask[];
}

export interface ReporteCierre {
  readonly totalTasks: number;
  readonly done: number;
  readonly skipped: number;
  readonly pending: number;
  readonly progressPercent: number;
  readonly doneByCategory: Readonly<Record<string, number>>;
  readonly issues: readonly { readonly taskId: string; readonly title: string; readonly reason: string }[];
  readonly estimatedHours: number;
  readonly closed: boolean;
}

export async function fetchPeriodos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly ClosePeriod[]> {
  const body = await fetchJson<{ periodos: readonly ClosePeriod[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos`, token);
  return body.periodos;
}

export interface PeriodoDetalle {
  readonly periodo: ClosePeriod;
  readonly tareas: readonly CloseTask[];
  readonly estado: EstadoPeriodoCierre;
}

export async function fetchPeriodoDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodoId: string): Promise<PeriodoDetalle> {
  return fetchJson<PeriodoDetalle>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos/${periodoId}`, token);
}

export async function crearPeriodo(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly anio: number; readonly mes: number; readonly templateName?: string },
): Promise<{ readonly periodo: ClosePeriod; readonly tareas: readonly CloseTask[] }> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos`, token, input);
}

export async function completarTareaCierre(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  periodoId: string,
  tareaId: string,
  userId: string,
): Promise<readonly CloseTask[]> {
  const body = await postJson<{ tareas: readonly CloseTask[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos/${periodoId}/tareas/${tareaId}/completar`, token, { userId });
  return body.tareas;
}

export async function cerrarPeriodoCierre(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodoId: string, userId: string): Promise<ClosePeriod> {
  return postJson<ClosePeriod>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos/${periodoId}/cerrar`, token, { userId });
}

export async function fetchReporteCierre(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodoId: string): Promise<ReporteCierre> {
  return fetchJson<ReporteCierre>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos/${periodoId}/reporte`, token);
}
