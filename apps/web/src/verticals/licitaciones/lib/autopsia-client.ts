// Cliente web de la autopsia del fallo (Fase 16 pieza propia) — cierra la
// penúltima porción del hallazgo ALTA de auditoría "Post-adjudicación
// completa (contratos, documentos, cobranza, inconformidades, autopsia,
// renovaciones) = 22 rutas sin UI": falloAutopsy.ts expone POST/GET de la
// autopsia del fallo por convocatoria + GET de lecciones aprendidas
// (org-wide, todas las convocatorias) -- ninguno tenía cliente ni página
// todavía.
//
// SOLO autopsia del fallo aquí: generar/ver la autopsia de una convocatoria
// perdida (por qué se perdió, causas raíz) y ver las lecciones aprendidas
// agregadas. Deliberadamente FUERA de esta pieza (alcance de otro agente en
// paralelo, ver README de este vertical): el radar de renovaciones -- no se
// toca ni se referencia desde aquí.
//
// Mismo aislamiento que el resto de apps/web (ver cabecera de
// requirements-client.ts): no depende de `@atiende/domain-licitaciones`, todo
// lo que este cliente necesita del contrato de datos vive duplicado aquí
// (uniones de string LITERALES, mismo criterio que `go-no-go-client.ts`/
// `contract-client.ts`).
import { fetchJson, postJson } from "./admin-client.ts";

/** Espejo EXACTO de `OWN_PROPOSAL_STATUSES` (domain-licitaciones/fallo-autopsy.ts) -- catálogo cerrado en código, el servidor rechaza cualquier otro valor con 400. */
export const OWN_PROPOSAL_STATUSES = ["ganadora", "desechada", "no_presentada", "desconocido"] as const;
export type OwnProposalStatus = (typeof OWN_PROPOSAL_STATUSES)[number];

/** Espejo de `CriteriaComparisonItem`. */
export interface CriteriaComparisonItem {
  readonly criterio: string;
  readonly propio: string;
  readonly ganador: string;
}

/**
 * Espejo de `FalloAutopsyRecord` (domain-licitaciones/repository.ts).
 * REQ-054 explícito: `disqualificationReason`/`winnerName` nunca llegan
 * ambiguos -- el servidor los normaliza a la cadena literal
 * `"no disponible"` cuando no se capturó nada (ver
 * `fallo-autopsy.ts::normalizeOrNoDisponible`), nunca `null`/"" aquí.
 */
export interface FalloAutopsyRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly ownProposalStatus: OwnProposalStatus;
  readonly disqualificationReason: string;
  readonly ownScore: number | null;
  readonly winnerScore: number | null;
  readonly ownPrice: number | null;
  readonly winnerPrice: number | null;
  readonly winnerName: string;
  readonly criteriaComparison: readonly CriteriaComparisonItem[];
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Espejo de `CompanyLessonLearnedRecord` -- vinculada al perfil de empresa, consultable org-wide (todas las convocatorias), no solo por esta. */
export interface CompanyLessonLearnedRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly falloAutopsyId: string;
  readonly tenderId: string;
  readonly lessonText: string;
  readonly createdAt: string;
}

export interface CreateFalloAutopsyInput {
  readonly ownProposalStatus: OwnProposalStatus;
  readonly disqualificationReason?: string | null;
  readonly ownScore?: number | null;
  readonly winnerScore?: number | null;
  readonly ownPrice?: number | null;
  readonly winnerPrice?: number | null;
  readonly winnerName?: string | null;
  readonly criteriaComparison?: readonly CriteriaComparisonItem[];
  readonly lessons?: readonly string[];
}

export interface CreateFalloAutopsyResult extends FalloAutopsyRecord {
  readonly lessons: readonly CompanyLessonLearnedRecord[];
}

/**
 * `POST .../fallo-autopsy` -- WRITE_ROLES en el servidor. Registra UNA
 * autopsia más para esta convocatoria (el servidor nunca limita a una sola
 * por convocatoria -- ver `listFalloAutopsies`, siempre puede haber varias
 * revisiones). Los campos numéricos ausentes van como `undefined` -> nunca
 * se manda `0` como si fuera un valor real capturado (mismo criterio que
 * `contract-client.ts`).
 */
export async function createFalloAutopsy(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: CreateFalloAutopsyInput,
): Promise<CreateFalloAutopsyResult> {
  return postJson<CreateFalloAutopsyResult>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/fallo-autopsy`, token, {
    ownProposalStatus: input.ownProposalStatus,
    disqualificationReason: input.disqualificationReason ?? null,
    ownScore: input.ownScore ?? null,
    winnerScore: input.winnerScore ?? null,
    ownPrice: input.ownPrice ?? null,
    winnerPrice: input.winnerPrice ?? null,
    winnerName: input.winnerName ?? null,
    criteriaComparison: input.criteriaComparison ?? [],
    lessons: input.lessons ?? [],
  });
}

/** `GET .../fallo-autopsy` -- sin rol restringido (lectura). Todas las autopsias registradas para esta convocatoria, más recientes primero según el orden del servidor. */
export async function fetchFalloAutopsies(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly FalloAutopsyRecord[]> {
  const body = await fetchJson<{ autopsies: readonly FalloAutopsyRecord[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/fallo-autopsy`, token);
  return body.autopsies;
}

/**
 * `GET .../lessons-learned` -- sin rol restringido (lectura). REQ-054: NO es
 * por convocatoria -- son las lecciones de TODA la organización, vinculadas
 * al perfil de empresa (útil para no repetir el mismo error en la próxima
 * convocatoria, no solo en esta).
 */
export async function fetchLessonsLearned(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CompanyLessonLearnedRecord[]> {
  const body = await fetchJson<{ lessons: readonly CompanyLessonLearnedRecord[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/lessons-learned`, token);
  return body.lessons;
}
