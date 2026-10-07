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
export function estaAbiertoAhora(
  horario: HorarioSucursal,
  instante: Date = new Date(),
  zonaHorariaSucursal?: string | null,
  /** Horario que rigio AYER (puentes: una excepcion de fecha puede cambiar el turno que cruzo la
   * medianoche). Sin valor se usa `horario`, igual que antes. */
  horarioAyer: HorarioSucursal = horario,
): EstadoApertura {
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
  }
  // Cola de un turno que empezo AYER (con el horario que rigio ayer) y cruzo la medianoche.
  for (const turno of horarioAyer) {
    const cierra = aMinutos(turno.cierra);
    if (cierra <= aMinutos(turno.abre) && turno.dias.includes(diaAnterior) && minutos < cierra) {
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

/** Etiqueta legible de un instante en la zona del negocio ("sábado 03/10 14:30"), para mensajes de pedidos
 * programados: la misma hora que el cliente eligio, nunca la del proceso (UTC en Vercel). */
export function etiquetaHoraLocal(instante: Date, zonaHoraria: string): string {
  const { dia, minutos } = componentesLocales(instante, zonaHoraria);
  const fecha = fechaLocal(instante, zonaHoraria);
  const hh = String(Math.floor(minutos / 60)).padStart(2, "0");
  const mm = String(minutos % 60).padStart(2, "0");
  return `${DIAS_SEMANA[dia]} ${fecha.slice(8, 10)}/${fecha.slice(5, 7)} ${hh}:${mm}`;
}

/** Mensaje cuando la hora PROGRAMADA cae fuera del horario de la sucursal. */
export function mensajeProgramadoFueraDeHorario(nombreSucursal: string, etiquetaHora: string, estado: EstadoApertura): string {
  const base = `La sucursal ${nombreSucursal} no atiende a la hora elegida (${etiquetaHora}).`;
  if (!estado.proximaApertura) return `${base} Elija otra hora dentro de su horario.`;
  const { dia, hora, hoy } = estado.proximaApertura;
  return `${base} La siguiente apertura es ${hoy ? "ese mismo día" : `el ${dia}`} a las ${hora}: elija una hora dentro del horario.`;
}

// ---------------------------------------------------------------------------
// Puentes: excepciones de horario por FECHA (migracion 031) y dia de negocio.
// ---------------------------------------------------------------------------

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS_EXCEPCION = 31;

function fechaValida(fecha: string): boolean {
  if (!FECHA_RE.test(fecha)) return false;
  const [y, m, d] = fecha.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Fecha local (YYYY-MM-DD) del instante en la zona del negocio. */
export function fechaLocal(instante: Date, zonaHoraria: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zonaHoraria, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instante);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Dia anterior de una fecha YYYY-MM-DD (aritmetica UTC pura: no depende de ninguna zona). */
export function fechaAnterior(fecha: string): string {
  const t = new Date(Date.parse(`${fecha}T00:00:00Z`) - 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** Valida los datos de una excepcion de horario (fechas reales, rango <= 31 dias, horario valido; `[]` = cerrado todo el rango). */
export function validarExcepcionHorario(raw: { readonly fechaDesde: unknown; readonly fechaHasta: unknown; readonly horario: unknown; readonly motivo?: unknown }): {
  readonly fechaDesde: string;
  readonly fechaHasta: string;
  readonly horario: HorarioSucursal;
  readonly motivo: string | null;
} {
  const { fechaDesde, fechaHasta } = raw;
  if (typeof fechaDesde !== "string" || typeof fechaHasta !== "string" || !fechaValida(fechaDesde) || !fechaValida(fechaHasta)) {
    throw new OrderValidationError("Las fechas de la excepción deben ser reales y tener formato AAAA-MM-DD.");
  }
  if (fechaHasta < fechaDesde) throw new OrderValidationError("La fecha final no puede ser anterior a la inicial.");
  if (diasEntre(fechaDesde, fechaHasta) > MAX_DIAS_EXCEPCION) {
    throw new OrderValidationError(`Una excepción de horario cubre como máximo ${MAX_DIAS_EXCEPCION} días (un puente, no un cambio permanente).`);
  }
  const horario = validarHorario(raw.horario);
  // QA-restaurantes-R1-caos-16: un horario vacio es un cierre COMPLETO del rango (feriado, corte de luz): la sucursal no abre
  // esas fechas para storefront, WhatsApp ni voz (aplicarReglasDeSucursal ya trata una excepcion que cubre hoy como horario vigente).
  let motivo: string | null = null;
  if (raw.motivo !== undefined && raw.motivo !== null) {
    if (typeof raw.motivo !== "string" || raw.motivo.trim().length === 0 || raw.motivo.length > 200) {
      throw new OrderValidationError("El motivo debe tener entre 1 y 200 caracteres.");
    }
    motivo = raw.motivo.trim();
  }
  return { fechaDesde, fechaHasta, horario, motivo };
}

/** Horario de PUENTE: los turnos indicados rigen TODOS los dias del rango. Parametrizable: las horas del
 * cambio de turno las define el negocio (no se asumen aqui). */
export function horarioDePuente(turnos: readonly { readonly abre: string; readonly cierra: string }[]): HorarioSucursal {
  return validarHorario(turnos.map((t) => ({ dias: [0, 1, 2, 3, 4, 5, 6], abre: t.abre, cierra: t.cierra })));
}

/** Horario vigente para una FECHA local: la excepcion que la cubre (la mas reciente si hay varias) o el semanal. */
export function horarioParaFecha(base: HorarioSucursal, excepciones: readonly { readonly fechaDesde: string; readonly fechaHasta: string; readonly horario: HorarioSucursal }[], fecha: string): HorarioSucursal {
  const cubre = excepciones.filter((e) => e.fechaDesde <= fecha && fecha <= e.fechaHasta);
  if (cubre.length === 0) return base;
  return cubre.reduce((a, b) => (b.fechaDesde > a.fechaDesde ? b : a)).horario;
}

export interface ApreturaConExcepciones {
  readonly estado: EstadoApertura;
  /** Dia de la semana (0-6) del DIA DE NEGOCIO: la cola de un turno que cruzo la medianoche (p. ej.
   * 00:30 del martes con turno 18:00-01:00 del lunes) pertenece al dia en que el turno EMPEZO. */
  readonly diaNegocio: number;
  readonly fechaNegocio: string;
}

/**
 * Apertura y dia de negocio de un instante considerando excepciones por fecha (puentes). El turno
 * que empezo ayer se evalua con el horario que rigio AYER; el de hoy con el de HOY.
 */
export function aperturaConExcepciones(
  horario: HorarioSucursal,
  excepciones: readonly { readonly fechaDesde: string; readonly fechaHasta: string; readonly horario: HorarioSucursal }[],
  instante: Date,
  zonaHorariaSucursal?: string | null,
): ApreturaConExcepciones {
  const zona = resolverZonaHorariaNegocio(zonaHorariaSucursal);
  const hoy = fechaLocal(instante, zona);
  const ayer = fechaAnterior(hoy);
  const horarioHoy = horarioParaFecha(horario, excepciones, hoy);
  const horarioAyer = horarioParaFecha(horario, excepciones, ayer);
  const estado = estaAbiertoAhora(horarioHoy, instante, zona, horarioAyer);
  const { dia, minutos } = componentesLocales(instante, zona);
  const diaAnterior = (dia + 6) % 7;
  const enColaDeAyer = horarioAyer.some((t) => {
    const cierra = aMinutos(t.cierra);
    return cierra <= aMinutos(t.abre) && t.dias.includes(diaAnterior) && minutos < cierra;
  });
  // Solo es "dia de ayer" si ese turno de ayer es realmente el que tiene abierta la sucursal ahora.
  const diaNegocio = estado.abierto && enColaDeAyer && !horarioHoy.some((t) => t.dias.includes(dia) && minutos >= aMinutos(t.abre)) ? diaAnterior : dia;
  return { estado, diaNegocio, fechaNegocio: diaNegocio === dia ? hoy : ayer };
}

// ---------------------------------------------------------------------------
// Dia de negocio por CORTE (QA R2 automatizacion-02/08/11). Misma regla que `restaurantes.dia_negocio` de la migracion 076:
// el corte es la hora de cierre mas tardia, despues de medianoche, de los turnos que cruzan la medianoche (PM 12:00-01:00 => 60 min) y el dia de
// negocio de un instante es la fecha local de (instante - corte). No considera excepciones por fecha (igual que SQL).
// ---------------------------------------------------------------------------

/** Minutos despues de medianoche en que termina el dia de negocio (0 si ningun turno cruza la medianoche). */
export function corteDiaNegocioMinutos(horario: HorarioSucursal | null | undefined): number {
  let corte = 0;
  for (const t of horario ?? []) {
    const cierra = aMinutos(t.cierra);
    if (cierra <= aMinutos(t.abre)) corte = Math.max(corte, cierra);
  }
  return corte;
}

/** Dia de negocio (YYYY-MM-DD) de un instante en la zona de la sucursal: el turno que cierra a la 01:00 sigue siendo el dia anterior. */
export function diaDeNegocio(instante: Date, zonaHoraria: string | null | undefined, horario: HorarioSucursal | null | undefined): string {
  const zona = resolverZonaHorariaNegocio(zonaHoraria);
  return fechaLocal(new Date(instante.getTime() - corteDiaNegocioMinutos(horario) * 60_000), zona);
}
