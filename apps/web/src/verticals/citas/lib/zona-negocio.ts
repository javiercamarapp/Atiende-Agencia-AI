// Zona horaria del NEGOCIO para el panel de citas. El navegador del staff puede estar en otra zona (Tijuana viendo una clinica de Merida) y el
// servidor guarda instantes UTC: dia, rango y hora de una cita se calculan SIEMPRE en la zona del negocio (la que ya usa Resumen y el motor de
// disponibilidad), nunca en la del navegador ni en UTC. Funciones puras, sin red.

/** Misma zona por omision que `resolverZonaHorariaNegocio` del servidor y que `hoyFechaSolo`. */
export const ZONA_NEGOCIO_POR_OMISION = "America/Mexico_City";

/** Una zona IANA valida (o la de omision): una cadena corrupta nunca debe tirar el panel con un RangeError. */
export function zonaNegocioValida(zona: string | null | undefined): string {
  if (!zona || !zona.trim()) return ZONA_NEGOCIO_POR_OMISION;
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: zona });
    return zona;
  } catch {
    return ZONA_NEGOCIO_POR_OMISION;
  }
}

/** "YYYY-MM-DD" de un instante, leido en la zona del negocio. */
export function fechaEnZona(instante: Date | string, zona: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instante));
}

function relojDePared(instante: Date, zona: string): number {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instante);
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
}

/** Instante UTC real de una hora de pared local ("YYYY-MM-DD" + "HH:MM") en `zona` (mismo algoritmo de punto fijo que `zonedTimeToUtc` del dominio). */
export function instanteDeHoraLocal(fecha: string, hhmm: string, zona: string): Date {
  const [y, m, d] = fecha.split("-").map(Number) as [number, number, number];
  const [h, min] = hhmm.split(":").map(Number) as [number, number];
  const objetivo = Date.UTC(y, m - 1, d, h, min, 0);
  let conjetura = objetivo;
  for (let i = 0; i < 3; i += 1) {
    const diff = objetivo - relojDePared(new Date(conjetura), zona);
    if (diff === 0) break;
    conjetura += diff;
  }
  return new Date(conjetura);
}

/** El valor de un `<input type="datetime-local">` ("YYYY-MM-DDTHH:MM") es hora de pared SIN zona: se interpreta en la zona del negocio. `null` si no es valido. */
export function datetimeLocalAIso(valor: string, zona: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(valor);
  if (!m) return null;
  const instante = instanteDeHoraLocal(m[1]!, m[2]!, zona);
  return Number.isNaN(instante.getTime()) ? null : instante.toISOString();
}

export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}
