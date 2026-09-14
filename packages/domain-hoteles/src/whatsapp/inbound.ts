// Plomería determinista del webhook de WhatsApp de hoteles — port de
// domain-restaurantes/src/whatsapp/inbound.ts: dedupe de mensaje at-least-once
// (claimWhatsAppMessage), lease de conversación de 120s (claimWhatsAppConversation,
// evita que mensajes casi-simultáneos del mismo teléfono corrompan el historial),
// append atómico (whatsappAppendTurn), y redacción de datos sensibles ANTES de
// guardar cualquier mensaje real del huésped. Partición por PROPERTY (no por
// organización) — ver channel-config.ts.
import { actorHash } from "../rate-limit.ts";
import type { HotelesRepository } from "../repository.ts";
import type { ConversationMessage } from "../types.ts";
import type { HotelesWhatsAppTurnHandler } from "./turn-handler.ts";

// Mismo hallazgo real que documenta domain-restaurantes/whatsapp/inbound.ts: nunca
// basta con que el agente PROMETA no guardar datos sensibles — hay que redactarlos
// antes de persistir cualquier mensaje real, para que la promesa sea cierta.
export function redactSensitiveInfo(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[tarjeta oculta]")
    .replace(/\b(?:cvv|cvc|c\.?v\.?v\.?)\s*:?\s*\d{3,4}\b/gi, "[cvv oculto]")
    .replace(/\b\d{1,2}\/\d{2,4}\b/g, "[vencimiento oculto]");
}

export interface InboundMessageOutcome {
  readonly ok: boolean;
  /** true si Meta debe reintentar el batch firmado completo. */
  readonly retryable: boolean;
  readonly reply?: string;
}

/**
 * Procesa UN mensaje entrante de WhatsApp de punta a punta: dedupe -> lease ->
 * append del mensaje del huésped (a salvo aunque el turn handler tarde) -> turno
 * (inyectado, ver turn-handler.ts) -> append de la respuesta -> liberar el lease.
 * Cualquier fallo se marca explícitamente como reintentable o no, nunca se pierde en
 * silencio.
 */
export async function handleInboundWhatsAppMessage(
  repo: HotelesRepository,
  turnHandler: HotelesWhatsAppTurnHandler,
  args: { readonly organizationId: string; readonly propertyId: string; readonly messageId: string; readonly phone: string; readonly body: string; readonly phoneNumberId: string },
): Promise<InboundMessageOutcome> {
  const { organizationId, propertyId, messageId, phone, body, phoneNumberId } = args;
  const phoneHash = actorHash(phone);

  const claimed = await repo.claimWhatsAppMessage(propertyId, messageId, phoneHash);
  // Meta delivery es at-least-once; un id ya procesado/en curso se acusa sin reprocesar.
  if (!claimed) return { ok: true, retryable: false };

  const lease = await repo.claimWhatsAppConversation(propertyId, phoneHash, messageId, 120);
  if (!lease) {
    await repo.markInboundEventFailed(propertyId, messageId, "ConversationBusy");
    return { ok: false, retryable: true };
  }

  try {
    const userMessage: ConversationMessage = { role: "user", content: redactSensitiveInfo(body) };
    const messagesAfterUser = await repo.appendWhatsAppUserMessageOnce(propertyId, phone, userMessage);

    const turn = await turnHandler.handleInboundMessage({ organizationId, propertyId, phone, messages: messagesAfterUser });

    const assistantMessage: ConversationMessage = { role: "assistant", content: turn.reply };
    await repo.whatsappAppendTurn(propertyId, phone, [assistantMessage], turn.fnbOrderId ? "completed" : "active", turn.fnbOrderId);

    // Encola el envío REAL de la respuesta — antes de este cambio, `outcome.reply`
    // solo se guardaba en el historial de la conversación y nunca llegaba de
    // verdad al huésped (ver @atiende/whatsapp-gateway/README.md).
    await repo.enqueueMessagingOutbox(propertyId, organizationId, "whatsapp", "whatsapp.inbound_reply", `inbound-reply:${messageId}`, {
      to: phone,
      phone_number_id: phoneNumberId,
      body: turn.reply,
    });

    await repo.finishWhatsAppMessage(propertyId, messageId, phoneHash, "processed", null);
    return { ok: true, retryable: false, reply: turn.reply };
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await repo.finishWhatsAppMessage(propertyId, messageId, phoneHash, "failed", errorClass);
    return { ok: false, retryable: true };
  }
}
