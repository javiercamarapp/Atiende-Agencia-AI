// Lógica de datos de Mantenimiento (Fase 7) — consume
// apps/api/src/routes/verticals/hoteles/housekeeping.ts (REQ-HK-011, tickets de
// mantenimiento correctivo). Los turnos de camaristas/lavandería (REQ-HK-008, LFT)
// quedan fuera de esta fase del panel: son un flujo de programación semanal propio
// (publicar plantilla + validación LFT), distinto en forma al resto de este panel
// (crear/listar/cerrar) — ver README del vertical para el detalle de qué queda
// pendiente.
import { fetchJson, sendJson } from "./admin-client.ts";

export type MaintenanceTicketOrigin = "huesped" | "staff" | "agente" | "sensor";
export type MaintenanceTicketSeverity = "alta" | "media" | "baja";
export type MaintenanceTicketStatus = "abierto" | "en_progreso" | "cerrado" | "cancelado";

export const TICKET_SEVERITY_LABELS: Record<MaintenanceTicketSeverity, string> = {
  alta: "Alta",
  media: "Media",
  baja: "Baja",
};

export const TICKET_STATUS_LABELS: Record<MaintenanceTicketStatus, string> = {
  abierto: "Abierto",
  en_progreso: "En progreso",
  cerrado: "Cerrado",
  cancelado: "Cancelado",
};

export interface MaintenanceTicketSummary {
  readonly id: string;
  readonly roomId: string | null;
  readonly titulo: string;
  readonly descripcion: string;
  readonly origen: MaintenanceTicketOrigin;
  readonly severidad: MaintenanceTicketSeverity;
  readonly estado: MaintenanceTicketStatus;
  readonly asignadoA: string | null;
  readonly costoEstimado: number;
  readonly costoReal: number | null;
  readonly notaResolucion: string | null;
  readonly creadoPor: string;
  readonly cerradoEn: string | null;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
}

export interface CreateTicketInput {
  readonly titulo: string;
  readonly descripcion: string;
  readonly severidad: MaintenanceTicketSeverity;
  readonly roomId?: string;
}

export async function fetchTickets(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, estado?: MaintenanceTicketStatus): Promise<readonly MaintenanceTicketSummary[]> {
  const qs = estado ? `?estado=${estado}` : "";
  return fetchJson<readonly MaintenanceTicketSummary[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/mantenimiento/tickets${qs}`, token);
}

export async function createTicket(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: CreateTicketInput): Promise<MaintenanceTicketSummary> {
  return sendJson<MaintenanceTicketSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/mantenimiento/tickets`, token, "POST", { ...input, origen: "staff" as MaintenanceTicketOrigin });
}

export async function closeTicket(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, ticketId: string, actualCost: number, notaResolucion?: string): Promise<MaintenanceTicketSummary> {
  return sendJson<MaintenanceTicketSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/mantenimiento/tickets/${ticketId}/cerrar`, token, "POST", { actualCost, notaResolucion });
}
