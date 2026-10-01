// Cliente de la sala de guerra y de las preguntas de la junta de aclaraciones (L-04).
// Llama a `.../tenders/:tenderId/sala-guerra/*` y `.../junta/*`
// (apps/api/src/routes/verticals/licitaciones/salaGuerra.ts). Nada de aqui envia
// nada a un portal: "enviada" y la respuesta del acta las registra un humano.
import { fetchJson, patchJson, postJson, putJson } from "./admin-client.ts";

export type WarRoomItemKind = "requisito" | "tarea" | "riesgo";
export type WarRoomItemStatus = "pendiente" | "en_curso" | "listo" | "bloqueado" | "descartado";
export type WarRoomSeverity = "baja" | "media" | "alta" | "critica";
export type SemaphoreColor = "rojo" | "amarillo" | "verde" | "gris";
export type SemaphoreState = "vencido" | "vence_hoy" | "vence_pronto" | "en_tiempo" | "sin_fecha" | "cerrado";

export interface DeadlineSemaphore {
  readonly color: SemaphoreColor;
  readonly state: SemaphoreState;
  readonly hoursRemaining: number | null;
}

export interface WarRoomItem {
  readonly id: string;
  readonly kind: WarRoomItemKind;
  readonly title: string;
  readonly description: string | null;
  readonly status: WarRoomItemStatus;
  readonly severity: WarRoomSeverity | null;
  readonly responsibleUserId: string | null;
  readonly dueAt: string | null;
  readonly requirementItemId: string | null;
  readonly completedAt: string | null;
  readonly semaphore: DeadlineSemaphore;
}

export interface WarRoomEntry {
  readonly id: string;
  readonly itemId: string | null;
  readonly entryKind: "decision" | "comentario" | "evento";
  readonly body: string;
  readonly authorId: string;
  readonly createdAt: string;
}

export interface GoNoGoSummary {
  readonly id: string;
  readonly decision: "go" | "no_go";
  readonly reasons: readonly string[];
  readonly decidedAt: string;
}

export interface ImportableRequirement {
  readonly id: string;
  readonly text: string;
  readonly requirementKind: string;
  readonly obligatoriedad: string;
  readonly clause: string | null;
}

export interface WarRoomBoardResponse {
  readonly available: boolean;
  readonly now: string;
  readonly viewerUserId: string;
  readonly tender: { readonly id: string; readonly title: string; readonly submissionDeadline: string | null; readonly status: string | null };
  readonly board: {
    readonly items: readonly WarRoomItem[];
    readonly summary: {
      readonly requisitos: { readonly total: number; readonly listos: number; readonly bloqueados: number };
      readonly tareas: { readonly total: number; readonly listas: number };
      readonly riesgosAbiertos: number;
      readonly riesgosAltos: number;
      readonly sinResponsable: number;
      readonly avancePct: number | null;
      readonly semaforoGeneral: SemaphoreColor;
    };
    readonly goNoGo: GoNoGoSummary | null;
    readonly submissionDeadline: { readonly at: string | null; readonly semaphore: DeadlineSemaphore };
  };
  readonly entries: readonly WarRoomEntry[];
  readonly goNoGoHistory: readonly GoNoGoSummary[];
  readonly importableRequirements: readonly ImportableRequirement[];
}

export interface NewWarRoomItem {
  readonly kind: WarRoomItemKind;
  readonly title: string;
  readonly description?: string | null;
  readonly severity?: WarRoomSeverity | null;
  readonly responsibleUserId?: string | null;
  readonly dueAt?: string | null;
}

export type JuntaQuestionStatus = "borrador" | "aprobada" | "enviada" | "respondida" | "descartada";
export type JuntaQuestionTopic = "administrativo" | "legal" | "tecnico" | "economico" | "otro";
export type JuntaQuestionPriority = "alta" | "media" | "baja";

export interface JuntaQuestion {
  readonly id: string;
  readonly questionText: string;
  readonly baseReference: string | null;
  readonly topic: JuntaQuestionTopic;
  readonly priority: JuntaQuestionPriority;
  readonly origin: "manual" | "agente";
  readonly draftMissingData: readonly string[];
  readonly status: JuntaQuestionStatus;
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly sentAt: string | null;
  readonly sentReference: string | null;
  readonly answerText: string | null;
  readonly answerActaReference: string | null;
  readonly answeredAt: string | null;
  readonly discardReason: string | null;
}

export interface JuntaConfig {
  readonly questionsDeadlineAt: string | null;
  readonly meetingAt: string | null;
  readonly actaReference: string | null;
}

export interface JuntaReminder {
  readonly id: string;
  readonly questionsDeadlineAt: string;
  readonly daysRemaining: number;
  readonly pendingCount: number;
  readonly message: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

export interface JuntaResponse {
  readonly available: boolean;
  readonly now: string;
  readonly config: JuntaConfig | null;
  readonly questions: readonly JuntaQuestion[];
  readonly summary: {
    readonly counts: Readonly<Record<JuntaQuestionStatus, number>>;
    readonly pendingToSend: number;
    readonly questionsDeadline: { readonly at: string | null; readonly semaphore: DeadlineSemaphore };
    readonly meetingAt: string | null;
  };
  readonly reminders: readonly JuntaReminder[];
  readonly portalSubmission: false;
}

export interface CaptureResult {
  readonly question: JuntaQuestion;
  readonly similar: readonly { readonly id: string; readonly questionText: string; readonly status: JuntaQuestionStatus; readonly similarity: number }[];
  readonly suggestion: { readonly priority: JuntaQuestionPriority; readonly score: number; readonly reasons: readonly string[] };
}

export interface DraftResult {
  readonly created: readonly JuntaQuestion[];
  readonly skippedDuplicates: readonly string[];
  readonly rejected: readonly { readonly questionText: string; readonly reason: string; readonly detail: string }[];
  readonly missingData: readonly string[];
}

export interface TransitionInput {
  readonly to: JuntaQuestionStatus;
  readonly sentReference?: string;
  readonly answerText?: string;
  readonly answerActaReference?: string;
  readonly discardReason?: string;
}

const tenderBase = (apiBaseUrl: string, propertyId: string, tenderId: string) => `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}`;

export function fetchWarRoom(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<WarRoomBoardResponse> {
  return fetchJson<WarRoomBoardResponse>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/sala-guerra`, token);
}

export function createWarRoomItem(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: NewWarRoomItem): Promise<WarRoomItem> {
  return postJson<WarRoomItem>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/sala-guerra/items`, token, input);
}

export function importWarRoomRequirements(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<{ created: number }> {
  return postJson<{ created: number }>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/sala-guerra/items/import-requirements`, token, {});
}

export function updateWarRoomItem(
  f: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  itemId: string,
  patch: { status?: WarRoomItemStatus; responsibleUserId?: string | null; dueAt?: string | null; severity?: WarRoomSeverity },
): Promise<WarRoomItem> {
  return patchJson<WarRoomItem>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/sala-guerra/items/${itemId}`, token, patch);
}

export function addWarRoomEntry(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: { entryKind: "decision" | "comentario"; body: string; itemId?: string | null }): Promise<WarRoomEntry> {
  return postJson<WarRoomEntry>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/sala-guerra/entries`, token, input);
}

export function fetchJunta(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<JuntaResponse> {
  return fetchJson<JuntaResponse>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/junta`, token);
}

export function saveJuntaConfig(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: JuntaConfig): Promise<JuntaConfig> {
  return putJson<JuntaConfig>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/junta/config`, token, input);
}

export function captureJuntaQuestion(
  f: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: { questionText: string; baseReference?: string | null; topic?: JuntaQuestionTopic; priority?: JuntaQuestionPriority },
): Promise<CaptureResult> {
  return postJson<CaptureResult>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/junta/questions`, token, input);
}

export function draftJuntaQuestions(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: { instruction: string }): Promise<DraftResult> {
  return postJson<DraftResult>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/junta/questions/draft`, token, input);
}

export function updateJuntaQuestion(
  f: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  questionId: string,
  patch: { questionText?: string; baseReference?: string | null; topic?: JuntaQuestionTopic; priority?: JuntaQuestionPriority },
): Promise<JuntaQuestion> {
  return patchJson<JuntaQuestion>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/junta/questions/${questionId}`, token, patch);
}

export function transitionJuntaQuestion(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, questionId: string, input: TransitionInput): Promise<JuntaQuestion> {
  return postJson<JuntaQuestion>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/junta/questions/${questionId}/transition`, token, input);
}

export function acknowledgeJuntaReminder(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, reminderId: string): Promise<JuntaReminder> {
  return postJson<JuntaReminder>(f, `${tenderBase(apiBaseUrl, propertyId, tenderId)}/junta/reminders/${reminderId}/acknowledge`, token, {});
}
