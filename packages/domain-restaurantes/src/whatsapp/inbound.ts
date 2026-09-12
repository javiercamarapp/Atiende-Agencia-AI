// Plomería determinista del webhook de WhatsApp — port literal de la parte
// SIN LLM de restaurantes/supabase/functions/whatsapp-webhook/index.ts: dedupe de
// mensaje at-least-once (claim_whatsapp_message), lease de conversación de 120s
// (claim_whatsapp_conversation, evita que mensajes casi-simultáneos del mismo
// teléfono corrompan el historial), append atómico (whatsapp_append_turn), y
// redacción de datos sensibles ANTES de guardar cualquier mensaje real del cliente.
import { actorHash } from "../rate-limit.ts";
import { lookupCustomer } from "../customers.ts";
import type { ConversationMessage, RestaurantesRepository } from "../repository.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";

// Hallazgo real de la auditoría adversarial del origen (3-sep-2026): el agente le
// dijo a un cliente de prueba "no procesamos ni guardamos los datos que
// compartiste por chat" al mandar un número de tarjeta completo — pero el mensaje se
// guardaba tal cual, número/vencimiento/CVV incluidos, en texto plano. Este helper
// redacta esos patrones ANTES de guardar cualquier mensaje real, para que esa
// afirmación sea cierta de verdad.
export function redactSensitiveInfo(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[tarjeta oculta]")
    .replace(/\b(?:cvv|cvc|c\.?v\.?v\.?)\s*:?\s*\d{3,4}\b/gi, "[cvv oculto]")
    .replace(/\b\d{1,2}\/\d{2,4}\b/g, "[vencimiento oculto]");
}

export interface InboundMessageOutcome {
  readonly ok: boolean;
  /** true si Meta debe reintentar el batch firmado completo (ver diseño Fase 1 §4.3c). */
  readonly retryable: boolean;
  readonly reply?: string;
}

/**
 * Procesa UN mensaje entrante de WhatsApp de punta a punta: dedupe -> lease ->
 * append del mensaje del usuario (a salvo aunque el turn handler tarde) -> memoria de
 * cliente -> turno (inyectado, ver turn-handler.ts) -> append de la respuesta ->
 * liberar el lease. Cualquier fallo se marca explícitamente como reintentable o no,
 * nunca se pierde en silencio — mismo contrato que el origen.
 */
export async function handleInboundWhatsAppMessage(
  repo: RestaurantesRepository,
  turnHandler: WhatsAppTurnHandler,
  args: { readonly organizationId: string; readonly messageId: string; readonly phone: string; readonly body: string; readonly phoneNumberId: string },
): Promise<InboundMessageOutcome> {
  const { organizationId, messageId, phone, body, phoneNumberId } = args;
  const phoneHash = actorHash(phone);

  const claimed = await repo.claimWhatsAppMessage(organizationId, messageId, phoneHash);
  // Meta delivery es at-least-once; un id ya procesado/en curso se acusa sin reprocesar.
  if (!claimed) return { ok: true, retryable: false };

  const lease = await repo.claimWhatsAppConversation(organizationId, phoneHash, messageId, 120);
  if (!lease) {
    await repo.markInboundEventFailed(organizationId, messageId, "ConversationBusy");
    return { ok: false, retryable: true };
  }

  try {
    const userMessage: ConversationMessage = { role: "user", content: redactSensitiveInfo(body) };
    const messagesAfterUser = await repo.appendWhatsAppUserMessageOnce(organizationId, phone, userMessage);

    const customer = await lookupCustomer(repo, organizationId, phone);
    const turn = await turnHandler.handleInboundMessage({ organizationId, phone, messages: messagesAfterUser, customer });

    const assistantMessage: ConversationMessage = { role: "assistant", content: turn.reply };
    await repo.whatsappAppendTurn(organizationId, phone, [assistantMessage], turn.orderId ? "completed" : "active", turn.orderId, turn.propertyId);

    // Encola el envío REAL de la respuesta — antes de este cambio, `outcome.reply`
    // solo se guardaba en el historial de la conversación y nunca llegaba de
    // verdad al cliente (ver @atiende/whatsapp-gateway/README.md).
    await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_reply", `inbound-reply:${messageId}`, {
      to: phone,
      phone_number_id: phoneNumberId,
      body: turn.reply,
    });

    await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
    return { ok: true, retryable: false, reply: turn.reply };
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "failed", errorClass);
    return { ok: false, retryable: true };
  }
}
