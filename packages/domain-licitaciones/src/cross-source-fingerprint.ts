// Huella cruzada entre fuentes (paridad3 L-P3-14 / REQ-152). ESPEJO EXACTO de `licitaciones.tender_fingerprint` (migracion 037): la base es
// la fuente de verdad para Postgres (un trigger la calcula en cada escritura) y esta funcion la usa el repositorio en memoria y las pruebas.
// Los vectores dorados de `tests/cross-source-fingerprint.spec.ts` son los MISMOS que verifica `scripts/verify-licitaciones-dedupe-y-paginacion`.
import { createHash } from "node:crypto";

const MEXICO_TZ = "America/Mexico_City";

/** NFC, sin diacriticos (via NFD), MAYUSCULAS y espacios colapsados; `null` si queda vacio. Igual a `licitaciones.tender_norm_text`. */
export function normalizeTenderText(value: string | null | undefined): string | null {
  const text = (value ?? "").normalize("NFC").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** Fecha calendario (YYYY-MM-DD) del instante en hora de Mexico. */
export function mexicoCityDate(iso: string): string | null {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: MEXICO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface FingerprintInput {
  readonly procedureNumber: string | null | undefined;
  readonly contractingBody: string | null | undefined;
  /** ISO 8601 con offset explicito. */
  readonly submissionDeadline: string | null | undefined;
}

/**
 * sha256(procedimiento | convocante | fecha de presentacion en hora de Mexico), con el texto normalizado. `null` si falta cualquiera de los
 * tres datos: sin dato suficiente NO se deduplica (un duplicado visible es mejor que una fusion falsa).
 */
export function computeCrossSourceFingerprint(input: FingerprintInput): string | null {
  const procedure = normalizeTenderText(input.procedureNumber);
  const body = normalizeTenderText(input.contractingBody);
  const date = input.submissionDeadline ? mexicoCityDate(input.submissionDeadline) : null;
  if (procedure === null || body === null || date === null) return null;
  return createHash("sha256").update(`${procedure}|${body}|${date}`, "utf8").digest("hex");
}

/** Un campo de la convocatoria en el que la fuente adicional dice algo distinto de la convocatoria (que conserva el valor primario). */
export interface SourceFieldConflict {
  readonly field: string;
  readonly current: unknown;
  readonly alternative: unknown;
}

/** Una fuente de la convocatoria: la primaria (`primary: true`) y las enlazadas por huella. */
export interface TenderSourceLink {
  readonly source: string;
  readonly externalId: string;
  readonly primary: boolean;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly conflicts: readonly SourceFieldConflict[];
}
