// Resolución de periodos del chat con datos, SIEMPRE en la zona horaria del negocio
// (America/Merida por defecto) y nunca en la del proceso (Vercel corre en UTC: a las
// 19:00 de Mérida ya es "mañana" en UTC). Un periodo ambiguo NO se adivina: el motor
// responde pidiendo aclaración. Semana = lunes a domingo. Ventanas [inicio, fin).
import type { ParamsSpec, ParsedArgs } from "./params.js";
import { isRealIsoDate } from "./params.js";

export const DEFAULT_DATA_CHAT_TIMEZONE = "America/Merida";

export const PERIOD_TOKENS = [
  "hoy",
  "ayer",
  "ultimos_7_dias",
  "ultimos_30_dias",
  "ultimos_90_dias",
  "esta_semana",
  "semana_pasada",
  "este_mes",
  "mes_pasado",
] as const;
export type PeriodToken = (typeof PERIOD_TOKENS)[number];

/** Parámetros estándar de periodo que cualquier herramienta con ventana de tiempo reutiliza. */
export const PERIOD_PARAMS: ParamsSpec = {
  periodo: {
    type: "enum",
    values: PERIOD_TOKENS,
    optional: true,
    description:
      "Periodo en la zona horaria del negocio. 'ultimos_7_dias' incluye hoy y los 6 días anteriores. 'esta_semana' va de lunes a hoy. Omítelo si usas desde/hasta; si la pregunta del usuario no dice el periodo, NO lo inventes: pregunta.",
  },
  desde: { type: "date", optional: true, description: "Primer día (inclusive) AAAA-MM-DD, solo si el usuario dio fechas exactas." },
  hasta: { type: "date", optional: true, description: "Último día (inclusive) AAAA-MM-DD, solo con 'desde'." },
};

export interface ResolvedPeriod {
  /** Instante de inicio (inclusive). */
  readonly start: Date;
  /** Instante de fin (exclusivo). */
  readonly end: Date;
  /** Primer día local inclusive AAAA-MM-DD. */
  readonly fromDate: string;
  /** Último día local inclusive AAAA-MM-DD. */
  readonly toDate: string;
  readonly timezone: string;
  /** Texto para mostrar al usuario, p.ej. "últimos 7 días (24 sep al 30 sep 2026)". */
  readonly label: string;
}

export type ResolvePeriodResult =
  | { readonly ok: true; readonly period: ResolvedPeriod }
  | { readonly ok: false; readonly kind: "needs_clarification" | "invalid"; readonly message: string };

export const MAX_PERIOD_DAYS = 366;
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function validTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_DATA_CHAT_TIMEZONE;
  }
}

function localDateParts(instant: Date, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Offset (ms) de la zona respecto a UTC en el instante dado. */
function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Instante en que empieza el día local y/m/d (00:00 en la zona). Soporta zonas con horario de verano. */
export function startOfLocalDay(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let result = guess - tzOffsetMs(new Date(guess), tz);
  const corrected = guess - tzOffsetMs(new Date(result), tz);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function addDaysYmd(v: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(v.y, v.m - 1, v.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function iso(v: Ymd): string {
  return `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
}

function parseIso(s: string): Ymd {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

function dayDiff(a: Ymd, b: Ymd): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

function weekday(v: Ymd): number {
  return new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay(); // 0=domingo
}

function shortDate(v: Ymd, withYear: boolean): string {
  return `${v.d} ${MESES[v.m - 1]}${withYear ? ` ${v.y}` : ""}`;
}

function build(from: Ymd, to: Ymd, tz: string, name: string): ResolvedPeriod {
  const start = startOfLocalDay(from.y, from.m, from.d, tz);
  const next = addDaysYmd(to, 1);
  const end = startOfLocalDay(next.y, next.m, next.d, tz);
  const same = iso(from) === iso(to);
  const range = same ? shortDate(from, true) : `${shortDate(from, from.y !== to.y)} al ${shortDate(to, true)}`;
  return { start, end, fromDate: iso(from), toDate: iso(to), timezone: tz, label: `${name} (${range})` };
}

/** Resuelve `periodo` o `desde`/`hasta`. Sin ninguno: pide aclaración (nunca asume un default). */
export function resolvePeriod(args: ParsedArgs, now: Date, timezone: string = DEFAULT_DATA_CHAT_TIMEZONE): ResolvePeriodResult {
  const tz = validTimezone(timezone);
  const lp = localDateParts(now, tz);
  const today: Ymd = { y: lp.y, m: lp.m, d: lp.d };
  const periodo = args["periodo"] as string | undefined;
  const desde = args["desde"] as string | undefined;
  const hasta = args["hasta"] as string | undefined;

  if (periodo !== undefined && (desde !== undefined || hasta !== undefined)) {
    return { ok: false, kind: "invalid", message: "Usa 'periodo' o 'desde'/'hasta', no ambos." };
  }
  if (periodo === undefined && desde === undefined && hasta === undefined) {
    return { ok: false, kind: "needs_clarification", message: "No me dijiste de qué periodo quieres los datos. ¿Hoy, ayer, esta semana, este mes o unas fechas exactas?" };
  }

  if (periodo !== undefined) {
    switch (periodo as PeriodToken) {
      case "hoy":
        return { ok: true, period: build(today, today, tz, "hoy") };
      case "ayer": {
        const y = addDaysYmd(today, -1);
        return { ok: true, period: build(y, y, tz, "ayer") };
      }
      case "ultimos_7_dias":
        return { ok: true, period: build(addDaysYmd(today, -6), today, tz, "últimos 7 días") };
      case "ultimos_30_dias":
        return { ok: true, period: build(addDaysYmd(today, -29), today, tz, "últimos 30 días") };
      case "ultimos_90_dias":
        return { ok: true, period: build(addDaysYmd(today, -89), today, tz, "últimos 90 días") };
      case "esta_semana": {
        const back = (weekday(today) + 6) % 7; // lunes = 0
        return { ok: true, period: build(addDaysYmd(today, -back), today, tz, "esta semana (lunes a hoy)") };
      }
      case "semana_pasada": {
        const back = (weekday(today) + 6) % 7;
        const monday = addDaysYmd(today, -back - 7);
        return { ok: true, period: build(monday, addDaysYmd(monday, 6), tz, "semana pasada (lunes a domingo)") };
      }
      case "este_mes":
        return { ok: true, period: build({ y: today.y, m: today.m, d: 1 }, today, tz, "este mes") };
      case "mes_pasado": {
        const first = { y: today.m === 1 ? today.y - 1 : today.y, m: today.m === 1 ? 12 : today.m - 1, d: 1 };
        const last = addDaysYmd({ y: today.y, m: today.m, d: 1 }, -1);
        return { ok: true, period: build(first, last, tz, "mes pasado") };
      }
      default:
        return { ok: false, kind: "invalid", message: "Periodo desconocido." };
    }
  }

  if (desde === undefined || hasta === undefined) {
    return { ok: false, kind: "needs_clarification", message: "Para fechas exactas necesito el día de inicio y el de fin." };
  }
  if (!isRealIsoDate(desde) || !isRealIsoDate(hasta)) return { ok: false, kind: "invalid", message: "Las fechas deben ser reales (AAAA-MM-DD)." };
  const from = parseIso(desde);
  const to = parseIso(hasta);
  if (dayDiff(from, to) < 0) return { ok: false, kind: "invalid", message: "La fecha de inicio es posterior a la de fin." };
  if (dayDiff(from, to) + 1 > MAX_PERIOD_DAYS) return { ok: false, kind: "invalid", message: `El periodo máximo es de ${MAX_PERIOD_DAYS} días.` };
  if (dayDiff(today, from) > 0) return { ok: false, kind: "invalid", message: "Ese periodo empieza en el futuro: todavía no hay datos." };
  return { ok: true, period: build(from, to, tz, "periodo indicado") };
}
