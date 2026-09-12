// Tipos y utilidades base de domain-licitaciones — port ~literal de
// licitaciones/packages/expediente/src/types.ts (ver diseño Fase 1 §3.1). Sin
// dependencias externas: usado por los 3 flujos (checklist/económico/cierre).
import { createHash } from "node:crypto";

/** Zona horaria oficial del expediente (México central). */
export const MEXICO_CITY_TZ = "America/Mexico_City";

export function isoNow(): string {
  return new Date().toISOString();
}

const ISO_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_OFFSET_HHMM_PATTERN = /([+-])(\d{2}):(\d{2})$/;
const ISO_DATE_PREFIX_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Rechaza offsets horarios numéricamente imposibles (EX-EXP-04/EX-EXP-13 del
 * origen): un offset como "+99:00" produciría `Invalid Date` (`NaN`), y
 * `isPast()` evaluaría `NaN < NaN` como `false` ("nunca vencido") — un
 * fail-open silencioso sobre la garantía de vigencias. Los offsets reales van
 * de "-12:00" a "+14:00"; se rechazan además minutos fuera de 00-59.
 */
function assertOffsetInRange(iso: string, label: string): void {
  const match = iso.match(ISO_OFFSET_HHMM_PATTERN);
  if (!match) return; // termina en "Z": no hay offset numérico que validar.
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (minutes > 59) {
    throw new Error(`${label} con minutos de offset horario fuera de rango (00-59): "${iso}".`);
  }
  const totalMinutes = sign * (hours * 60 + minutes);
  if (totalMinutes < -12 * 60 || totalMinutes > 14 * 60) {
    throw new Error(`${label} con offset horario fuera del rango válido (-12:00 a +14:00): "${iso}".`);
  }
}

/**
 * Rechaza fechas calendáricamente imposibles (p. ej. 29 de febrero en un año
 * no bisiesto, que `Date` reinterpreta silenciosamente como el 1 de marzo).
 */
function assertValidCalendarComponents(iso: string, label: string): void {
  const match = iso.match(ISO_DATE_PREFIX_PATTERN);
  if (!match) return;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    throw new Error(`${label} con mes calendárico inválido (01-12): "${iso}".`);
  }
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
  if (day < 1 || day > maxDay) {
    throw new Error(`${label} con día calendárico inválido para ese mes/año: "${iso}".`);
  }
}

const ISO_TIME_SEGMENT_PATTERN = /T([0-9:.,]+)(?:Z|[+-]\d{2}:\d{2})$/;

/** Rechaza "24:00:00" (medianoche del día siguiente, ISO 8601 válido pero que `Date` reinterpreta en silencio) y minutos/segundos ≥60. */
function assertValidTimeComponents(iso: string, label: string): void {
  const match = iso.match(ISO_TIME_SEGMENT_PATTERN);
  if (!match) return;
  const parts = match[1]!.split(":");
  if (parts.length !== 3 || !/^\d{2}$/.test(parts[0]!) || !/^\d{2}$/.test(parts[1]!)) {
    throw new Error(`${label} con formato de hora inválido (se esperaba "HH:MM:SS"): "${iso}".`);
  }
  const secondParts = parts[2]!.split(/[.,]/);
  if (secondParts.length > 2 || !/^\d{2}$/.test(secondParts[0]!) || (secondParts.length === 2 && !/^\d+$/.test(secondParts[1]!))) {
    throw new Error(`${label} con segundos/fracción de hora en formato inválido: "${iso}".`);
  }
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  const second = Number(secondParts[0]);
  if (hour > 23) {
    throw new Error(`${label} con hora fuera de rango (00-23): "${iso}" — "24:00:00" no se acepta.`);
  }
  if (minute > 59) throw new Error(`${label} con minutos fuera de rango (00-59): "${iso}".`);
  if (second > 59) throw new Error(`${label} con segundos fuera de rango (00-59): "${iso}".`);
}

/**
 * Exige offset horario EXPLÍCITO ("Z" o "±HH:MM") — nunca una fecha "naive".
 * Fail-closed: cualquier fecha inválida lanza, nunca se deja pasar como si
 * fuera una fecha válida "no vencida" (REQ-LIC-001 / AE-01 del origen).
 */
export function assertExplicitOffset(iso: string, label = "fecha"): void {
  if (typeof iso !== "string" || iso.trim().length === 0) {
    throw new Error(`${label} inválida: se esperaba una cadena ISO 8601 no vacía con offset horario explícito, se recibió ${JSON.stringify(iso)}.`);
  }
  const trimmed = iso.trim();
  if (!ISO_OFFSET_PATTERN.test(trimmed)) {
    throw new Error(`${label} sin offset horario explícito (se requiere "Z" o "±HH:MM", p. ej. "-06:00" para America/Mexico_City): "${trimmed}".`);
  }
  assertOffsetInRange(trimmed, label);
  assertValidCalendarComponents(trimmed, label);
  assertValidTimeComponents(trimmed, label);
  if (Number.isNaN(new Date(trimmed).getTime())) {
    throw new Error(`${label} no representa una fecha válida (fail-closed): "${trimmed}".`);
  }
}

/** `true` si `iso` (fecha límite) ya pasó respecto de `asOfIso`. Ambas deben traer offset explícito. */
export function isPast(iso: string, asOfIso: string = isoNow()): boolean {
  assertExplicitOffset(iso, "fecha límite (isPast)");
  assertExplicitOffset(asOfIso, "fecha de referencia asOfIso (isPast)");
  return new Date(iso).getTime() < new Date(asOfIso).getTime();
}

/** Referencia trazable a un dato/documento aprobado o a una cláusula de las bases — toda afirmación de una propuesta debe traer una de estas. */
export type SourceRef =
  | { kind: "company_data"; refId: string; capturedAt: string }
  | { kind: "clause"; documentId: string; page: number; clause?: string };

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

/** sha256 hex de los BYTES REALES de `content` (nunca de su representación JSON) — coincide con `sha256sum` sobre el archivo. */
export function sha256Bytes(content: Uint8Array | string): string {
  const hash = createHash("sha256");
  if (typeof content === "string") {
    hash.update(content, "utf8");
  } else {
    hash.update(content);
  }
  return hash.digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

const UNDEFINED_SENTINEL = " __stableStringify_undefined__ ";
const TYPE_MARKER_KEY = " __stableStringify_type__ ";

function compareCanonical(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

function sortKeysDeep(value: unknown): unknown {
  if (value === undefined) return UNDEFINED_SENTINEL;
  if (typeof value === "number") {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new Error(`stableStringify: no se puede serializar un número no finito (${String(value)}).`);
    }
    if (Object.is(value, -0)) {
      return { [TYPE_MARKER_KEY]: "NegativeZero" };
    }
    return value;
  }
  if (typeof value === "bigint") {
    return { [TYPE_MARKER_KEY]: "BigInt", value: value.toString() };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("stableStringify: no se puede serializar un Date inválido (Invalid Date).");
    }
    return { [TYPE_MARKER_KEY]: "Date", value: value.toISOString() };
  }
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([k, v]) => [sortKeysDeep(k), sortKeysDeep(v)] as [unknown, unknown])
      .sort((a, b) => compareCanonical(a[0], b[0]));
    return { [TYPE_MARKER_KEY]: "Map", entries };
  }
  if (value instanceof Set) {
    const items = [...value].map(sortKeysDeep).sort(compareCanonical);
    return { [TYPE_MARKER_KEY]: "Set", items };
  }
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortKeysDeep(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tipos de registro (nuevos para este paquete): forma de dato que expone
// LicitacionesRepository a las rutas de apps/api, independiente de si el
// adaptador es InMemory o Postgres.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fase 3 (matching/scoring, go/no-go, migración 007): enum de estado del
// ciclo de vida de la convocatoria -- port literal del `TENDER_STATUSES` que
// el repo origen definía en apps/api/src/modules/tenders/schemas.ts. Se
// reutiliza tal cual (incluye estados de fases futuras como "won"/"lost")
// porque ya está pensado para sostener post-adjudicación sin reinventarlo.
// ---------------------------------------------------------------------------
export const TENDER_STATUSES = ["discovered", "in_review", "go", "no_go", "in_progress", "submitted", "won", "lost", "cancelled"] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

export function isTenderStatus(value: string): value is TenderStatus {
  return (TENDER_STATUSES as readonly string[]).includes(value);
}

export interface TenderRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  /** ISO 8601 con offset explícito, o `null` si las bases aún no fijan fecha límite (REQ-LIC-001). */
  readonly submissionDeadline: string | null;
  readonly updatedAt: string;
  // --- Fase 3 (§3 del diseño): campos aditivos que el matching necesita.
  // Opcionales a nivel de TIPO (aunque Postgres los puebla con NOT NULL
  // DEFAULT y el adaptador real siempre los devuelve) para no romper los
  // sitios de Fase 1/2 que ya construyen un `TenderRecord` literal con solo
  // los 5 campos originales (fixtures/specs de dates.ts e
  // in-memory-repository.ts) -- "aditivo" significa que ni leerlos ni
  // omitirlos rompe nada, en ninguna dirección.
  /** Siempre "manual" mientras B-02 (ver docs/BLOQUEOS.md) siga abierto -- ningún conector real está verificado todavía. */
  readonly source?: string;
  /** Clave natural de deduplicación dentro de `source`, o `null`/`undefined` si el alta manual no la declaró (en cuyo caso cada alta crea una convocatoria nueva). */
  readonly externalId?: string | null;
  readonly contractingBody?: string | null;
  readonly cpvCodes?: readonly string[];
  readonly budgetAmount?: number | null;
  readonly currency?: string;
  /** Entidad federativa, para cobertura geográfica del matching. */
  readonly state?: string | null;
  readonly procedureTypeRaw?: string | null;
  readonly status?: TenderStatus;
}

// ---------------------------------------------------------------------------
// Fase 3 §5: perfil de matching de la organización (singleton, tabla
// `licitaciones.matching_profile`). Todos los criterios son opcionales por
// diseño del motor (matching-engine.ts): un criterio sin configurar no
// participa ni penaliza.
// ---------------------------------------------------------------------------
export interface MatchingProfileRecord {
  readonly organizationId: string;
  readonly keywords: readonly string[];
  readonly excludedKeywords: readonly string[];
  readonly classifierCodes: readonly string[];
  readonly entities: readonly string[];
  readonly states: readonly string[];
  readonly budgetMin: number | null;
  readonly budgetMax: number | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Fase 3 §7: decisión Go/No-Go. `matchScore`/`matchEligibilityStatus`/
// `matchInputsHash` son un snapshot INMUTABLE del `MatchResult` vigente en el
// momento exacto de decidir (ver matching-engine.ts::computeMatchInputsHash)
// -- nunca se recalculan retroactivamente.
// ---------------------------------------------------------------------------
export interface GoNoGoDecisionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly decision: "go" | "no_go";
  readonly reasons: readonly string[];
  readonly matchScore: number;
  readonly matchEligibilityStatus: "cumple" | "no_cumple" | "no_evaluable";
  readonly matchInputsHash: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface ProposalRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly title: string;
  readonly ivaRate: number;
  readonly economicTotals: unknown | null;
  readonly generationReport: {
    technical?: { usedCompanyDocumentIds?: string[]; notApplicableRequirements?: { requirementId: string; reason: string }[] };
    economic?: { usedRateConcepts?: string[]; blockedLineItems?: unknown[]; totals?: unknown };
  } | null;
  readonly correlationId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ComplianceItemRecord {
  readonly id: string;
  readonly dimension: string;
  readonly result: "verde" | "ambar" | "rojo";
  readonly notes: string;
  readonly evidenceRef: string | null;
  readonly checkedAt: string;
}

export interface RequiredAnnexItem {
  readonly id: string;
  readonly text: string;
  readonly topicKey?: string;
}

export interface CompanyDocumentRecord {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly expiresAt: string | null;
  readonly approvalStatus: "aprobado" | "pendiente_aprobacion" | "rechazado";
}

export interface ApprovedRateRecord {
  readonly id: string;
  readonly concept: string;
  readonly unitPrice: string;
  readonly currency: "MXN";
  readonly approvalStatus: "aprobado" | "pendiente_aprobacion" | "rechazado";
  readonly validFrom: string;
  readonly validUntil: string | null;
}

// ---- Fase 4: CompanyDataResolver real (capacidades/experiencia/firmantes) ----
// Puerto de licitaciones.company_capability/company_experience/company_signer
// (migración 009) -- mismo patrón que CompanyDocumentRecord/ApprovedRateRecord
// arriba. Nombrado "...ItemRecord"/"...RegistryRecord" para no chocar con las
// interfaces homónimas de dominio en company-data.ts (CompanyCapability,
// CompanyExperienceRecord, CompanySigner), que son la forma que consume
// TechnicalProposalBuilder, no la forma de fila de la tabla.
export interface CompanyCapabilityRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly evidenceDocId: string | null;
  readonly approvalStatus: "aprobado" | "pendiente_aprobacion" | "rechazado";
}

export interface CompanyExperienceItemRecord {
  readonly id: string;
  readonly description: string;
  readonly evidenceDocId: string;
  readonly approvalStatus: "aprobado" | "pendiente_aprobacion" | "rechazado";
}

export interface CompanySignerRecord {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly authorized: boolean;
}

export interface PackageManifestRecord {
  readonly id: string;
  readonly status: "draft" | "ready";
  readonly manifest: unknown;
  readonly checklistSnapshot: unknown;
  readonly storageRef: string;
  readonly inputsHash: string;
  readonly generatedAt: string;
}

export interface SubmissionRecord {
  readonly id: string;
  readonly status: "submitted";
  readonly submittedAt: string;
  readonly acknowledgementStorageRef: string | null;
  readonly acknowledgementFileHash: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
}
