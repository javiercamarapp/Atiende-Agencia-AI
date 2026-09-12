// Formato compartido del panel de citas — mismo criterio "honesto" que
// restaurantes/dashboard-client.ts: nunca inventa un cero/"—"/etiqueta cuando el
// dato real no vino, y nunca formatea con más precisión de la que el dato tiene.

export function formatMoneyFromCents(cents: number | null): string {
  if (cents === null) return "Sin precio";
  return `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
