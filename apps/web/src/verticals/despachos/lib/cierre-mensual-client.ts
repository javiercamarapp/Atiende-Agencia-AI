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
import { fetchBlob, fetchJson, postJson } from "./admin-client.ts";
import { conStepUp } from "./step-up.ts";

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

export type ClaveValidacionCierre = "balanza" | "polizas" | "cfdi_sin_poliza" | "conciliacion" | "pagos_provisionales" | "solicitud_documentos";

/** Validacion del cierre calculada por el SERVIDOR desde datos persistidos (paridad3 D-P3-15). */
export interface ValidacionCierre {
  readonly clave: ClaveValidacionCierre;
  readonly titulo: string;
  readonly ok: boolean;
  readonly bloqueante: boolean;
  readonly mensaje: string;
  readonly detalle: Readonly<Record<string, number | string | boolean | null>>;
}

export interface ValidacionesCierre {
  /** false = la base aun no tiene la migracion 027: no hay validaciones derivadas y el cierre se rige solo por las tareas. */
  readonly disponible: boolean;
  readonly items: readonly ValidacionCierre[];
  readonly puedeCerrar: boolean;
}

export interface ArtefactoCierre {
  readonly id: string;
  readonly tipo: "contabilidad_catalogo_xml" | "contabilidad_balanza_xml";
  readonly nombreArchivo: string;
  readonly tamanoBytes: number;
  readonly creadoEn: string;
}

export interface EntregaCierre {
  readonly id: string;
  readonly creadaEn: string;
  readonly correoEncoladoEn: string | null;
  readonly archivos: readonly { readonly id: string; readonly tipo: "impuestos" | "diot" | "balanza"; readonly nombreArchivo: string; readonly tamanoBytes: number }[];
}

export interface PeriodoDetalle {
  readonly periodo: ClosePeriod;
  readonly tareas: readonly CloseTask[];
  readonly estado: EstadoPeriodoCierre;
  readonly validaciones?: ValidacionesCierre;
  readonly artefactos?: readonly ArtefactoCierre[];
  readonly entrega?: EntregaCierre | null;
}

/** Resultado de los pasos que siguen al cierre (cada uno de mejor esfuerzo: un fallo se reporta pero no deshace el cierre). */
export interface PosCierre {
  readonly papelPagos: string;
  readonly contabilidadElectronica: string;
  readonly entrega: string;
}

export const ETIQUETA_ARTEFACTO: Readonly<Record<ArtefactoCierre["tipo"], string>> = { contabilidad_catalogo_xml: "Catálogo de cuentas (XML)", contabilidad_balanza_xml: "Balanza de comprobación (XML)" };

/** Texto legible de cada resultado del pos-cierre. */
export function textoPosCierre(p: PosCierre): readonly string[] {
  const out: string[] = [];
  if (p.papelPagos === "generado") out.push("Se generó el borrador del papel de pagos provisionales (no se presentó).");
  else if (p.papelPagos.startsWith("no_generado")) out.push(`No se pudo generar el papel de pagos provisionales: ${p.papelPagos.replace(/^no_generado:\s*/, "")}`);
  if (p.contabilidadElectronica === "generada") out.push("Se generaron el catálogo y la balanza XML de contabilidad electrónica (no se presentaron).");
  else if (p.contabilidadElectronica.startsWith("no_generada:")) out.push(`No se pudo generar la contabilidad electrónica: ${p.contabilidadElectronica.replace(/^no_generada:\s*/, "")}`);
  else if (p.contabilidadElectronica === "sin_libro_en_el_periodo") out.push("El libro no tiene movimientos en el periodo: no se generó contabilidad electrónica.");
  if (p.entrega === "enviada") out.push("Se publicaron los reportes en el portal del cliente y se le envió el aviso por correo.");
  else if (p.entrega.startsWith("no_enviada")) out.push(`No se pudo entregar los reportes al cliente: ${p.entrega.replace(/^no_enviada:\s*/, "")}`);
  return out;
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

// El actor (quién completó la tarea / quién cerró el período) lo determina el
// servidor a partir de la sesión autenticada (`c.get("userId")`) -- ver
// apps/api/.../despachos/cierre-mensual.ts. Estas funciones ya NO reciben ni
// mandan un `userId` propio: mandarlo desde el cliente permitía atribuir la
// acción a cualquier usuario, o dejarla vacía.
export async function completarTareaCierre(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  periodoId: string,
  tareaId: string,
): Promise<readonly CloseTask[]> {
  const body = await postJson<{ tareas: readonly CloseTask[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos/${periodoId}/tareas/${tareaId}/completar`, token, {});
  return body.tareas;
}

/** `confirmacion` -- hallazgo de auditoría (severidad ALTA, "cierre-mensual es
 * irreversible y ejecuta con un clic sin confirmación ni reapertura"): el
 * servidor exige el período exacto ("AAAA-MM") escrito por quien cierra, no
 * solo un clic (ver cierre-mensual.ts::app.post(".../cerrar")). Este cliente
 * no calcula ni asume ese valor -- lo recibe tal cual lo escribió el usuario
 * en CierreMensualDetalle.tsx, para que un bug de formato aquí nunca finja
 * una confirmación que nadie tecleó. */
export async function cerrarPeriodoCierre(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  periodoId: string,
  confirmacion: string,
  /** Solo un admin: cierra aunque fallen validaciones derivadas, con un motivo obligatorio (10 a 500 caracteres) que queda en el periodo. */
  forzado?: { readonly motivo: string },
): Promise<ClosePeriod & { readonly posCierre?: PosCierre }> {
  // D-30: cerrar un periodo es irreversible -> segundo factor reciente (lib/step-up.ts).
  return conStepUp({ fetchImpl, apiBaseUrl, token }, (h) =>
    postJson<ClosePeriod & { readonly posCierre?: PosCierre }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos/${periodoId}/cerrar`, token, { confirmacion, ...(forzado ? { forzar: true, motivo: forzado.motivo } : {}) }, h),
  );
}

/** Texto minimo del motivo de un cierre forzado (el servidor y la base exigen lo mismo). */
export function motivoForzadoValido(motivo: string): boolean {
  const m = motivo.trim();
  return m.length >= 10 && m.length <= 500;
}

/** Descarga un XML pre-generado al cerrar (exportacion fiscal: exige segundo factor, y deja bitacora). */
export async function descargarArtefactoCierre(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodoId: string, artefactoId: string, nombre: string): Promise<{ readonly blob: Blob; readonly nombre: string }> {
  return conStepUp({ fetchImpl, apiBaseUrl, token }, (h) => fetchBlob(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos/${periodoId}/artefactos/${artefactoId}/descargar`, token, nombre, undefined, h));
}

export async function fetchReporteCierre(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodoId: string): Promise<ReporteCierre> {
  return fetchJson<ReporteCierre>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cierre-mensual/periodos/${periodoId}/reporte`, token);
}
