// Plomería determinista del webhook de WhatsApp de citas — Fase 1 de citas NO
// construyó nada de esto (a diferencia de restaurantes/hoteles, que ya traían el
// seam listo desde su Fase 1, ver diseño Fase 2 §0/§2.6). Puerto de negocio: dedupe
// de mensaje at-least-once (`claimWhatsAppMessage`) + append atómico
// (`whatsappAppendTurn`) — igual que domain-restaurantes — pero la serialización de
// mensajes casi-simultáneos del mismo teléfono (el problema real que aquí
// reemplazaría a `claim_whatsapp_conversation`/la lease de 120s de restaurantes) se
// resuelve adoptando `@atiende/core-conversation::withConversationLock` (diseño
// Fase 2 §2.6-b): esta fase es su primer consumidor real, citado explícitamente
// como uno de los 3 verticales con el bug de doble-booking por mensajes
// casi-simultáneos que ese paquete existe para resolver.
import { ConversationStateMachine, DEFAULT_BOOKING_TRANSITIONS, InMemoryLockStore, InMemoryStateStore, withConversationLock, type BookingState, type LockStore } from "@atiende/core-conversation";
import { lookupCitasCustomer } from "../customers.ts";
import { actorHash } from "../rate-limit.ts";
import type { CitasRepository, ConversationMessage } from "../repository.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";

// Hallazgo real de la auditoría adversarial del origen de restaurantes (3-sep-2026,
// igual de aplicable aquí): un cliente puede compartir por accidente datos
// sensibles (número de tarjeta, y en citas — potencialmente datos médicos en
// `notes`) que se guardarían tal cual en texto plano si no se redactan antes de
// persistir cualquier mensaje real.
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
 * Junta el lock distribuido + una máquina de estados real de
 * `@atiende/core-conversation` (tabla de transiciones por defecto — citas no
 * necesita hoy ningún estado multi-turno propio más allá de la serialización, así
 * que el flujo nunca transiciona fuera de reposo (`null`); el valor real de esta
 * pieza en Fase 2 es el LOCK, no la máquina de estados). Construible una sola vez
 * por proceso e inyectable — producción real debe pasar un `RedisLockStore` (ver
 * `@atiende/core-conversation`) en vez del `InMemoryLockStore` por defecto, mismo
 * criterio que cualquier otro puerto de esta fase (inyectado, nunca construido
 * dentro de una ruta).
 */
export interface CitasConversationGuard {
  readonly lockStore: LockStore;
  readonly stateMachine: ConversationStateMachine<BookingState, Record<string, never>>;
}

export function createDefaultConversationGuard(): CitasConversationGuard {
  return {
    lockStore: new InMemoryLockStore(),
    stateMachine: new ConversationStateMachine(new InMemoryStateStore(), DEFAULT_BOOKING_TRANSITIONS),
  };
}

/**
 * Procesa UN mensaje entrante de WhatsApp de punta a punta: dedupe -> lock de
 * conversación (core-conversation) -> append del mensaje del usuario (a salvo
 * aunque el turn handler tarde) -> memoria de cliente -> turno (inyectado, ver
 * turn-handler.ts) -> append de la respuesta. Cualquier fallo se marca
 * explícitamente como reintentable o no, nunca se pierde en silencio.
 */
export async function handleInboundWhatsAppMessage(
  repo: CitasRepository,
  turnHandler: WhatsAppTurnHandler,
  guard: CitasConversationGuard,
  args: { readonly organizationId: string; readonly messageId: string; readonly phone: string; readonly body: string; readonly phoneNumberId: string },
): Promise<InboundMessageOutcome> {
  const { organizationId, messageId, phone, body, phoneNumberId } = args;
  const phoneHash = actorHash(phone);

  const claimed = await repo.claimWhatsAppMessage(organizationId, messageId, phoneHash);
  // Meta delivery es at-least-once; un id ya procesado/en curso se acusa sin reprocesar.
  if (!claimed) return { ok: true, retryable: false };

  try {
    const guardResult = await withConversationLock(
      { lockStore: guard.lockStore, stateMachine: guard.stateMachine, tenantId: organizationId, customerKey: phoneHash, conversationId: `${organizationId}:${phoneHash}` },
      async () => {
        const userMessage: ConversationMessage = { role: "user", content: redactSensitiveInfo(body) };
        const messagesAfterUser = await repo.appendWhatsAppUserMessageOnce(organizationId, phone, userMessage);

        const customer = await lookupCitasCustomer(repo, organizationId, phone);
        const turn = await turnHandler.handleInboundMessage({ organizationId, phone, messages: messagesAfterUser, customer });

        const assistantMessage: ConversationMessage = { role: "assistant", content: turn.reply };
        await repo.whatsappAppendTurn(organizationId, phone, [assistantMessage], turn.appointmentId ? "completed" : "active", turn.appointmentId, turn.propertyId);

        // Encola el envío REAL de la respuesta — antes de este cambio, `outcome.reply`
        // solo se guardaba en el historial de la conversación y nunca llegaba de
        // verdad al cliente (ver @atiende/whatsapp-gateway/README.md). `dedupeKey`
        // por `messageId` hace este encolado idempotente ante un reintento at-least-once
        // de Meta: `claimWhatsAppMessage` ya bloquea el reproceso, pero esta clave es
        // una segunda capa por si algún día este método se llama fuera de ese guard.
        await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_reply", `inbound-reply:${messageId}`, {
          to: phone,
          phone_number_id: phoneNumberId,
          body: turn.reply,
        });
        return turn;
      },
    );

    if (!guardResult.locked) {
      // No se pudo serializar a tiempo contra otro mensaje casi-simultáneo del
      // mismo teléfono — el caller debe reintentar (Meta reintenta el batch
      // firmado completo), NUNCA procesar sin el lock tomado.
      await repo.markInboundEventFailed(organizationId, messageId, "ConversationLockTimeout");
      return { ok: false, retryable: true };
    }

    await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
    return { ok: true, retryable: false, reply: guardResult.result?.reply };
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "failed", errorClass);
    return { ok: false, retryable: true };
  }
}
