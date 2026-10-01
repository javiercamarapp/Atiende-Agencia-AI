// L-05 -- orquestacion de avisos y solicitudes de decision por WhatsApp sobre un
// `WhatsAppRepository` (sesion de SISTEMA: `auth.uid()` NULL). Nada de aqui envia por la
// red: solo escribe en la cola `whatsapp_outbox`; el envio real lo hace el dispatcher de
// `@atiende/whatsapp-gateway` (cron / webhook), y nunca corre en tests ni en CI.
import { DECISION_TOKEN_TTL_HOURS, buildDecisionRequestMessage, buildNoticeMessage, generateActionToken, sha256TokenHash } from "./whatsapp.ts";
import type { NoticeKind, TenderSummaryForMessage, WhatsAppTopic } from "./whatsapp.ts";
import type { WhatsAppRepository } from "./whatsapp-repository.ts";
import type { TenderDeadlineReminderRecord } from "./repository.ts";

export interface DecisionRequestInput {
  readonly organizationId: string;
  readonly tender: TenderSummaryForMessage & { readonly id: string };
  /** Reloj inyectable para pruebas deterministas. */
  readonly now?: () => Date;
  readonly ttlHours?: number;
}

export interface DecisionRequestResult {
  /** Solicitudes encoladas (una por persona con contacto activo y rol go/no-go). */
  readonly requested: number;
  /** Personas omitidas porque ya tenian una solicitud vigente sin usar. */
  readonly alreadyPending: number;
  /** Personas con contacto activo para el tema. 0 -> nadie recibira nada (opt-in pendiente). */
  readonly eligible: number;
}

/**
 * Pide la decision go / no-go de una convocatoria a cada persona con WhatsApp activo y rol
 * go/no-go VIGENTE. Por persona: dos tokens (go / no_go) con expiracion, y UN mensaje con dos
 * botones. Idempotente: si ya hay una solicitud vigente sin usar no se duplica.
 */
export async function requestGoNoGoDecisionsByWhatsApp(repo: WhatsAppRepository, input: DecisionRequestInput): Promise<DecisionRequestResult> {
  const now = (input.now ?? (() => new Date()))();
  const ttl = Math.min(Math.max(input.ttlHours ?? DECISION_TOKEN_TTL_HOURS, 1), 24 * 7 - 1);
  const expiresAtIso = new Date(now.getTime() + ttl * 3_600_000).toISOString();
  const contacts = await repo.activeContacts(input.organizationId, "decisiones");
  let requested = 0;
  let alreadyPending = 0;
  for (const contact of contacts) {
    const go = generateActionToken();
    const noGo = generateActionToken();
    const goId = await repo.issueActionToken({ organizationId: input.organizationId, userId: contact.userId, tenderId: input.tender.id, action: "go", tokenHash: go.hash, expiresAtIso });
    if (goId === null) {
      alreadyPending += 1;
      continue;
    }
    const noGoId = await repo.issueActionToken({ organizationId: input.organizationId, userId: contact.userId, tenderId: input.tender.id, action: "no_go", tokenHash: noGo.hash, expiresAtIso });
    if (noGoId === null) {
      alreadyPending += 1;
      continue;
    }
    const payload = buildDecisionRequestMessage(contact.phoneE164, input.tender, go.token, noGo.token);
    await repo.enqueueOutbox(input.organizationId, "decision_request", `decision:${input.tender.id}:${contact.userId}:${sha256TokenHash(go.token).slice(0, 16)}`, payload);
    requested += 1;
  }
  return { requested, alreadyPending, eligible: contacts.length };
}

export interface NoticeInput {
  readonly organizationId: string;
  readonly kind: NoticeKind;
  readonly tender: TenderSummaryForMessage;
  /** Identifica el hecho avisado (p. ej. id del recordatorio / de la convocatoria): con el usuario forma el dedupe. */
  readonly dedupeRef: string;
  readonly extra?: string;
}

const TOPIC_BY_KIND: Record<NoticeKind, WhatsAppTopic> = { plazo: "plazos", convocatoria: "convocatorias", fallo: "fallos" };

/** Encola un aviso para cada persona con WhatsApp activo y ese tema habilitado. Idempotente por `dedupeRef`. */
export async function enqueueTenderNotices(repo: WhatsAppRepository, input: NoticeInput): Promise<number> {
  const contacts = await repo.activeContacts(input.organizationId, TOPIC_BY_KIND[input.kind]);
  let enqueued = 0;
  for (const contact of contacts) {
    const payload = buildNoticeMessage(contact.phoneE164, input.kind, input.tender, input.extra);
    const id = await repo.enqueueOutbox(input.organizationId, `notice_${input.kind}`, `notice:${input.kind}:${input.dedupeRef}:${contact.userId}`, payload);
    if (id !== null) enqueued += 1;
  }
  return enqueued;
}

/** Recordatorios de plazo (ya calculados por el barrido existente) -> avisos por WhatsApp. */
export async function enqueueDeadlineReminderWhatsApp(repo: WhatsAppRepository, organizationId: string, reminders: readonly TenderDeadlineReminderRecord[]): Promise<number> {
  let total = 0;
  for (const reminder of reminders) {
    const dias = reminder.daysRemaining <= 0 ? "Vence hoy." : `Faltan ${reminder.daysRemaining} dia(s).`;
    total += await enqueueTenderNotices(repo, {
      organizationId,
      kind: "plazo",
      tender: { title: reminder.message, rawText: reminder.message },
      dedupeRef: reminder.id,
      extra: dias,
    });
  }
  return total;
}
