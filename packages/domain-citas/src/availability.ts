// Motor determinista de disponibilidad — port LITERAL (mismo algoritmo, mismo
// comportamiento ya probado en el origen) de
// citas-reservaciones/supabase/functions/_shared/availability-core.ts. Puro: sin
// red, sin base de datos — el caller (appointments.ts) junta rules/overrides/busy
// antes de llamar esto, así que este archivo es 100% unit-testeable sin Supabase ni
// Postgres. Ver diseño Fase 1 §0.7/§3.2: el algoritmo de conversión de timezone por
// punto fijo es delicado y ya está probado en el origen — reescribirlo sería
// exactamente el tipo de riesgo que este diseño busca evitar.
import type { AvailabilityOverride, AvailabilityRule, BusyInterval, Slot } from "./types.ts";

export interface ComputeAvailableSlotsInput {
  /** "YYYY-MM-DD", el día que se está consultando, en la hora local del negocio. */
  readonly dateStr: string;
  /** IANA timezone del tenant/sucursal (ej. "America/Mexico_City"). */
  readonly timeZone: string;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes?: number;
  readonly bufferAfterMinutes?: number;
  /** Reglas recurrentes del proveedor; se filtran aquí por día de la semana. */
  readonly rules: readonly AvailabilityRule[];
  /** Excepción puntual para `dateStr`, si existe (reemplaza a `rules`, no se combina). */
  readonly override?: AvailabilityOverride | null;
  /** Citas activas del proveedor que ya ocupan tiempo ese día. */
  readonly busy: readonly BusyInterval[];
  /** Punto de corte para no ofrecer slots ya pasados (default: ahora). */
  readonly now?: Date;
}

/**
 * Lee un Date en una zona horaria dada y devuelve los mismos números de
 * calendario/reloj interpretados como si fueran UTC. Es la mitad "UTC -> zonificado"
 * de la conversión; zonedTimeToUtc la usa dos veces por punto fijo para resolver la
 * mitad inversa (no existe una API estándar directa para "zonificado -> UTC" sin una
 * librería de fechas).
 */
function zonedWallClockAsUtcMillis(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/**
 * Convierte una hora de pared local ("YYYY-MM-DD" + "HH:MM[:SS]") en la timezone
 * dada al instante UTC real que representa. Converge por punto fijo (normalmente en
 * 1-2 iteraciones; 3 deja margen de sobra incluso cruzando un cambio de horario de
 * verano) porque no hay forma directa de invertir Intl.DateTimeFormat.
 */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  const [hour, minute, second = 0] = timeStr.split(":").map(Number) as [number, number, number?];
  const targetWallMillis = Date.UTC(year, month - 1, day, hour, minute, second);

  let guessMillis = targetWallMillis;
  for (let i = 0; i < 3; i += 1) {
    const asZonedWall = zonedWallClockAsUtcMillis(new Date(guessMillis), timeZone);
    const diff = targetWallMillis - asZonedWall;
    if (diff === 0) break;
    guessMillis += diff;
  }
  return new Date(guessMillis);
}

/** Día de la semana (0 = domingo) de `dateStr` interpretado en `timeZone`. */
export function dayOfWeekInTimeZone(dateStr: string, _timeZone: string): number {
  // El día calendario de dateStr, tal cual, ya está en la zona del negocio — solo
  // hace falta el día de la semana de esa fecha civil, sin volver a convertir
  // de/hacia UTC (evita que un huso con offset grande empuje la fecha al día
  // anterior/siguiente).
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Calcula los slots realmente libres de un día para un proveedor+servicio.
 * Determinista: misma entrada -> misma salida, siempre. No hace red, no lee la base
 * de datos — el caller es quien junta rules/overrides/busy antes de llamar esto.
 */
export function computeAvailableSlots(input: ComputeAvailableSlotsInput): Slot[] {
  const {
    dateStr,
    timeZone,
    durationMinutes,
    bufferBeforeMinutes = 0,
    bufferAfterMinutes = 0,
    rules,
    override,
    busy,
    now = new Date(),
  } = input;

  if (durationMinutes <= 0) return [];

  let windows: { start: string; end: string }[];
  if (override) {
    if (override.isClosed || !override.startTime || !override.endTime) {
      return [];
    }
    windows = [{ start: override.startTime, end: override.endTime }];
  } else {
    const weekday = dayOfWeekInTimeZone(dateStr, timeZone);
    windows = rules.filter((rule) => rule.isActive && rule.dayOfWeek === weekday).map((rule) => ({ start: rule.startTime, end: rule.endTime }));
  }

  const blockMs = (bufferBeforeMinutes + durationMinutes + bufferAfterMinutes) * 60_000;
  const durationMs = durationMinutes * 60_000;
  const bufferBeforeMs = bufferBeforeMinutes * 60_000;

  const slots: Slot[] = [];
  for (const window of windows) {
    const windowStart = zonedTimeToUtc(dateStr, window.start, timeZone);
    const windowEnd = zonedTimeToUtc(dateStr, window.end, timeZone);
    if (!(windowEnd > windowStart)) continue;

    let blockStart = windowStart.getTime();
    while (blockStart + blockMs <= windowEnd.getTime()) {
      const slotStart = blockStart + bufferBeforeMs;
      const slotEnd = slotStart + durationMs;
      const blockEnd = blockStart + blockMs;

      const isBusy = busy.some((b) => overlaps(new Date(blockStart), new Date(blockEnd), b.start, b.end));
      const isPast = slotStart < now.getTime();

      if (!isBusy && !isPast) {
        slots.push({ startsAt: new Date(slotStart).toISOString(), endsAt: new Date(slotEnd).toISOString() });
      }
      blockStart = blockEnd;
    }
  }

  return slots;
}

/**
 * Re-validación estricta usada por crear-cita/reagendar-cita: ¿el slot exacto que
 * pide el agente cae dentro de una ventana de disponibilidad real (regla u
 * override), sin traslape con una cita ya existente? Esta es la última verificación
 * de horario de negocio antes del INSERT/UPDATE — el EXCLUDE USING gist de la base
 * de datos sigue siendo la autoridad final anti-traslape, pero por sí solo no sabe
 * nada de horario de atención (aceptaría con gusto una cita a las 3am si nadie más
 * la ocupa).
 */
export function isSlotWithinAvailability(slotStart: Date, slotEnd: Date, input: Omit<ComputeAvailableSlotsInput, "busy" | "now" | "dateStr">): boolean {
  const dateStr = zonedDateStr(slotStart, input.timeZone);
  const slots = computeAvailableSlots({
    ...input,
    dateStr,
    busy: [],
    now: new Date(0), // no descartar por "ya pasó" aquí; eso lo valida el caller
  });
  return slots.some((slot) => new Date(slot.startsAt).getTime() === slotStart.getTime() && new Date(slot.endsAt).getTime() === slotEnd.getTime());
}

/** "YYYY-MM-DD" de un instante, leído en la timezone dada. */
export function zonedDateStr(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return formatter.format(date); // en-CA formatea como YYYY-MM-DD
}
