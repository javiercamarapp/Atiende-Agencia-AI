// Cliente de la revisión del expediente (paridad3 L-P3-07): secciones con editor humano, hilo de comentarios (solo de
// adición) y solicitud de revisión. Rutas bajo .../tenders/:tenderId/proposal.
import { fetchJson, patchJson, postJson } from "./admin-client.ts";

export interface ProposalSection {
  readonly sectionKey: string;
  readonly label: string;
  readonly content: string;
  readonly version: number;
  /** Cuántas personas distintas han redactado/editado la sección (nunca quiénes). */
  readonly authorCount: number;
  /** `true` si quien consulta es autor: no puede aprobar la sección ni el expediente (AE-11). */
  readonly authoredByViewer: boolean;
  /** La sección tiene una aprobación vigente propia: editar su texto la invalida. */
  readonly approved: boolean;
  readonly expedienteApproved: boolean;
}

export interface SectionEditResult {
  readonly section: Omit<ProposalSection, "approved" | "expedienteApproved">;
  readonly changed: boolean;
  readonly invalidatedApprovals: number;
}

export type CommentScope = "seccion" | "expediente";

export interface ReviewComment {
  readonly id: string;
  readonly scope: CommentScope;
  /** "expediente" o "seccion:<clave>". */
  readonly scopeRef: string;
  readonly kind: "comentario" | "solicitud_revision";
  readonly body: string;
  readonly authorRole: string;
  readonly authorName: string | null;
  readonly esTuyo: boolean;
  readonly createdAt: string;
}

export interface CommentsResult {
  /** `false` = la base todavía no tiene la migración 037. */
  readonly disponible: boolean;
  readonly comments: readonly ReviewComment[];
}

const base = (apiBaseUrl: string, propertyId: string, tenderId: string) => `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/proposal`;

export async function fetchProposalSections(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly ProposalSection[]> {
  const body = await fetchJson<{ sections: readonly ProposalSection[] }>(fetchImpl, `${base(apiBaseUrl, propertyId, tenderId)}/sections`, token);
  return body.sections;
}

/** `PATCH .../sections/:sectionKey` -- WRITE_ROLES; si el texto cambió invalida las aprobaciones vigentes de la sección y del expediente. */
export async function editProposalSection(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, sectionKey: string, content: string): Promise<SectionEditResult> {
  return patchJson<SectionEditResult>(fetchImpl, `${base(apiBaseUrl, propertyId, tenderId)}/sections/${encodeURIComponent(sectionKey)}`, token, { content });
}

export async function fetchReviewComments(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<CommentsResult> {
  return fetchJson<CommentsResult>(fetchImpl, `${base(apiBaseUrl, propertyId, tenderId)}/comments`, token);
}

export async function addReviewComment(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: { sectionKey: string | null; body: string }): Promise<ReviewComment> {
  const payload = input.sectionKey ? { scope: "seccion", sectionKey: input.sectionKey, body: input.body } : { scope: "expediente", body: input.body };
  const result = await postJson<{ comment: ReviewComment }>(fetchImpl, `${base(apiBaseUrl, propertyId, tenderId)}/comments`, token, payload);
  return result.comment;
}

export async function requestReview(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: { sectionKey: string | null; note: string }): Promise<ReviewComment> {
  const payload = input.sectionKey ? { scope: "seccion", sectionKey: input.sectionKey, note: input.note } : { scope: "expediente", note: input.note };
  const result = await postJson<{ comment: ReviewComment }>(fetchImpl, `${base(apiBaseUrl, propertyId, tenderId)}/request-review`, token, payload);
  return result.comment;
}
