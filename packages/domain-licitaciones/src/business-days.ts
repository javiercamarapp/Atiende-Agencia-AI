// Motor determinista de días hábiles — Fase 6 (REQ-051/REQ-053), compartido
// por `contract-billing.ts` (plazo de pago, LAASSP Art. 73) e
// `inconformidad.ts` (plazo de inconformidad, LAASSP Art. 95). Port ~literal
// del criterio de `licitaciones/apps/api/src/lib/expediente/business-days.ts`
// del repo original (fuente de verdad): "día hábil" = lunes a viernes,
// excluyendo los días inhábiles que el llamador pasa en `holidays`.
// L-22: este módulo sigue sin traer codificado ningún calendario; el
// calendario efectivo (oficiales 2026-2027 + los de la organización y la
// convocatoria) lo arma `dias-inhabiles.ts::buildCalendarioPlazos` y TODAS las
// rutas que calculan plazos lo pasan aquí. Cada resultado trae su referencia
// legal y la nota del calendario usado, para que el consumidor HTTP nunca
// asuma un calendario más completo del que se aplicó.
/** Nota cuando el llamador NO pasó ningún día inhábil (solo fines de semana). */
export const CALENDAR_LIMITATION_NOTE = "Solo excluye sábados y domingos: no se aplicó ningún día inhábil (REQ-056). Use el calendario de días inhábiles de la organización para excluir los feriados oficiales y los que publique la convocante.";

import type { CalendarioPlazos } from "./dias-inhabiles.ts";

/** Lo que aceptan los calculos de plazo: una lista de fechas o el calendario efectivo completo (L-22). */
export type DiasInhabilesInput = readonly string[] | CalendarioPlazos;

export function holidayDatesOf(input: DiasInhabilesInput | undefined): readonly string[] {
  if (!input) return [];
  return Array.isArray(input) ? (input as readonly string[]) : (input as CalendarioPlazos).holidays;
}

/** Nota del calendario realmente aplicado: la del calendario efectivo, o la limitacion si no se paso ningun dia. */
export function calendarNoteOf(input: DiasInhabilesInput | undefined): string {
  if (input && !Array.isArray(input)) return (input as CalendarioPlazos).note;
  const dates = holidayDatesOf(input);
  return dates.length === 0
    ? CALENDAR_LIMITATION_NOTE
    : `Se excluyeron sábados, domingos y ${dates.length} día(s) inhábil(es) declarados por el llamador. Validar con fiscalista/abogado.`;
}

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
export function addBusinessDays(startIsoDate: string, businessDays: number, holidays: DiasInhabilesInput = []): string {
  if (!Number.isInteger(businessDays) || businessDays < 0) {
    throw new Error(`addBusinessDays: businessDays debe ser un entero >= 0, se recibió ${String(businessDays)}.`);
  }
  const holidaySet = new Set(holidayDatesOf(holidays));
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
