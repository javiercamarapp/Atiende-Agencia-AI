// Rango y agrupacion de la Agenda en la zona del NEGOCIO (ver zona-negocio.ts). `anchor` es un valor de solo-FECHA anclado a medianoche UTC
// (mismo criterio que `parseFechaSolo`): sus getters `UTC*` dan el dia de calendario; el rango que se pide al servidor es de la medianoche
// LOCAL del negocio a la medianoche LOCAL del negocio, igual que `computeCitasResumen`.
import { fechaEnZona, instanteDeHoraLocal, sumarDias } from "./zona-negocio.ts";

export type ViewMode = "month" | "week";

const FORMATO_RANGO_LARGO = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const FORMATO_RANGO_MES = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" });

function fechaDeAnchor(anchor: Date): string {
  return anchor.toISOString().slice(0, 10);
}

export function startOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = domingo
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day)); // la semana empieza en lunes
  return d;
}

export function computeRange(anchor: Date, view: ViewMode, zona: string): { fromIso: string; toIso: string; label: string } {
  if (view === "week") {
    const desde = fechaDeAnchor(startOfWeek(anchor));
    return {
      fromIso: instanteDeHoraLocal(desde, "00:00", zona).toISOString(),
      toIso: instanteDeHoraLocal(sumarDias(desde, 7), "00:00", zona).toISOString(),
      label: `Semana del ${FORMATO_RANGO_LARGO.format(new Date(`${desde}T00:00:00.000Z`))}`,
    };
  }
  const primero = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const siguiente = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  return {
    fromIso: instanteDeHoraLocal(fechaDeAnchor(primero), "00:00", zona).toISOString(),
    toIso: instanteDeHoraLocal(fechaDeAnchor(siguiente), "00:00", zona).toISOString(),
    label: FORMATO_RANGO_MES.format(primero),
  };
}

export function shiftAnchor(anchor: Date, view: ViewMode, direction: 1 | -1): Date {
  const d = new Date(anchor);
  if (view === "week") d.setUTCDate(d.getUTCDate() + 7 * direction);
  else d.setUTCMonth(d.getUTCMonth() + direction);
  return d;
}

/** Agrupa por dia LOCAL del negocio (no por `startsAt.slice(0, 10)`, que es el dia UTC: una cita de las 19:00 de Merida cae al dia siguiente). */
export function groupByDay<T extends { readonly startsAt: string }>(appointments: readonly T[], zona: string): ReadonlyArray<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const apt of appointments) {
    const dayKey = fechaEnZona(apt.startsAt, zona);
    const list = groups.get(dayKey) ?? [];
    list.push(apt);
    groups.set(dayKey, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
