// L-04 -- preguntas de la junta de aclaraciones. Dominio puro (sin I/O):
// captura, huella para deduplicar, similitud, prioridad sugerida, maquina de
// estados con roles y semaforo de la fecha limite de envio.
//
// NO envia nada a ningun portal (ComprasMX u otro): `enviada` es un estado que un
// humano registra a mano despues de presentar la pregunta por el canal oficial de
// la convocante. La respuesta del acta tambien la captura un humano.
import { createHash } from "node:crypto";
import { DECISION_ROLES, WRITE_ROLES } from "./roles.ts";
import type { LicitacionesRole } from "./roles.ts";
import { SalaGuerraValidationError, deadlineSemaphore } from "./sala-guerra.ts";
import type { DeadlineSemaphore } from "./sala-guerra.ts";

export const JUNTA_QUESTION_STATUSES = ["borrador", "aprobada", "enviada", "respondida", "descartada"] as const;
export type JuntaQuestionStatus = (typeof JUNTA_QUESTION_STATUSES)[number];

export const JUNTA_QUESTION_TOPICS = ["administrativo", "legal", "tecnico", "economico", "otro"] as const;
export type JuntaQuestionTopic = (typeof JUNTA_QUESTION_TOPICS)[number];

export const JUNTA_QUESTION_PRIORITIES = ["alta", "media", "baja"] as const;
export type JuntaQuestionPriority = (typeof JUNTA_QUESTION_PRIORITIES)[number];

export interface JuntaQuestionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly questionText: string;
  readonly baseReference: string | null;
  readonly topic: JuntaQuestionTopic;
  readonly priority: JuntaQuestionPriority;
  readonly dedupeKey: string;
  readonly origin: "manual" | "agente";
  readonly draftMissingData: readonly string[];
  readonly status: JuntaQuestionStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly sentAt: string | null;
  readonly sentBy: string | null;
  readonly sentReference: string | null;
  readonly answerText: string | null;
  readonly answerActaReference: string | null;
  readonly answeredAt: string | null;
  readonly answeredBy: string | null;
  readonly discardReason: string | null;
}

export interface JuntaConfigRecord {
  readonly tenderId: string;
  readonly organizationId: string;
  readonly questionsDeadlineAt: string | null;
  readonly meetingAt: string | null;
  readonly actaReference: string | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
}

export interface JuntaQuestionReminderRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly questionsDeadlineAt: string;
  readonly daysRemaining: number;
  readonly pendingCount: number;
  readonly message: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
}

export interface JuntaQuestionCreateInput {
  readonly questionText: string;
  readonly baseReference: string | null;
  readonly topic: JuntaQuestionTopic;
  readonly priority: JuntaQuestionPriority;
  readonly dedupeKey: string;
  readonly origin: "manual" | "agente";
  readonly draftMissingData: readonly string[];
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** Una pregunta equivalente ya vive en la convocatoria (misma huella normalizada): la ruta responde 409 con la existente. */
export class JuntaQuestionDuplicateError extends Error {
  constructor(readonly existing: JuntaQuestionRecord | null) {
    super("Ya existe una pregunta equivalente para esta convocatoria.");
    this.name = "JuntaQuestionDuplicateError";
  }
}

export type JuntaQuestionRejectionCode = "transicion_no_permitida" | "rol_no_autorizado" | "texto_congelado" | "datos_requeridos";

export class JuntaQuestionRejectedError extends Error {
  constructor(
    readonly reasonCode: JuntaQuestionRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "JuntaQuestionRejectedError";
  }
}

// ---------------------------------------------------------------------------
// Normalizacion y deduplicacion
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "al", "ante", "con", "como", "cual", "cuales", "cuando", "de", "del", "el", "en", "es", "esta", "estan", "este", "esto", "la", "las", "lo", "los", "me", "mi", "no", "o",
  "para", "pero", "por", "que", "se", "si", "sin", "su", "sus", "un", "una", "uno", "y", "ya", "favor", "aclarar", "indicar", "senalar", "confirmar", "podria", "pueden", "puede",
  "solicitamos", "solicito", "amablemente", "respetuosamente", "convocante", "bases", "licitacion",
]);

/** minusculas, sin acentos ni puntuacion, sin palabras vacias: base de la huella y de la similitud. */
export function questionTokens(text: string): string[] {
  const plain = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  const tokens = plain.split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort();
}

/** Huella estable (<= 200 caracteres) de una pregunta: dos redacciones con las mismas palabras clave dan la misma huella. */
export function questionDedupeKey(text: string): string {
  const key = questionTokens(text).join(" ");
  if (key.length === 0) return `vacia-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  if (key.length <= 200) return key;
  return `${key.slice(0, 150)}#${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** Similitud de Jaccard (0-1) entre los conjuntos de palabras clave de dos preguntas. */
export function questionSimilarity(a: string, b: string): number {
  const ta = new Set(questionTokens(a));
  const tb = new Set(questionTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

export const SIMILARITY_THRESHOLD = 0.6;

export interface SimilarQuestion {
  readonly question: JuntaQuestionRecord;
  readonly similarity: number;
}

/** Preguntas vivas (no descartadas) parecidas al texto, de mayor a menor similitud. No bloquea: es aviso para el humano. */
export function findSimilarQuestions(text: string, existing: readonly JuntaQuestionRecord[], threshold = SIMILARITY_THRESHOLD): SimilarQuestion[] {
  return existing
    .filter((q) => q.status !== "descartada")
    .map((question) => ({ question, similarity: Math.round(questionSimilarity(text, question.questionText) * 100) / 100 }))
    .filter((s) => s.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);
}

// ---------------------------------------------------------------------------
// Prioridad sugerida (heuristica determinista, explicable)
// ---------------------------------------------------------------------------

interface PriorityRule {
  readonly label: string;
  readonly points: number;
  readonly regex: RegExp;
}

const PRIORITY_RULES: readonly PriorityRule[] = [
  { label: "senala ambiguedad o contradiccion en las bases", points: 3, regex: /\b(contradic\w*|ambig\w*|no\s+es\s+clar\w*|inconsisten\w*|discrepan\w*|difiere\w*)\b/i },
  { label: "afecta la evaluacion o el puntaje", points: 3, regex: /\b(puntos?|puntaje|porcentaje|criterios?\s+de\s+evaluaci\w+|rubros?|desech\w+|descalific\w+)\b/i },
  { label: "afecta garantias, fianzas o penalizaciones", points: 3, regex: /\b(fianza|garant[ií]a|pena\w*\s+convencional\w*|penalizaci\w+|sanci\w+)\b/i },
  { label: "afecta requisitos de acreditacion o experiencia", points: 2, regex: /\b(acredit\w+|experiencia|curr[ií]cul\w+|certificaci\w+|capacidad\s+t[eé]cnica|constancia)\b/i },
  { label: "afecta plazos de entrega o ejecucion", points: 2, regex: /\b(plazo|entrega|calendario|vigencia|d[ií]as\s+(naturales|h[aá]biles))\b/i },
  { label: "afecta forma de pago o anticipo", points: 2, regex: /\b(anticipo|forma\s+de\s+pago|facturaci\w+|pago)\b/i },
  { label: "se refiere a anexos, formatos o documentos obligatorios", points: 1, regex: /\b(anexo|formato|documento|manifiesto|declaraci\w+)\b/i },
  { label: "es una solicitud de visita o muestras", points: 1, regex: /\b(visita|muestras?)\b/i },
];

export interface PrioritySuggestion {
  readonly priority: JuntaQuestionPriority;
  readonly score: number;
  readonly reasons: readonly string[];
}

/** Sugerencia de prioridad: alta (>=4 puntos), media (>=2), baja (resto). El humano siempre puede cambiarla. */
export function suggestQuestionPriority(text: string, topic: JuntaQuestionTopic = "otro"): PrioritySuggestion {
  let score = topic === "legal" || topic === "economico" ? 1 : 0;
  const reasons: string[] = [];
  for (const rule of PRIORITY_RULES) {
    if (rule.regex.test(text)) {
      score += rule.points;
      reasons.push(rule.label);
    }
  }
  const priority: JuntaQuestionPriority = score >= 4 ? "alta" : score >= 2 ? "media" : "baja";
  return { priority, score, reasons };
}

const PRIORITY_RANK: Record<JuntaQuestionPriority, number> = { alta: 0, media: 1, baja: 2 };
const STATUS_RANK: Record<JuntaQuestionStatus, number> = { borrador: 0, aprobada: 1, enviada: 2, respondida: 3, descartada: 4 };

/** Orden del tablero: preguntas por trabajar primero (borrador/aprobada), por prioridad y antiguedad; las cerradas al final. */
export function sortJuntaQuestions(questions: readonly JuntaQuestionRecord[]): JuntaQuestionRecord[] {
  return [...questions].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt),
  );
}

// ---------------------------------------------------------------------------
// Validacion de entradas
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function trimmedOrNull(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new SalaGuerraValidationError(`${field}: se esperaba texto.`);
  const t = value.trim();
  if (t.length > max) throw new SalaGuerraValidationError(`${field}: maximo ${max} caracteres.`);
  return t.length === 0 ? null : t;
}

export interface ParsedQuestionCapture {
  readonly questionText: string;
  readonly baseReference: string | null;
  readonly topic: JuntaQuestionTopic;
  /** `null` = el cliente no fijo prioridad: se usa la sugerida. */
  readonly priority: JuntaQuestionPriority | null;
}

export function parseQuestionCapture(raw: Record<string, unknown>): ParsedQuestionCapture {
  if (typeof raw.questionText !== "string") throw new SalaGuerraValidationError("questionText: se esperaba texto.");
  const questionText = raw.questionText.trim();
  if (questionText.length < 10 || questionText.length > 2000) throw new SalaGuerraValidationError("questionText: debe tener entre 10 y 2000 caracteres.");
  const topic = raw.topic === undefined || raw.topic === null ? "otro" : raw.topic;
  if (!isOneOf(JUNTA_QUESTION_TOPICS, topic)) throw new SalaGuerraValidationError('topic: se esperaba "administrativo" | "legal" | "tecnico" | "economico" | "otro".');
  let priority: JuntaQuestionPriority | null = null;
  if (raw.priority !== undefined && raw.priority !== null) {
    if (!isOneOf(JUNTA_QUESTION_PRIORITIES, raw.priority)) throw new SalaGuerraValidationError('priority: se esperaba "alta" | "media" | "baja".');
    priority = raw.priority;
  }
  return { questionText, baseReference: trimmedOrNull(raw.baseReference, "baseReference", 200), topic, priority };
}

export interface JuntaQuestionPatch {
  readonly questionText?: string;
  readonly baseReference?: string | null;
  readonly topic?: JuntaQuestionTopic;
  readonly priority?: JuntaQuestionPriority;
}

export function parseQuestionPatch(raw: Record<string, unknown>): JuntaQuestionPatch {
  const patch: { -readonly [K in keyof JuntaQuestionPatch]: JuntaQuestionPatch[K] } = {};
  if (raw.questionText !== undefined) {
    if (typeof raw.questionText !== "string") throw new SalaGuerraValidationError("questionText: se esperaba texto.");
    const t = raw.questionText.trim();
    if (t.length < 10 || t.length > 2000) throw new SalaGuerraValidationError("questionText: debe tener entre 10 y 2000 caracteres.");
    patch.questionText = t;
  }
  if (raw.baseReference !== undefined) patch.baseReference = trimmedOrNull(raw.baseReference, "baseReference", 200);
  if (raw.topic !== undefined) {
    if (!isOneOf(JUNTA_QUESTION_TOPICS, raw.topic)) throw new SalaGuerraValidationError('topic: se esperaba "administrativo" | "legal" | "tecnico" | "economico" | "otro".');
    patch.topic = raw.topic;
  }
  if (raw.priority !== undefined) {
    if (!isOneOf(JUNTA_QUESTION_PRIORITIES, raw.priority)) throw new SalaGuerraValidationError('priority: se esperaba "alta" | "media" | "baja".');
    patch.priority = raw.priority;
  }
  if (Object.keys(patch).length === 0) throw new SalaGuerraValidationError("No hay ningun campo para actualizar.");
  return patch;
}

export interface JuntaConfigInput {
  readonly questionsDeadlineAt: string | null;
  readonly meetingAt: string | null;
  readonly actaReference: string | null;
}

export function parseJuntaConfig(raw: Record<string, unknown>): JuntaConfigInput {
  const iso = (v: unknown, f: string): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new SalaGuerraValidationError(`${f}: se esperaba una fecha ISO 8601 valida o null.`);
    return new Date(v).toISOString();
  };
  const questionsDeadlineAt = iso(raw.questionsDeadlineAt, "questionsDeadlineAt");
  const meetingAt = iso(raw.meetingAt, "meetingAt");
  if (questionsDeadlineAt && meetingAt && Date.parse(questionsDeadlineAt) > Date.parse(meetingAt)) {
    throw new SalaGuerraValidationError("questionsDeadlineAt: el limite para enviar preguntas no puede ser posterior a la fecha de la junta.");
  }
  return { questionsDeadlineAt, meetingAt, actaReference: trimmedOrNull(raw.actaReference, "actaReference", 300) };
}

// ---------------------------------------------------------------------------
// Maquina de estados
// ---------------------------------------------------------------------------

/** Mismo grafo que el trigger `licitaciones.enforce_junta_question_transition` (migracion 029). */
export const JUNTA_QUESTION_TRANSITIONS: Readonly<Record<JuntaQuestionStatus, readonly JuntaQuestionStatus[]>> = {
  borrador: ["aprobada", "descartada"],
  aprobada: ["borrador", "enviada", "descartada"],
  enviada: ["respondida", "descartada"],
  respondida: [],
  descartada: ["borrador"],
};

export function canTransitionQuestion(from: JuntaQuestionStatus, to: JuntaQuestionStatus): boolean {
  return JUNTA_QUESTION_TRANSITIONS[from].includes(to);
}

export interface JuntaTransitionRequest {
  readonly to: JuntaQuestionStatus;
  readonly sentReference?: string | null;
  readonly answerText?: string | null;
  readonly answerActaReference?: string | null;
  readonly discardReason?: string | null;
}

export function parseTransitionRequest(raw: Record<string, unknown>): JuntaTransitionRequest {
  if (!isOneOf(JUNTA_QUESTION_STATUSES, raw.to)) throw new SalaGuerraValidationError('to: se esperaba "borrador" | "aprobada" | "enviada" | "respondida" | "descartada".');
  return {
    to: raw.to,
    sentReference: trimmedOrNull(raw.sentReference, "sentReference", 300),
    answerText: trimmedOrNull(raw.answerText, "answerText", 6000),
    answerActaReference: trimmedOrNull(raw.answerActaReference, "answerActaReference", 300),
    discardReason: trimmedOrNull(raw.discardReason, "discardReason", 500),
  };
}

/**
 * Valida una transicion: grafo permitido, rol (aprobar exige DECISION_ROLES; el resto WRITE_ROLES) y
 * datos obligatorios (respuesta para `respondida`, motivo para `descartada`). Lanza
 * `JuntaQuestionRejectedError`; la base repite estas reglas en su trigger (defensa en profundidad).
 */
export function assertQuestionTransition(question: Pick<JuntaQuestionRecord, "status">, request: JuntaTransitionRequest, role: LicitacionesRole): void {
  if (!WRITE_ROLES.includes(role)) throw new JuntaQuestionRejectedError("rol_no_autorizado", `El rol "${role}" no puede modificar preguntas de la junta de aclaraciones.`);
  if (!canTransitionQuestion(question.status, request.to)) {
    throw new JuntaQuestionRejectedError("transicion_no_permitida", `Una pregunta "${question.status}" no puede pasar a "${request.to}".`);
  }
  if (request.to === "aprobada" && !DECISION_ROLES.includes(role)) {
    throw new JuntaQuestionRejectedError("rol_no_autorizado", `Aprobar una pregunta exige uno de los roles: ${DECISION_ROLES.join(", ")}.`);
  }
  if (request.to === "respondida" && !request.answerText) throw new JuntaQuestionRejectedError("datos_requeridos", "answerText: registrar la respuesta del acta exige el texto de la respuesta.");
  if (request.to === "descartada" && !request.discardReason) throw new JuntaQuestionRejectedError("datos_requeridos", "discardReason: descartar una pregunta exige un motivo.");
}

/** El texto solo se edita en borrador (aprobar lo congela; para cambiarlo hay que devolverla a borrador). */
export function assertQuestionEditable(question: Pick<JuntaQuestionRecord, "status">): void {
  if (question.status !== "borrador") {
    throw new JuntaQuestionRejectedError("texto_congelado", `Una pregunta "${question.status}" no se edita: devuelvela a borrador primero.`);
  }
}

// ---------------------------------------------------------------------------
// Semaforo de la fecha limite de envio + resumen
// ---------------------------------------------------------------------------

export interface JuntaSummary {
  readonly counts: Readonly<Record<JuntaQuestionStatus, number>>;
  /** Preguntas aun sin enviar (borrador + aprobada): lo que el recordatorio vigila. */
  readonly pendingToSend: number;
  readonly questionsDeadline: { readonly at: string | null; readonly semaphore: DeadlineSemaphore };
  readonly meetingAt: string | null;
}

export function buildJuntaSummary(questions: readonly JuntaQuestionRecord[], config: JuntaConfigRecord | null, nowIso: string): JuntaSummary {
  const counts: Record<JuntaQuestionStatus, number> = { borrador: 0, aprobada: 0, enviada: 0, respondida: 0, descartada: 0 };
  for (const q of questions) counts[q.status] += 1;
  const pendingToSend = counts.borrador + counts.aprobada;
  // La fecha limite deja de importar (gris) cuando ya no queda nada por enviar.
  const closed = pendingToSend === 0;
  return {
    counts,
    pendingToSend,
    questionsDeadline: { at: config?.questionsDeadlineAt ?? null, semaphore: deadlineSemaphore(config?.questionsDeadlineAt ?? null, nowIso, closed) },
    meetingAt: config?.meetingAt ?? null,
  };
}

