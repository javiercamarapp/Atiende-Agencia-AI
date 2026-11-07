// Formato compartido del panel de citas — mismo criterio "honesto" que
// restaurantes/dashboard-client.ts: nunca inventa un cero/"—"/etiqueta cuando el
// dato real no vino, y nunca formatea con más precisión de la que el dato tiene.

import { etiquetasTraducidas, formatMoney, localeActivo, traductorActivo } from "@atiende/ui";
import { citasComun } from "@atiende/ui/i18n/citas/comun";
import { primerNombreOCorreo, saludoPorHora } from "../../../lib/greeting.ts";

const tr = traductorActivo(citasComun);

/** "Buenos días" / "Buenas tardes" / "Buenas noches" (misma regla de hora que `saludoPorHora`) en el idioma activo. */
export function saludoTraducido(fecha: Date = new Date()): string {
  const s = saludoPorHora(fecha); // i18n-ignorar (se compara con el literal de greeting.ts, no se pinta)
  return tr(s === "Buenos días" ? "citas.saludo.manana" : s === "Buenas tardes" ? "citas.saludo.tarde" : "citas.saludo.noche");
}

/** Saludo completo — "Buenos días, Ana" — en el idioma activo (el nombre queda tal cual). */
export function saludoConNombreTraducido(fullName: string | undefined, email: string, fecha: Date = new Date()): string {
  return `${saludoTraducido(fecha)}, ${primerNombreOCorreo(fullName, email)}`;
}

export function formatMoneyFromCents(cents: number | null): string {
  if (cents === null) return tr("citas.sinPrecio");
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
// Locale activo de la consola (i18n): es-MX como siempre, en-US si se eligio ingles. Un formateador por idioma (cache).
const formateadores = new Map<string, Intl.DateTimeFormat>();
function formateador(nombre: string, opciones: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = localeActivo();
  const clave = `${nombre}|${locale}`;
  let f = formateadores.get(clave);
  if (!f) formateadores.set(clave, (f = new Intl.DateTimeFormat(locale, opciones)));
  return f;
}
const DATE_TIME_OPCIONES: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
const DATE_OPCIONES: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" };
const TIME_OPCIONES: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

export function formatDateTime(iso: string): string {
  return formateador("fechaHora", DATE_TIME_OPCIONES).format(new Date(iso));
}

export function formatDateLong(iso: string): string {
  return formateador("fecha", DATE_OPCIONES).format(new Date(iso));
}

export function formatTimeRange(startsAtIso: string, endsAtIso: string): string {
  const hora = formateador("hora", TIME_OPCIONES);
  return `${hora.format(new Date(startsAtIso))} – ${hora.format(new Date(endsAtIso))}`;
}

type DiaSemana = "0" | "1" | "2" | "3" | "4" | "5" | "6";
/** Domingo..Sabado (0-6) en el idioma activo: cada lectura traduce. */
const DAY_NAMES: Readonly<Record<string, string>> = etiquetasTraducidas<DiaSemana>(["0", "1", "2", "3", "4", "5", "6"], (d) => `citas.dia.${d}` as const, citasComun);

export function formatDayOfWeek(dayOfWeek: number): string {
  return DAY_NAMES[String(dayOfWeek)] ?? tr("citas.diaN", { n: dayOfWeek });
}

/** "09:00:00" -> "09:00" — la BD puede mandar segundos, el panel nunca los muestra. */
export function formatHHMM(time: string): string {
  return time.slice(0, 5);
}

type EstadoCita = "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
type FuenteCita = "voice" | "whatsapp" | "web" | "manual";
type EstadoSync = "pending" | "synced" | "error" | "invalid" | "pending_cancel" | "deleted";

/** Etiquetas en el idioma activo: cada lectura traduce (en espanol, el texto de siempre). */
export const STATUS_LABELS: Readonly<Record<string, string>> = etiquetasTraducidas<EstadoCita>(
  ["pending", "confirmed", "completed", "cancelled", "no_show"],
  (s) => `citas.estado.${s}` as const,
  citasComun,
);

export function formatAppointmentStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export const SOURCE_LABELS: Readonly<Record<string, string>> = etiquetasTraducidas<FuenteCita>(["voice", "whatsapp", "web", "manual"], (s) => `citas.fuente.${s}` as const, citasComun);

export function formatAppointmentSource(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

// Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — estado de
// sincronización de calendario POR CITA (google_sync_status, ver
// @atiende/domain-citas::GoogleSyncStatus). `null`/`skipped` (sin calendario
// conectado) se tratan igual en la Agenda: no vale la pena un indicador cuando no
// hay nada que sincronizar.
export const GOOGLE_SYNC_STATUS_LABELS: Readonly<Record<string, string>> = etiquetasTraducidas<EstadoSync>(
  ["pending", "synced", "error", "invalid", "pending_cancel", "deleted"],
  (s) => `citas.sync.${s}` as const,
  citasComun,
);

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
