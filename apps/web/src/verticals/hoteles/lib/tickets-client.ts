// H-05 -- logica de datos de los tickets de huesped (SLA, escalacion, bitacora, desde resenas).
// Consume apps/api/src/routes/verticals/hoteles/tickets.ts. `fetchImpl` inyectado (mismo criterio que
// el resto de lib/*.ts).
import { fetchJson, sendJson } from "./admin-client.ts";

export type TicketDepartamento = "owner" | "gm" | "frontdesk" | "reservations" | "housekeeping" | "maintenance" | "fnb" | "accountant";
export type TicketPrioridad = "alta" | "media" | "baja";
export type TicketEstado = "abierto" | "en_progreso" | "escalado" | "cerrado" | "cancelado";
export type TicketEstadoSla = "en_tiempo" | "por_vencer" | "vencido" | "cerrado";
export type TicketAccion = "iniciar" | "cerrar" | "cancelar" | "escalar";

export const TICKET_DEPARTAMENTOS: readonly TicketDepartamento[] = ["frontdesk", "housekeeping", "maintenance", "fnb", "reservations", "gm", "owner", "accountant"];
export const TICKET_PRIORIDADES: readonly TicketPrioridad[] = ["alta", "media", "baja"];

export const DEPARTAMENTO_LABELS: Record<TicketDepartamento, string> = {
  owner: "Dirección",
  gm: "Gerencia",
  frontdesk: "Recepción",
  reservations: "Reservaciones",
  housekeeping: "Housekeeping",
  maintenance: "Mantenimiento",
  fnb: "Alimentos y bebidas",
  accountant: "Contabilidad",
};
export const PRIORIDAD_LABELS: Record<TicketPrioridad, string> = { alta: "Alta", media: "Media", baja: "Baja" };
export const ESTADO_LABELS: Record<TicketEstado, string> = {
  abierto: "Abierto",
  en_progreso: "En progreso",
  escalado: "Escalado",
  cerrado: "Cerrado",
  cancelado: "Cancelado",
};
export const ESTADO_SLA_LABELS: Record<TicketEstadoSla, string> = { en_tiempo: "En tiempo", por_vencer: "Por vencer", vencido: "SLA vencido", cerrado: "Cerrado" };

/** Cosmetico: el servidor es la unica barrera real (403). Espejo de GUEST_TICKET_*_ROLES. */
export const TICKET_MANAGE_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk"]);
export const TICKET_SLA_POLICY_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);
export const TICKET_FROM_REVIEW_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);

export interface TicketResumen {
  readonly id: string;
  readonly habitacion: string | null;
  readonly resenaId: string | null;
  readonly departamento: TicketDepartamento;
  readonly prioridad: TicketPrioridad;
  readonly estado: TicketEstado;
  readonly canal: string;
  readonly mensaje: string;
  readonly slaMinutos: number;
  readonly slaVenceEn: string;
  readonly estadoSla: TicketEstadoSla;
  readonly minutosParaVencer: number;
  readonly asignadoA: string | null;
  readonly escaladoEn: string | null;
  readonly escaladoARoles: readonly string[];
  readonly notaResolucion: string | null;
  readonly creadoEn: string;
}

export interface TicketEvento {
  readonly id: string;
  readonly tipo: string;
  readonly actorId: string | null;
  readonly sistema: boolean;
  readonly detalle: Record<string, unknown>;
  readonly creadoEn: string;
}

export interface TicketListado {
  /** false = la base aun no tiene la migracion 034 (lista vacia honesta). */
  readonly disponible: boolean;
  readonly ahora: string;
  readonly tickets: readonly TicketResumen[];
}

export interface ResenaPendiente {
  readonly id: string;
  readonly fuente: string;
  readonly texto: string;
  readonly calificacion: number | null;
  readonly sentimiento: string;
  readonly temas: readonly string[];
  readonly sugerencia: { readonly departamento: TicketDepartamento; readonly prioridad: TicketPrioridad };
}

export interface SlaEfectiva {
  readonly departamento: TicketDepartamento;
  readonly prioridad: TicketPrioridad;
  readonly minutos: number;
  readonly configurada: boolean;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/tickets`;

export async function fetchTickets(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filtros: { estado?: TicketEstado; activos?: boolean } = {}): Promise<TicketListado> {
  const qs = new URLSearchParams();
  if (filtros.estado) qs.set("estado", filtros.estado);
  if (filtros.activos) qs.set("activos", "1");
  const q = qs.toString();
  return fetchJson<TicketListado>(fetchImpl, `${base(apiBaseUrl, propertyId)}${q ? `?${q}` : ""}`, token);
}

export async function fetchTicketDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, ticketId: string): Promise<TicketResumen & { readonly bitacora: readonly TicketEvento[] }> {
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${ticketId}`, token);
}

export interface NuevoTicket {
  readonly mensaje: string;
  readonly departamento?: TicketDepartamento;
  readonly prioridad?: TicketPrioridad;
}

export async function crearTicket(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NuevoTicket): Promise<TicketResumen> {
  return sendJson<TicketResumen>(fetchImpl, base(apiBaseUrl, propertyId), token, "POST", input);
}

export async function accionTicket(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, ticketId: string, accion: TicketAccion, body: { nota?: string } = {}): Promise<TicketResumen> {
  return sendJson<TicketResumen>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${ticketId}/${accion}`, token, "POST", body);
}

export async function reasignarTicket(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, ticketId: string, departamento: TicketDepartamento): Promise<TicketResumen> {
  return sendJson<TicketResumen>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${ticketId}/reasignar`, token, "POST", { departamento });
}

export async function fetchResenasPendientes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ readonly disponible: boolean; readonly resenas: readonly ResenaPendiente[] }> {
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/resenas-pendientes`, token);
}

export async function crearTicketDesdeResena(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, resenaId: string): Promise<TicketResumen> {
  return sendJson<TicketResumen>(fetchImpl, `${base(apiBaseUrl, propertyId)}/desde-resena`, token, "POST", { resenaId });
}

export async function fetchSla(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ readonly disponible: boolean; readonly efectiva: readonly SlaEfectiva[] }> {
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sla`, token);
}

export async function guardarSla(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { departamento: TicketDepartamento; prioridad: TicketPrioridad; minutos: number }): Promise<unknown> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sla`, token, "PUT", input);
}

/** Acciones que el rol puede ofrecer sobre un ticket segun su estado (el servidor decide en ultima instancia). */
export function accionesDisponibles(estado: TicketEstado, role: string, departamento: TicketDepartamento): readonly TicketAccion[] {
  if (estado === "cerrado" || estado === "cancelado") return [];
  const gestiona = TICKET_MANAGE_ROLES.has(role);
  if (!gestiona && role !== departamento) return [];
  const acciones: TicketAccion[] = [];
  if (estado === "abierto" || estado === "escalado") acciones.push("iniciar");
  acciones.push("cerrar");
  if (gestiona && estado !== "escalado") acciones.push("escalar");
  acciones.push("cancelar");
  return acciones;
}

export function formatearVencimiento(minutosParaVencer: number): string {
  const abs = Math.abs(minutosParaVencer);
  const texto = abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`;
  return minutosParaVencer >= 0 ? `vence en ${texto}` : `venció hace ${texto}`;
}
