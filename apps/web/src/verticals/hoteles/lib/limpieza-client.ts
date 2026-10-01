// H-04 -- logica de datos del tablero de Housekeeping (limpieza por habitacion, inspeccion,
// fuera de servicio y reporte diario). Consume apps/api/src/routes/verticals/hoteles/
// housekeeping.ts (bloque "H-04"). `fetchImpl` inyectado (mismo criterio que el resto de
// lib/*.ts). Los turnos LFT y los tickets de mantenimiento viven en housekeeping-client.ts.
import { fetchJson, sendJson } from "./admin-client.ts";

export type HabitacionEstado = "disponible" | "ocupada" | "sucia" | "fuera_de_servicio" | "mantenimiento";
export type TareaTipo = "salida" | "estancia" | "profunda" | "repaso";
export type TareaEstado = "pendiente" | "en_progreso" | "terminada" | "inspeccionada" | "cancelada";
export type TareaPrioridad = "normal" | "alta";
export type FueraDeServicioTipo = "fuera_de_servicio" | "fuera_de_orden";

export const HABITACION_ESTADO_LABELS: Record<HabitacionEstado, string> = {
  disponible: "Disponible",
  ocupada: "Ocupada",
  sucia: "Sucia",
  fuera_de_servicio: "Fuera de servicio",
  mantenimiento: "Fuera de orden",
};
export const TAREA_ESTADO_LABELS: Record<TareaEstado, string> = {
  pendiente: "Pendiente",
  en_progreso: "En progreso",
  terminada: "Por inspeccionar",
  inspeccionada: "Inspeccionada",
  cancelada: "Cancelada",
};
export const TAREA_TIPO_LABELS: Record<TareaTipo, string> = {
  salida: "Salida",
  estancia: "Estancia",
  profunda: "Profunda",
  repaso: "Repaso",
};

export interface TableroHabitacion {
  readonly roomId: string;
  readonly codigo: string;
  readonly tipoHabitacion: string;
  readonly estado: HabitacionEstado;
  readonly tarea: {
    readonly id: string;
    readonly tipo: TareaTipo;
    readonly estado: TareaEstado;
    readonly prioridad: TareaPrioridad;
    readonly asignadoA: string | null;
    readonly rechazos: number;
  } | null;
  readonly fueraDeServicio: {
    readonly id: string;
    readonly tipo: FueraDeServicioTipo;
    readonly motivo: string;
    readonly regresoEstimado: string | null;
  } | null;
}

export interface Tablero {
  readonly fecha: string;
  /** false = la base aun no tiene la migracion de housekeeping completo: solo se ve el estado de cada habitacion. */
  readonly tareasDisponibles: boolean;
  readonly habitaciones: readonly TableroHabitacion[];
}

export interface ReporteResponsable {
  readonly assignedTo: string | null;
  readonly total: number;
  readonly pendientes: number;
  readonly enProgreso: number;
  readonly porInspeccionar: number;
  readonly inspeccionadas: number;
  readonly rechazos: number;
  readonly minutosPromedio: number | null;
}

export interface ReporteDiario {
  readonly fecha: string;
  readonly tareasDisponibles: boolean;
  readonly totales: Omit<ReporteResponsable, "assignedTo" | "minutosPromedio">;
  readonly porResponsable: readonly ReporteResponsable[];
  readonly habitacionesPorEstado: Readonly<Record<HabitacionEstado, number>>;
  readonly fueraDeServicioActivas: number;
}

export interface Camarista {
  readonly id: string;
  readonly nombre: string;
}

export type TareaAccion = "iniciar" | "terminar" | "inspeccionar" | "asignar" | "cancelar";

const hk = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/housekeeping`;

export function fetchTablero(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, fecha?: string): Promise<Tablero> {
  return fetchJson<Tablero>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/tablero${fecha ? `?fecha=${encodeURIComponent(fecha)}` : ""}`, token);
}

export function fetchReporte(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, fecha?: string): Promise<ReporteDiario> {
  return fetchJson<ReporteDiario>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/reporte${fecha ? `?fecha=${encodeURIComponent(fecha)}` : ""}`, token);
}

export async function fetchCamaristas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly Camarista[]> {
  const res = await fetchJson<{ camaristas: readonly Camarista[] }>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/camaristas`, token);
  return res.camaristas;
}

export function generarDia(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, fecha: string): Promise<{ fecha: string; creadas: number }> {
  return sendJson(fetchImpl, `${hk(apiBaseUrl, propertyId)}/tareas/generar`, token, "POST", { fecha });
}

export function accionTarea(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  taskId: string,
  accion: TareaAccion,
  body: { readonly aprobada?: boolean; readonly nota?: string; readonly asignadoA?: string } = {},
): Promise<unknown> {
  return sendJson(fetchImpl, `${hk(apiBaseUrl, propertyId)}/tareas/${taskId}/${accion}`, token, "POST", body);
}

export function marcarSucia(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, roomId: string): Promise<unknown> {
  return sendJson(fetchImpl, `${hk(apiBaseUrl, propertyId)}/habitaciones/${roomId}/sucia`, token, "POST", {});
}

export function inhabilitar(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly roomId: string; readonly tipo: FueraDeServicioTipo; readonly motivo: string; readonly regresoEstimado?: string },
): Promise<unknown> {
  return sendJson(fetchImpl, `${hk(apiBaseUrl, propertyId)}/fuera-de-servicio`, token, "POST", input);
}

export function rehabilitar(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<unknown> {
  return sendJson(fetchImpl, `${hk(apiBaseUrl, propertyId)}/fuera-de-servicio/${id}/rehabilitar`, token, "POST", {});
}

// Espejo cosmetico de los roles del servidor (domain-hoteles/src/roles.ts): solo oculta
// botones que el servidor rechazaria igual (403), nunca la unica barrera.
export const HK_TASK_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "housekeeping"]);
export const HK_OUT_OF_SERVICE_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "maintenance"]);
export const HK_BOARD_VIEW_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "housekeeping", "maintenance"]);

/** Acciones que la UI ofrece para una tarea segun su estado (espejo de `canApplyTaskAction`). */
export function accionesDisponibles(estado: TareaEstado): readonly TareaAccion[] {
  switch (estado) {
    case "pendiente":
      return ["iniciar", "asignar", "cancelar"];
    case "en_progreso":
      return ["terminar", "asignar", "cancelar"];
    case "terminada":
      return ["inspeccionar", "cancelar"];
    default:
      return [];
  }
}
