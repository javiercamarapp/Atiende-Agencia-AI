// Motor determinista de días hábiles — Fase 6 (REQ-051/REQ-053), compartido
// por `contract-billing.ts` (plazo de pago, LAASSP Art. 73) e
// `inconformidad.ts` (plazo de inconformidad, LAASSP Art. 95). Port ~literal
// del criterio de `licitaciones/apps/api/src/lib/expediente/business-days.ts`
// del repo original (fuente de verdad): "día hábil" = lunes a viernes,
// excluyendo feriados oficiales SOLO si el llamador los declara
// explícitamente en `holidays` — este módulo NUNCA trae codificado un
// calendario oficial de días inhábiles (REQ-056, calendario oficial SABG,
// está explícitamente FUERA de alcance de esta fase, ver README del
// vertical). Nunca un número "mágico" sin trazabilidad: cada resultado trae
// su referencia legal y esta limitación explícitas, para que el consumidor
// HTTP nunca asuma un calendario oficial completo.
export const CALENDAR_LIMITATION_NOTE = "Solo excluye sábados y domingos; el calendario oficial de días inhábiles (REQ-056, SABG) no está construido en esta fase — declare `holidays` explícitamente si necesita excluir feriados oficiales.";

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function toDateOnlyKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateOnly(isoDate: string, label: string): Date {
  const cursor = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) {
    throw new Error(`${label}: fecha inválida (se esperaba "YYYY-MM-DD" o un ISO con esa fecha al inicio): "${isoDate}".`);
  }
  return cursor;
}

/**
 * Suma `businessDays` días hábiles a `startIsoDate` (interpretado en UTC para
 * evitar deriva de zona horaria del proceso). `holidays` es una lista opcional
 * de fechas "YYYY-MM-DD" a excluir además de sábados/domingos. Fail-closed:
 * `businessDays` negativo o no entero lanza en vez de devolver una fecha sin
 * sentido.
 */
export function addBusinessDays(startIsoDate: string, businessDays: number, holidays: readonly string[] = []): string {
  if (!Number.isInteger(businessDays) || businessDays < 0) {
    throw new Error(`addBusinessDays: businessDays debe ser un entero >= 0, se recibió ${String(businessDays)}.`);
  }
  const holidaySet = new Set(holidays);
  const cursor = parseDateOnly(startIsoDate, "addBusinessDays(startIsoDate)");
  let remaining = businessDays;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (!isWeekend(cursor) && !holidaySet.has(toDateOnlyKey(cursor))) {
      remaining -= 1;
    }
  }
  return toDateOnlyKey(cursor);
}

/** Días de calendario transcurridos entre dos fechas "YYYY-MM-DD" (`to - from`, puede ser negativo). */
export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  const from = parseDateOnly(fromIsoDate, "daysBetween(fromIsoDate)").getTime();
  const to = parseDateOnly(toIsoDate, "daysBetween(toIsoDate)").getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}
