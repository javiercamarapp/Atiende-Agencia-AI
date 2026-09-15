// Cliente web del panel operativo del rol `limpieza` (Fase 17) — cierra el hallazgo
// de auditoría ALTA "el rol `limpieza` sigue sin ninguna vista funcional": el motor
// transaccional completo (asignarTarea/completarChecklistItem/completarTarea/
// registrarIncidencia, packages/domain-rentas/src/limpieza/aplicacion/tareas.ts,
// Fase 8) llevaba desde entonces sin un solo HTTP route que lo expusiera —
// `apps/api/src/routes/verticals/rentas/limpieza.ts` (esta misma fase) monta los 7
// endpoints que este cliente consume.
//
// Mismo criterio de aislamiento que el resto de `lib/*.ts` de este vertical
// (calendario-client.ts, finanzas-client.ts): los tipos se REDECLARAN aquí en vez de
// importarse de @atiende/domain-rentas — apps/web no depende de ningún paquete
// domain-*. `UnidadOption`/`fetchUnidades` SÍ se reexportan de calendario-client.ts
// (mismo dato, mismo endpoint `GET .../unidades`, sin sentido duplicarlo).
import { fetchJson, sendJson } from "./admin-client.ts";
import { fetchUnidades } from "./calendario-client.ts";
import type { UnidadOption } from "./calendario-client.ts";

export { fetchUnidades };
export type { UnidadOption };

export type TipoTareaOperativa = "limpieza" | "mantenimiento" | "inspeccion";
export type EstadoTareaOperativa = "pendiente" | "asignada" | "en_progreso" | "completada" | "bloqueada" | "cancelada";
export type PrioridadTareaOperativa = "baja" | "media" | "alta" | "urgente";
export type SeveridadIncidencia = "leve" | "moderada" | "grave";
export type EstadoIncidencia = "abierta" | "en_revision" | "bloqueo_propuesto" | "bloqueo_confirmado" | "resuelta" | "descartada";
export type CategoriaItemInventario = "ropa_blanca" | "consumible" | "otro";

export const ESTADO_TAREA_LABELS: Record<EstadoTareaOperativa, string> = {
  pendiente: "Pendiente",
  asignada: "Asignada",
  en_progreso: "En progreso",
  completada: "Completada",
  bloqueada: "Bloqueada (checklist incompleto)",
  cancelada: "Cancelada",
};

export const PRIORIDAD_LABELS: Record<PrioridadTareaOperativa, string> = {
  baja: "Baja",
  media: "Media",
  alta: "Alta",
  urgente: "Urgente",
};

export const TIPO_TAREA_LABELS: Record<TipoTareaOperativa, string> = {
  limpieza: "Limpieza",
  mantenimiento: "Mantenimiento",
  inspeccion: "Inspección",
};

export const SEVERIDAD_LABELS: Record<SeveridadIncidencia, string> = {
  leve: "Leve",
  moderada: "Moderada",
  grave: "Grave",
};

export const CATEGORIA_INVENTARIO_LABELS: Record<CategoriaItemInventario, string> = {
  ropa_blanca: "Ropa blanca",
  consumible: "Consumible",
  otro: "Otro",
};

export interface TareaOperativa {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly unidadNombre: string;
  readonly tipo: TipoTareaOperativa;
  readonly estado: EstadoTareaOperativa;
  readonly prioridad: PrioridadTareaOperativa;
  readonly asignadoA: string | null;
  readonly esProveedorExterno: boolean;
  readonly programadaPara: string;
  readonly slaVenceEn: string | null;
  readonly completadaEn: string | null;
  readonly creadoEn: string;
}

export interface ChecklistItemTarea {
  readonly id: string;
  readonly tareaId: string;
  readonly descripcion: string;
  readonly orden: number;
  readonly completado: boolean;
  readonly completadoEn: string | null;
  readonly completadoPor: string | null;
}

export interface TareaOperativaDetalle extends TareaOperativa {
  readonly checklist: readonly ChecklistItemTarea[];
}

export interface ItemInventario {
  readonly id: string;
  readonly unidadId: string;
  readonly nombre: string;
  readonly categoria: CategoriaItemInventario;
  readonly cantidadActual: number;
  readonly umbralMinimo: number;
  readonly unidadMedida: string;
}

export interface IncidenciaMantenimiento {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly tareaOrigenId: string | null;
  readonly severidad: SeveridadIncidencia;
  readonly titulo: string;
  readonly descripcion: string | null;
  readonly estado: EstadoIncidencia;
  readonly propuestaBloqueoRango: { readonly inicio: string; readonly fin: string } | null;
  readonly reportadoPor: string | null;
  readonly creadoEn: string;
}

/** `asignadoA`: `"me"` (mis tareas), `"sin_asignar"` (cola disponible para tomar), o
 *  un `staffUserId` literal. Sin `asignadoA` ni `estado`, trae TODAS las tareas de la
 *  property (uso de admin_gestora/operador, no de la vista "mis tareas de hoy"). */
export interface ListarTareasOpciones {
  readonly asignadoA?: "me" | "sin_asignar" | string;
  readonly estados?: readonly EstadoTareaOperativa[];
}

function buildTareasQuery(opciones: ListarTareasOpciones): string {
  const params = new URLSearchParams();
  if (opciones.asignadoA !== undefined) params.set("asignadoA", opciones.asignadoA);
  if (opciones.estados && opciones.estados.length > 0) params.set("estado", opciones.estados.join(","));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function fetchTareas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, opciones: ListarTareasOpciones = {}): Promise<readonly TareaOperativa[]> {
  const body = await fetchJson<{ tareas: readonly TareaOperativa[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/tareas${buildTareasQuery(opciones)}`, token);
  return body.tareas;
}

export async function fetchTareaDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tareaId: string): Promise<TareaOperativaDetalle> {
  const body = await fetchJson<{ tarea: TareaOperativaDetalle }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/tareas/${tareaId}`, token);
  return body.tarea;
}

/** Sin `input.asignadoA`, el servidor auto-asigna a quien llama (botón "Asignarme"
 *  de la cola "sin asignar"). */
export async function asignarTarea(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tareaId: string,
  input: { readonly asignadoA?: string; readonly esProveedorExterno?: boolean } = {},
): Promise<TareaOperativaDetalle> {
  const body = await sendJson<{ tarea: TareaOperativaDetalle }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/tareas/${tareaId}/asignar`, token, "POST", input);
  return body.tarea;
}

export async function completarChecklistItem(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tareaId: string,
  itemId: string,
): Promise<TareaOperativaDetalle> {
  const body = await sendJson<{ tarea: TareaOperativaDetalle }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/tareas/${tareaId}/checklist/${itemId}/completar`, token, "POST", {});
  return body.tarea;
}

export interface ConsumoInventarioEntrada {
  readonly itemInventarioId: string;
  readonly cantidad: number;
}

export interface TareaCompletada {
  readonly id: string;
  readonly estado: "completada";
  readonly alertasStockBajo: readonly string[];
}

/** Exige checklist completo (H-051) — si algún ítem sigue pendiente, el servidor
 *  responde 409 (`checklist_incompleto`, ver mapRentasDomainError) y la tarea queda
 *  `bloqueada` server-side; esta función deja que ese error suba tal cual, nunca lo
 *  silencia. `consumos` es el único camino real para registrar un movimiento de
 *  inventario (H-052). */
export async function completarTarea(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tareaId: string,
  consumos: readonly ConsumoInventarioEntrada[] = [],
): Promise<TareaCompletada> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/tareas/${tareaId}/completar`, token, "POST", { consumos });
}

export async function fetchInventario(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, unidadId: string): Promise<readonly ItemInventario[]> {
  const body = await fetchJson<{ items: readonly ItemInventario[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/inventario`, token);
  return body.items;
}

export interface ReportarIncidenciaInput {
  readonly severidad: SeveridadIncidencia;
  readonly titulo: string;
  readonly descripcion?: string;
  readonly tareaOrigenId?: string;
}

export async function reportarIncidencia(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  input: ReportarIncidenciaInput,
): Promise<{ id: string; requiereConfirmacionHumana: boolean }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/incidencias`, token, "POST", input);
}

export async function fetchIncidencias(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, unidadId: string): Promise<readonly IncidenciaMantenimiento[]> {
  const body = await fetchJson<{ incidencias: readonly IncidenciaMantenimiento[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/incidencias`, token);
  return body.incidencias;
}
