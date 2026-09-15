// lib/inconformidad-client.ts — redactor de inconformidades post-adjudicación
// (Fase 15 pieza 2, mismo hallazgo ALTA que contract-billing-client.ts):
// `inconformidad.ts` expone POST/GET .../inconformidad y POST
// .../inconformidad/:id/mark-reviewed (INCONFORMIDAD_REVIEW_ROLES) -- ninguno
// tenía cliente ni página. Genera un BORRADOR estructurado (hechos/agravios/
// fundamentos/pruebas/plazo) -- este cliente, igual que el servidor, JAMÁS
// presenta nada ante ninguna autoridad (no hay ningún efecto de "enviar" en
// todo este archivo). El plazo (Art. 95 LAASSP, 6/10 días hábiles) SIEMPRE lo
// calcula el motor determinista del servidor -- nunca este cliente ni un LLM.
import { fetchJson, postJson } from "./admin-client.ts";

export interface InconformidadFundamento {
  readonly articulo: string;
  readonly ley: string;
  readonly jurisdiccion: string;
  readonly fechaDof: string | null;
  readonly texto: string;
}

/** Heurística determinista sobre cantidad de evidencia declarada (agravios vs. pruebas) -- NUNCA una opinión legal sobre el fondo del caso, ver disclaimer. */
export type InconformidadViability = "alta" | "media" | "baja";

/** Reagrupado bajo `plazo` tal cual lo serializa `inconformidad.ts::mapDraft` (campos planos en el repositorio). */
export interface InconformidadPlazo {
  readonly diasHabiles: number;
  readonly fechaNotificacionFallo: string;
  readonly fechaLimite: string;
  readonly fundamentoLegal: string;
  readonly bajoTratados: boolean;
}

export type InconformidadDraftStatus = "borrador" | "revisado";

export interface InconformidadDraft {
  readonly id: string;
  readonly tenderId: string;
  readonly version: number;
  readonly status: InconformidadDraftStatus;
  readonly contentHash: string;
  readonly hechos: readonly string[];
  readonly agravios: readonly string[];
  readonly pruebas: readonly string[];
  readonly fundamentos: readonly InconformidadFundamento[];
  readonly plazo: InconformidadPlazo;
  readonly viability: InconformidadViability;
  readonly viabilityRecommendation: string;
  readonly disclaimer: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CreateInconformidadDraftInput {
  readonly hechos: readonly string[];
  readonly agravios: readonly string[];
  readonly pruebas: readonly string[];
  /** "YYYY-MM-DD" -- fecha en que se notificó el fallo; el plazo se cuenta desde AQUÍ, nunca desde "hoy". */
  readonly falloNotifiedOn: string;
  readonly bajoTratados: boolean;
}

/** `GET .../inconformidad` -- lectura, ningún rol restringido. Historial COMPLETO (todas las versiones), más recientes primero tal cual las devuelve el servidor. */
export async function fetchInconformidadDrafts(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly InconformidadDraft[]> {
  const body = await fetchJson<{ drafts: readonly InconformidadDraft[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/inconformidad`, token);
  return body.drafts;
}

/** `POST .../inconformidad` -- WRITE_ROLES. Cada llamada crea una VERSIÓN nueva (`version` incremental) -- nunca edita un borrador existente. */
export async function createInconformidadDraft(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: CreateInconformidadDraftInput,
): Promise<InconformidadDraft> {
  return postJson<InconformidadDraft>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/inconformidad`, token, input);
}

/** `POST .../inconformidad/:id/mark-reviewed` -- INCONFORMIDAD_REVIEW_ROLES (owner/admin/reviewer, deliberadamente sin "analyst"/"writer": certificar la revisión legal es un rol distinto de redactar). Un segundo intento sobre un borrador ya revisado es un 409 real del servidor -- se propaga tal cual, nunca se silencia. */
export async function markInconformidadReviewed(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  draftId: string,
): Promise<InconformidadDraft> {
  return postJson<InconformidadDraft>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/inconformidad/${draftId}/mark-reviewed`, token, {});
}
