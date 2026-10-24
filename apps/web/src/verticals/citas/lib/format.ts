// Formato compartido del panel de citas — mismo criterio "honesto" que
// restaurantes/dashboard-client.ts: nunca inventa un cero/"—"/etiqueta cuando el
// dato real no vino, y nunca formatea con más precisión de la que el dato tiene.

import { formatMoney } from "@atiende/ui";

export function formatMoneyFromCents(cents: number | null): string {
  if (cents === null) return "Sin precio";
  // Una sola implementación del formato es-MX (separador de miles, 2 decimales): la de @atiende/ui.
  return `$${formatMoney(cents / 100)}`;
}

// Cada formateador acepta la zona IANA del NEGOCIO: la Agenda la pasa siempre (una cita a las 10:00 de Merida se ve 10:00 aunque el navegador este en
// Tijuana). Sin `timeZone` conserva el comportamiento de siempre (zona del navegador) para las pantallas que aun no la conocen. La etiqueta de rango
// "Semana del ..." NO usa estos formateadores (es un valor de solo-fecha anclado a UTC; ver lib/agenda-rango.ts).
const cacheFormatos = new Map<string, Intl.DateTimeFormat>();
function formato(clave: string, opciones: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  const k = `${clave}|${timeZone ?? ""}`;
  let f = cacheFormatos.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat("es-MX", { ...opciones, ...(timeZone ? { timeZone } : {}) });
    cacheFormatos.set(k, f);
  }
  return f;
}

export function formatDateTime(iso: string, timeZone?: string): string {
  return formato("dt", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }, timeZone).format(new Date(iso));
}

export function formatDateLong(iso: string, timeZone?: string): string {
  return formato("dl", { weekday: "long", day: "numeric", month: "long" }, timeZone).format(new Date(iso));
}

export function formatTimeRange(startsAtIso: string, endsAtIso: string, timeZone?: string): string {
  const f = formato("t", { hour: "2-digit", minute: "2-digit" }, timeZone);
  return `${f.format(new Date(startsAtIso))} – ${f.format(new Date(endsAtIso))}`;
}

export const DAY_NAMES: readonly string[] = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

export function formatDayOfWeek(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek] ?? `Día ${dayOfWeek}`;
}

/** "09:00:00" -> "09:00" — la BD puede mandar segundos, el panel nunca los muestra. */
export function formatHHMM(time: string): string {
  return time.slice(0, 5);
}

export const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  confirmed: "Confirmada",
  completed: "Completada",
  cancelled: "Cancelada",
  no_show: "No se presentó",
};

export function formatAppointmentStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export const SOURCE_LABELS: Record<string, string> = {
  voice: "Voz (agente)",
  whatsapp: "WhatsApp (agente)",
  web: "Web",
  manual: "Manual",
};

export function formatAppointmentSource(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

// Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — estado de
// sincronización de calendario POR CITA (google_sync_status, ver
// @atiende/domain-citas::GoogleSyncStatus). `null`/`skipped` (sin calendario
// conectado) se tratan igual en la Agenda: no vale la pena un indicador cuando no
// hay nada que sincronizar.
export const GOOGLE_SYNC_STATUS_LABELS: Record<string, string> = {
  pending: "Sincronización pendiente",
  synced: "Sincronizada",
  error: "Con problema de sincronización",
  invalid: "No sincronizada",
  pending_cancel: "Sincronización pendiente",
  deleted: "Sincronizada",
};

export function formatGoogleSyncStatus(status: string | null): string {
  if (!status) return "";
  return GOOGLE_SYNC_STATUS_LABELS[status] ?? status;
}

/** `true` solo para los 2 estados que de verdad ameritan un indicador visible en
 * la Agenda -- `pending`/`synced`/`skipped`/`deleted`/`pending_cancel` son ruido
 * (el flujo normal), `error`/`invalid` son los dos casos donde algo requiere
 * atención del staff (uno se resuelve solo con reintentos, el otro NO -- ver
 * `formatGoogleSyncStatus`/Agenda.tsx para el botón "Reintentar", solo para
 * 'invalid'). */
export function googleSyncStatusNeedsAttention(status: string | null): boolean {
  return status === "error" || status === "invalid";
}
