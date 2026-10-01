// H-06 -- calculo PURO de grupos (sin base): totales en centavos enteros con el MISMO redondeo que la migracion
// 036 (half-up sobre bigint/numeric), resumen de pickup y fecha local de la property para el cutoff. Lo usan el
// repositorio en memoria, la API (validacion previa, mensajes claros) y la pantalla.
import type { BlockNightRecord, PickupSummary, QuoteLineInput } from "./tipos.ts";
import { nightsBetween as stayNightDates } from "../quote.ts";
import { GruposInvalidInputError, MAX_GROUP_NIGHTS, MAX_QUOTE_LINES, MAX_RATE_CENTS, MAX_ROOMS_PER_LINE } from "./tipos.ts";

export const DEFAULT_GROUP_TIMEZONE = "America/Mexico_City";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha ISO `YYYY-MM-DD` valida (rechaza 2031-02-30). */
export function isGroupIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function dayNumber(iso: string): number {
  return Math.round(new Date(`${iso}T00:00:00Z`).getTime() / 86_400_000);
}

/** Cantidad de noches entre llegada y salida (la noche de salida no cuenta). */
export function groupNightCount(checkIn: string, checkOut: string): number {
  return dayNumber(checkOut) - dayNumber(checkIn);
}

/** Cada noche `[checkIn, checkOut)` como `YYYY-MM-DD` (reutiliza `nightsBetween` de quote.ts, fechas UTC puras). */
export function eachNight(checkIn: string, checkOut: string): string[] {
  return stayNightDates(checkIn, checkOut);
}

export interface QuoteTotals {
  readonly nights: number;
  readonly grossCents: number;
  readonly totalCents: number;
}

/**
 * total = round-half-up(bruto * (10000 - discountBps) / 10000), todo con BigInt (sin flotantes). Misma formula que
 * `hoteles.group_quote_create`. Lanza GruposInvalidInputError si algun dato es invalido o fuera de rango.
 */
export function computeQuoteTotals(lines: readonly QuoteLineInput[], checkIn: string, checkOut: string, discountBps: number): QuoteTotals {
  if (!isGroupIsoDate(checkIn) || !isGroupIsoDate(checkOut)) throw new GruposInvalidInputError("Fechas de llegada y salida invalidas (YYYY-MM-DD).");
  const nights = groupNightCount(checkIn, checkOut);
  if (nights < 1 || nights > MAX_GROUP_NIGHTS) throw new GruposInvalidInputError(`La estancia del grupo debe ser de 1 a ${MAX_GROUP_NIGHTS} noches.`);
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) throw new GruposInvalidInputError("El descuento (puntos base) debe ser un entero de 0 a 10000.");
  if (lines.length < 1 || lines.length > MAX_QUOTE_LINES) throw new GruposInvalidInputError(`Se esperan de 1 a ${MAX_QUOTE_LINES} renglones.`);
  const seen = new Set<string>();
  let gross = 0n;
  for (const line of lines) {
    if (!Number.isInteger(line.rooms) || line.rooms < 1 || line.rooms > MAX_ROOMS_PER_LINE) throw new GruposInvalidInputError(`Cuartos por renglon: entero de 1 a ${MAX_ROOMS_PER_LINE}.`);
    if (!Number.isInteger(line.rateCents) || line.rateCents < 0 || line.rateCents > MAX_RATE_CENTS) throw new GruposInvalidInputError("La tarifa debe ser un entero de centavos MXN (0 a 100000000), sin decimales.");
    if (seen.has(line.roomTypeId)) throw new GruposInvalidInputError("Tipo de habitacion repetido en la cotizacion.");
    seen.add(line.roomTypeId);
    gross += BigInt(line.rooms) * BigInt(line.rateCents) * BigInt(nights);
  }
  const total = (gross * BigInt(10_000 - discountBps) + 5_000n) / 10_000n;
  return { nights, grossCents: Number(gross), totalCents: Number(total) };
}

/** Resumen de pickup (confirmados vs bloqueados) a partir de las noches del bloqueo. */
export function summarizePickup(nights: readonly Pick<BlockNightRecord, "blockedRooms" | "pickedUpRooms" | "releasedRooms">[]): PickupSummary {
  let blocked = 0;
  let picked = 0;
  let released = 0;
  for (const n of nights) {
    blocked += n.blockedRooms;
    picked += n.pickedUpRooms;
    released += n.releasedRooms;
  }
  return {
    blockedRoomNights: blocked,
    pickedUpRoomNights: picked,
    releasedRoomNights: released,
    pendingRoomNights: Math.max(blocked - picked - released, 0),
    heldRoomNights: Math.max(blocked - released, 0),
    pickupPct: blocked === 0 ? 0 : Math.round((picked / blocked) * 1000) / 10,
  };
}

/** Fecha local `YYYY-MM-DD` de `now` en la zona IANA; zona nula o invalida cae a America/Mexico_City. */
export function localDateIn(now: Date, timeZone: string | null | undefined): string {
  for (const tz of [timeZone ?? DEFAULT_GROUP_TIMEZONE, DEFAULT_GROUP_TIMEZONE]) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      return `${get("year")}-${get("month")}-${get("day")}`;
    } catch {
      // zona invalida: intenta con el default de plataforma
    }
  }
  return now.toISOString().slice(0, 10);
}

/**
 * La fecha de liberacion es el PRIMER dia en que se liberan los cuartos no confirmados: desde las 00:00 locales de
 * la property del `cutoffDate` ya no hay pickup y el barrido libera. Misma regla que `group_release_due`.
 */
export function isCutoffReached(cutoffDate: string, now: Date, timeZone: string | null | undefined): boolean {
  return localDateIn(now, timeZone) >= cutoffDate;
}
