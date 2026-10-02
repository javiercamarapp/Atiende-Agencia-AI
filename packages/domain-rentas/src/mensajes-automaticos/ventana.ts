// Ventana de disparo de un mensaje automatico, en la zona horaria de la propiedad. Funcion
// pura (sin I/O): la misma regla que implementa la funcion SQL
// rentas.sistema_listar_mensajes_automaticos (verificada contra Postgres real en
// scripts/verify-rentas-mensajes-automaticos) y que el cron revalida en TypeScript.
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { ANCLA_EVENTO, VENTANA_GRACIA_HORAS } from "./tipos.ts";
import type { CandidatoMensajeAutomatico } from "./tipos.ts";

const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_HORA = 3_600_000;

/** Diferencia (ms) entre la hora de pared de `zona` y UTC en el instante `instante`. */
function desfaseZonaMs(instante: Date, zona: string): number {
  const partes = new Intl.DateTimeFormat("en-US", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instante);
  const n = (tipo: string): number => Number(partes.find((p) => p.type === tipo)?.value);
  const paredComoUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return paredComoUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

/**
 * Instante real (UTC) en que cae `fecha` a las 00:00 en `zona`, mas `offsetHoras` de HORA DE PARED
 * (no de reloj absoluto: respeta cambios de horario de verano, igual que `timestamp at time zone`
 * en Postgres). Una zona invalida cae al default de plataforma.
 */
export function instanteDisparo(fecha: string, offsetHoras: number, zonaHoraria: string): Date {
  const m = FECHA_RE.exec(fecha);
  if (!m) throw new Error(`Fecha invalida (formato esperado YYYY-MM-DD): "${fecha}"`);
  const zona = resolverZonaHorariaNegocio(zonaHoraria);
  const pared = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + offsetHoras * MS_HORA;
  let instante = pared;
  for (let i = 0; i < 3; i++) instante = pared - desfaseZonaMs(new Date(instante), zona);
  return new Date(instante);
}

export function instanteDisparoDeCandidato(c: Pick<CandidatoMensajeAutomatico, "evento" | "offsetHoras" | "checkIn" | "checkOut" | "zonaHoraria">): Date {
  const fecha = ANCLA_EVENTO[c.evento] === "check_in" ? c.checkIn : c.checkOut;
  return instanteDisparo(fecha, c.offsetHoras, c.zonaHoraria);
}

/** `true` si `disparo <= ahora < disparo + VENTANA_GRACIA_HORAS`. */
export function enVentanaDisparo(c: Pick<CandidatoMensajeAutomatico, "evento" | "offsetHoras" | "checkIn" | "checkOut" | "zonaHoraria">, ahora: Date): boolean {
  const disparo = instanteDisparoDeCandidato(c).getTime();
  const t = ahora.getTime();
  return disparo <= t && t < disparo + VENTANA_GRACIA_HORAS * MS_HORA;
}
