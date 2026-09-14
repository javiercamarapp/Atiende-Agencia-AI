// fallo-autopsy.ts — Fase 6 pieza 4 (REQ-054): autopsia del fallo -- informe
// estructurado comparando la propuesta propia contra el fallo (motivo de
// desechamiento, puntos/criterios, precio propio vs. ganador cuando el
// fallo es público) y lecciones registradas y vinculadas al perfil de
// empresa.
//
// REQ-054 explícito: "sin inventar datos ausentes -> 'no disponible'" --
// cualquier campo textual no capturado se persiste literalmente como
// `NO_DISPONIBLE` (nunca `null`/""" ambiguo, nunca inferido). Port ~literal
// del criterio del repo original
// (`licitaciones/apps/api/src/modules/expediente/fallo-autopsy.routes.ts`).
//
// HUECO HONESTO documentado (ver instrucción de esta fase y README del
// vertical): el repo original añadió en una ronda posterior (`ronda 7`) un
// análisis automatizado de "posibles causas de no adjudicación"
// (`lib/expediente/fallo-analysis.ts`, comparando la autopsia contra la
// matriz de requisitos) y un enlace directo autopsia->inconformidad
// (`sourceAutopsyId`, restatement automático de hechos). Esta fase NO porta
// esas dos piezas -- son valor agregado sobre el REQ-054 base (registrar la
// autopsia + lecciones aprendidas, consultables), no el requisito mismo, y
// exigirían tocar `requirement-matrix.ts`/`inconformidad.ts` con más
// alcance del despachado. Quedan como trabajo futuro explícito, no
// inventado ni fingido aquí.
export const NO_DISPONIBLE = "no disponible";

export const OWN_PROPOSAL_STATUSES = ["ganadora", "desechada", "no_presentada", "desconocido"] as const;
export type OwnProposalStatus = (typeof OWN_PROPOSAL_STATUSES)[number];

export function isOwnProposalStatus(value: unknown): value is OwnProposalStatus {
  return typeof value === "string" && (OWN_PROPOSAL_STATUSES as readonly string[]).includes(value);
}

export interface CriteriaComparisonItem {
  readonly criterio: string;
  readonly propio: string;
  readonly ganador: string;
}

/** `null`/cadena vacía -> `NO_DISPONIBLE` -- nunca se persiste un campo textual ambiguo (REQ-054). */
export function normalizeOrNoDisponible(value: string | null | undefined): string {
  if (value === null || value === undefined) return NO_DISPONIBLE;
  const trimmed = value.trim();
  return trimmed.length === 0 ? NO_DISPONIBLE : trimmed;
}

/** Valida la forma mínima de cada renglón de comparación de criterios (texto no vacío en las 3 columnas) -- nunca lanza, filtra los inválidos (mismo criterio "descarta en vez de persistir a medias" que `contract-extraction.ts`). */
export function sanitizeCriteriaComparison(items: readonly unknown[]): CriteriaComparisonItem[] {
  const result: CriteriaComparisonItem[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.criterio !== "string" || o.criterio.trim().length === 0) continue;
    if (typeof o.propio !== "string" || typeof o.ganador !== "string") continue;
    result.push({ criterio: o.criterio.trim(), propio: o.propio, ganador: o.ganador });
  }
  return result;
}
