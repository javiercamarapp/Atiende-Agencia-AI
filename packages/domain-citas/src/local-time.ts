// Hora LOCAL del negocio para lo que ve el modelo (WhatsApp y voz). Un instante UTC ("...T15:00:00.000Z") le hace leer "15:00" a un modelo cuando el
// negocio abre a las 09:00: cada horario que sale hacia el agente lleva tambien su fecha y hora de pared en la zona del negocio.
import { zonedDateStr } from "./availability.ts";

export interface LocalTimeFields {
  /** "YYYY-MM-DD" en la zona del negocio. */
  readonly local_date: string;
  /** "HH:MM" (24 h) en la zona del negocio. */
  readonly local_time: string;
  /** Dia de la semana en espanol ("lunes"), en la zona del negocio. */
  readonly local_weekday: string;
  /** Zona IANA del negocio. */
  readonly timezone: string;
}

/** Postgres devuelve `timestamptz` como `Date` segun el driver; el dominio lo trata como ISO. */
export function toIsoInstant(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function localTimeFields(instant: string | Date, timeZone: string): LocalTimeFields {
  const date = new Date(toIsoInstant(instant));
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  const weekday = new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long" }).format(date);
  return { local_date: zonedDateStr(date, timeZone), local_time: hm, local_weekday: weekday, timezone: timeZone };
}

/** "lunes 13 de septiembre a las 10:00" en la zona del negocio (texto para el prompt). */
export function localDateTimeLabel(instant: string | Date, timeZone: string): string {
  const date = new Date(toIsoInstant(instant));
  const day = new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);
  return `${day} a las ${localTimeFields(date, timeZone).local_time}`;
}

const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/;

/** `true` solo si es un ISO 8601 con zona explicita (Z u offset) y es una fecha real. Una hora sin zona se leeria en la zona del SERVIDOR (UTC en Vercel). */
export function isIsoInstantWithZone(value: unknown): value is string {
  return typeof value === "string" && ISO_WITH_ZONE_RE.test(value.trim()) && !Number.isNaN(Date.parse(value.trim()));
}
