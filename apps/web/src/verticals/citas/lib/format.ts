// Formato compartido del panel de citas — mismo criterio "honesto" que
// restaurantes/dashboard-client.ts: nunca inventa un cero/"—"/etiqueta cuando el
// dato real no vino, y nunca formatea con más precisión de la que el dato tiene.

import { formatMoney } from "@atiende/ui";

export function formatMoneyFromCents(cents: number | null): string {
  if (cents === null) return "Sin precio";
  // Una sola implementación del formato es-MX (separador de miles, 2 decimales): la de @atiende/ui.
  return `$${formatMoney(cents / 100)}`;
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
// Zona horaria: con `timeZone` (la del NEGOCIO, la manda el servidor) las horas y los dias se pintan como los ve el negocio; sin ella, la del navegador (callers
// que todavia no la conocen). Un navegador en Tijuana operando una clinica de Merida veia las citas corridas una hora.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatter(clave: string, opciones: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  const llave = `${clave}|${timeZone ?? ""}`;
  let f = FORMATTERS.get(llave);
  if (!f) {
    f = new Intl.DateTimeFormat("es-MX", { ...opciones, ...(timeZone ? { timeZone } : {}) });
    FORMATTERS.set(llave, f);
  }
  return f;
}

export function formatDateTime(iso: string, timeZone?: string): string {
  return formatter("dt", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }, timeZone).format(new Date(iso));
}

export function formatDateLong(iso: string, timeZone?: string): string {
  return formatter("dl", { weekday: "long", day: "numeric", month: "long" }, timeZone).format(new Date(iso));
}

export function formatTimeRange(startsAtIso: string, endsAtIso: string, timeZone?: string): string {
  const f = formatter("t", { hour: "2-digit", minute: "2-digit" }, timeZone);
  return `${f.format(new Date(startsAtIso))} – ${f.format(new Date(endsAtIso))}`;
}

/** "YYYY-MM-DD" de un instante en la zona dada (la del negocio para agrupar la Agenda por dia; la del navegador si no hay zona). */
export function zonedDayKey(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
}

/** Diferencia (ms) entre la hora de pared de `timeZone` y UTC en el instante `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const partes = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(utcMs / 1000) * 1000;
}

/** Convierte lo que devuelve un `<input type="datetime-local">` ("2027-09-13T10:00", hora de pared SIN zona) al instante ISO en que ESA hora ocurre en
 * `timeZone` (la del negocio). Sin zona o con un valor invalido cae al comportamiento del navegador. */
export function wallTimeToIso(local: string, timeZone?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!timeZone || !m) return new Date(local).toISOString();
  const comoUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let instante = comoUtc - zoneOffsetMs(comoUtc, timeZone);
  instante = comoUtc - zoneOffsetMs(instante, timeZone); // segunda pasada: el offset puede cambiar entre los dos instantes (horario de verano)
  return new Date(instante).toISOString();
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
