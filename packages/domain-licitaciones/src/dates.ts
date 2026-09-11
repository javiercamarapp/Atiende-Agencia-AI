// Utilidades de fecha — port de licitaciones/apps/api/src/lib/expediente/dates.ts
// (ver diseño Fase 1 §3.1/§0 fila 6). `resolveExpedienteAsOfIso` es el guardia
// anti-manipulación de fecha (AE-01), transversal a los Flujos 1 y 2: la fecha
// de evaluación de vigencia de tarifas/documentos NUNCA la decide el cliente,
// SIEMPRE se deriva de `tender.submissionDeadline` — la versión vigente de la
// convocatoria, ya resuelta por el repositorio. Cualquier `asOfIso` que el
// cliente mande en el cuerpo de una petición se ignora por completo.
import { SubmissionDeadlineUnknownError } from "./errors.ts";
import type { TenderRecord } from "./types.ts";

const MEXICO_CITY_OFFSET = "-06:00";

/** Normaliza un valor de columna `timestamptz`/`date` (Date o string) a "YYYY-MM-DD". */
function datePartOf(value: string | Date): string {
  const iso = value instanceof Date ? value.toISOString() : value;
  const match = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    throw new Error(`Valor de fecha no reconocible: ${JSON.stringify(value)}`);
  }
  return match[1]!;
}

/** Ancla una columna `date` (sin hora, p. ej. `valid_until`) a America/Mexico_City (offset fijo `-06:00`: México no tiene horario de verano nacional desde 2022). `edge: "end"` para vigencias/plazos (vigente HASTA el final de ese día), `"start"` para inicios de vigencia. */
export function dateOnlyToMexicoCityIso(value: string | Date | null, edge: "start" | "end"): string | null {
  if (value === null || value === undefined) return null;
  const datePart = datePartOf(value);
  return edge === "end" ? `${datePart}T23:59:59${MEXICO_CITY_OFFSET}` : `${datePart}T00:00:00${MEXICO_CITY_OFFSET}`;
}

/** Convierte cualquier `timestamptz` (Date o string ISO) a un string ISO con offset explícito. */
export function timestampToIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * REQ-LIC-001/AE-01: deriva SIEMPRE `asOfIso` de `tender.submissionDeadline`
 * — nunca de un valor que mande el cliente, nunca de "ahora". Si la
 * convocatoria todavía no tiene `submissionDeadline` fijado, lanza
 * `SubmissionDeadlineUnknownError` (422 en la ruta) en vez de aproximar con
 * "ahora", que reabriría exactamente el patrón que este guardia cierra.
 */
export function resolveExpedienteAsOfIso(tender: TenderRecord): string {
  const iso = timestampToIso(tender.submissionDeadline);
  if (iso === null) throw new SubmissionDeadlineUnknownError();
  return iso;
}
