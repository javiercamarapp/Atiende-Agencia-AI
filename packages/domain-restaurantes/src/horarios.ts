// Horario por sucursal (turnos, doble turno, cierre pasada la medianoche) y la funcion
// "abierto ahora" en la zona horaria del NEGOCIO -- nunca la del reloj del proceso (Vercel
// corre en UTC: a las 19:00 de Merida ya es "manana" en UTC).
//
// Forma de un turno (la que guarda `restaurantes.branch_policy.horario`, jsonb):
//   { dias: [0..6], abre: "HH:MM", cierra: "HH:MM" }
// - `dias`: 0 = domingo .. 6 = sabado (mismo criterio que `Date#getDay()` y `promotions.ts`).
//   Es el dia en que el turno EMPIEZA.
// - `cierra <= abre` significa que el turno cruza la medianoche y termina al dia siguiente
//   (PM: abre 12:00, cierra 01:00 => el turno del viernes termina el sabado a la 01:00).
// - Doble turno = dos entradas (ej. 12:00-16:00 y 18:00-01:00).
// `abre === cierra` se rechaza: seria ambiguo entre "24 horas" y "nunca abre".
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { OrderValidationError } from "./errors.ts";

export interface TurnoHorario {
  readonly dias: readonly number[];
  readonly abre: string;
  readonly cierra: string;
}

export type HorarioSucursal = readonly TurnoHorario[];

const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTOS_DIA = 24 * 60;
const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;
const MAX_TURNOS = 28;

function aMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Valida la forma de un horario que viene de la API o de la base. Lanza
 * `OrderValidationError` con un mensaje accionable; nunca normaliza en silencio. */
export function validarHorario(raw: unknown): HorarioSucursal {
  if (!Array.isArray(raw)) throw new OrderValidationError("El horario debe ser una lista de turnos.");
  if (raw.length > MAX_TURNOS) throw new OrderValidationError(`El horario admite como máximo ${MAX_TURNOS} turnos.`);
  return raw.map((turno, index) => {
    const t = turno as Partial<TurnoHorario> | null;
    const n = index + 1;
    if (!t || typeof t !== "object") throw new OrderValidationError(`Turno ${n}: formato inválido.`);
    if (!Array.isArray(t.dias) || t.dias.length === 0 || t.dias.length > 7 || t.dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new OrderValidationError(`Turno ${n}: 'dias' debe ser una lista de números 0 (domingo) a 6 (sabado).`);
    }
    if (typeof t.abre !== "string" || !HORA_RE.test(t.abre) || typeof t.cierra !== "string" || !HORA_RE.test(t.cierra)) {
      throw new OrderValidationError(`Turno ${n}: 'abre' y 'cierra' deben tener formato HH:MM (24 horas).`);
    }
    if (t.abre === t.cierra) {
      throw new OrderValidationError(`Turno ${n}: 'abre' y 'cierra' no pueden ser iguales.`);
    }
    return { dias: [...new Set(t.dias)].sort((a, b) => a - b), abre: t.abre, cierra: t.cierra };
  });
}

/** Como `validarHorario`, pero para un valor ya persistido: si esta corrupto devuelve
 * `null` (horario "no configurado") en vez de lanzar -- nunca se bloquea un pedido por un
 * dato viejo ilegible. */
export function leerHorarioPersistido(raw: unknown): HorarioSucursal | null {
  if (raw === null || raw === undefined) return null;
  try {
    return validarHorario(raw);
  } catch {
    return null;
  }
}

const CACHE_FORMATTER: Map<string, Intl.DateTimeFormat> = new Map();
const WEEKDAY_TO_DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(zonaHoraria: string): Intl.DateTimeFormat {
  let f = CACHE_FORMATTER.get(zonaHoraria);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zonaHoraria, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    CACHE_FORMATTER.set(zonaHoraria, f);
  }
  return f;
}

/** Dia de la semana (0-6) y minutos desde medianoche en la zona horaria del negocio. */
export function componentesLocales(instante: Date, zonaHoraria: string): { readonly dia: number; readonly minutos: number } {
  const parts = formatter(zonaHoraria).formatToParts(instante);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { dia: WEEKDAY_TO_DAY[weekday] ?? 0, minutos: hour * 60 + minute };
}

export interface EstadoApertura {
  readonly abierto: boolean;
  /** Cuando esta abierto: hora (HH:MM) en que cierra el turno vigente. */
  readonly cierraA: string | null;
  /** Cuando esta cerrado: próxima apertura dentro de los proximos 7 dias. */
  readonly proximaApertura: { readonly dia: string; readonly hora: string; readonly hoy: boolean } | null;
}

/**
 * ¿Está la sucursal abierta en `instante`? Usa la zona horaria del negocio
 * (`resolverZonaHorariaNegocio`: cae al default de plataforma si la sucursal no tiene una
 * valida). Un turno que cruza la medianoche cuenta para el dia siguiente hasta su hora de
 * cierre.
 */
export function estaAbiertoAhora(horario: HorarioSucursal, instante: Date = new Date(), zonaHorariaSucursal?: string | null): EstadoApertura {
  const zona = resolverZonaHorariaNegocio(zonaHorariaSucursal);
  const { dia, minutos } = componentesLocales(instante, zona);
  const diaAnterior = (dia + 6) % 7;

  for (const turno of horario) {
    const abre = aMinutos(turno.abre);
    const cierra = aMinutos(turno.cierra);
    const cruza = cierra <= abre;
    // Tramo del mismo dia en que empieza el turno.
    if (turno.dias.includes(dia) && minutos >= abre && (cruza || minutos < cierra)) {
      return { abierto: true, cierraA: turno.cierra, proximaApertura: null };
    }
    // Cola de un turno que empezo AYER y cruzo la medianoche.
    if (cruza && turno.dias.includes(diaAnterior) && minutos < cierra) {
      return { abierto: true, cierraA: turno.cierra, proximaApertura: null };
    }
  }

  // Cerrado: busca la próxima apertura (hoy mas tarde o en los siguientes 7 dias).
  let mejor: { offset: number; minutos: number; hora: string } | null = null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const diaObjetivo = (dia + offset) % 7;
    for (const turno of horario) {
      if (!turno.dias.includes(diaObjetivo)) continue;
      const abre = aMinutos(turno.abre);
      if (offset === 0 && abre <= minutos) continue;
      const absoluto = offset * MINUTOS_DIA + abre;
      if (!mejor || absoluto < mejor.offset * MINUTOS_DIA + mejor.minutos) mejor = { offset, minutos: abre, hora: turno.abre };
    }
  }
  return {
    abierto: false,
    cierraA: null,
    proximaApertura: mejor ? { dia: DIAS_SEMANA[(dia + mejor.offset) % 7]!, hora: mejor.hora, hoy: mejor.offset === 0 } : null,
  };
}

/** Mensaje claro para el cliente cuando la sucursal está cerrada. */
export function mensajeSucursalCerrada(nombreSucursal: string, estado: EstadoApertura): string {
  if (!estado.proximaApertura) return `La sucursal ${nombreSucursal} está cerrada en este momento.`;
  const { dia, hora, hoy } = estado.proximaApertura;
  return `La sucursal ${nombreSucursal} está cerrada en este momento; abre ${hoy ? "hoy" : `el ${dia}`} a las ${hora}.`;
}
