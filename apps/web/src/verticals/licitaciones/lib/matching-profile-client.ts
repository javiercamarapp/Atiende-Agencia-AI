// Lógica de datos del perfil de matching (auditoría: "Perfil de matching sin
// UI: la columna Score/elegibilidad del panel es inservible hasta hacer un
// PUT por curl") — `GET`/`PUT .../matching-profile`, Fase 3 pieza 2
// (matchingProfile.ts). Es la ÚNICA fuente de keywords/entidades/estados/
// presupuesto que alimenta MatchingEngine.score (matching-engine.ts) — sin
// perfil configurado, la elegibilidad agregada de TODAS las convocatorias es
// SIEMPRE "no_evaluable" (ver EMPTY_PROFILE en matchingProfile.ts). El PUT
// está restringido server-side a WRITE_ROLES (roles.ts) — este cliente nunca
// aplica esa regla, solo la pantalla que lo usa oculta el formulario.
import { fetchJson, putJson } from "./admin-client.ts";

export interface MatchingProfile {
  readonly organizationId: string;
  readonly keywords: readonly string[];
  readonly excludedKeywords: readonly string[];
  readonly classifierCodes: readonly string[];
  readonly entities: readonly string[];
  readonly states: readonly string[];
  readonly budgetMin: number | null;
  readonly budgetMax: number | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

export interface MatchingProfileInput {
  readonly keywords: readonly string[];
  readonly excludedKeywords: readonly string[];
  readonly classifierCodes: readonly string[];
  readonly entities: readonly string[];
  readonly states: readonly string[];
  readonly budgetMin: number | null;
  readonly budgetMax: number | null;
}

/** Nunca 404 -- el servidor responde el perfil "vacío" explícito (ver
 * EMPTY_PROFILE en matchingProfile.ts) cuando la organización todavía no
 * configuró nada, para distinguir "sin configurar" de un error real. */
export async function fetchMatchingProfile(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<MatchingProfile> {
  return fetchJson<MatchingProfile>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/matching-profile`, token);
}

export async function saveMatchingProfile(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: MatchingProfileInput): Promise<MatchingProfile> {
  return putJson<MatchingProfile>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/matching-profile`, token, input);
}
