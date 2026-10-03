// Tabla `estado -> tono` de citas para <StatusBadge> de @atiende/ui (PR-4 del plan
// de diseno-ux, F-09): reemplaza los dos mapas `statusBadgeVariant` (Agenda y
// Staff) y los `variant=` sueltos. Un estado que la tabla aun no conoce cae a
// "neutral" (via `statusTone`) en vez de pintarse mal.
import type { StatusTone } from "@atiende/ui";

/** Estado de una cita (`appointments.status`). */
export const CITA_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  pending: "warning",
  confirmed: "info",
  completed: "success",
  cancelled: "danger",
  no_show: "neutral",
};

/** Estado de una invitacion de staff. */
export const INVITE_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  pending: "warning",
  accepted: "success",
  revoked: "danger",
  expired: "danger",
};

/** Google Calendar conectado: "error" -> danger; cualquier otro estado conectado -> success. */
export function syncTone(syncStatus: string | null | undefined): StatusTone {
  return syncStatus === "error" ? "danger" : "success";
}

/** Activo / inactivo de un servicio, proveedor o regla. */
export function activoTone(isActive: boolean): StatusTone {
  return isActive ? "success" : "neutral";
}

/** Estado de la toma de una conversacion de WhatsApp (bandeja de conversaciones, C-11). */
export const HANDOFF_ESTADO_TONES: Readonly<Record<string, StatusTone>> = {
  agente: "neutral",
  pendiente: "warning",
  tomada: "info",
  devuelta: "success",
  cerrada: "neutral",
};
