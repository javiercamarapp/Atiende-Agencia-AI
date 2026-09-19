// Formato compartido del panel de citas — mismo criterio "honesto" que
// restaurantes/dashboard-client.ts: nunca inventa un cero/"—"/etiqueta cuando el
// dato real no vino, y nunca formatea con más precisión de la que el dato tiene.

export function formatMoneyFromCents(cents: number | null): string {
  if (cents === null) return "Sin precio";
  return `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// NOTA (revisión de PR #164, "no bloqueante" #3): `formatDateLong` la usa
// `Agenda.tsx` para DOS cosas de naturaleza distinta -- el encabezado de un día
// real de citas (`dayAppointments[0]!.startsAt`, un timestamp real) Y la etiqueta
// "Semana del ..." (`from.toISOString()`, un valor de solo-FECHA anclado a
// medianoche UTC, mismo criterio que `parseFechaSolo` de `formato-fecha.ts`).
// Fijar aquí una sola `timeZone` serviría a un caso y rompería el otro (una fecha
// anclada a UTC formateada en `America/Mexico_City` se corre un día, el MISMO bug
// que se busca arreglar) -- por eso el fix real vive en el call site de Agenda.tsx
// (`computeRange`), NO aquí: no toca estos formatters compartidos.
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("es-MX", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const DATE_FORMATTER = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long" });
const TIME_FORMATTER = new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit" });

export function formatDateTime(iso: string): string {
  return DATE_TIME_FORMATTER.format(new Date(iso));
}

export function formatDateLong(iso: string): string {
  return DATE_FORMATTER.format(new Date(iso));
}

export function formatTimeRange(startsAtIso: string, endsAtIso: string): string {
  return `${TIME_FORMATTER.format(new Date(startsAtIso))} – ${TIME_FORMATTER.format(new Date(endsAtIso))}`;
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
