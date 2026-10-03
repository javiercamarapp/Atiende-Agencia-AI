// Seam explícito hacia el agente de WhatsApp con LLM real (diseño Fase 2 §2/§3):
// misma forma que WhatsAppTurnHandler de domain-restaurantes, pero con su propia
// interfaz porque ConversationMessage/repo de hoteles son distintos (propertyId en
// vez de organizationId como clave de partición, sin CustomerLookupResult — hoteles
// Fase 2 no porta memoria de huésped, solo el ticket de F&B). `acknowledgeOnlyTurnHandler`
// es la implementación mínima que ya deja el webhook vivo end-to-end sin LLM;
// `createLlmHotelesWhatsAppTurnHandler` (llm-turn-handler.ts) la reemplaza sin tocar
// la ruta HTTP ni whatsapp/inbound.ts.
import { registerContactoNoOperativo } from "../contacto-no-operativo.ts";
import type { HotelesRepository } from "../repository.ts";
import type { ConversationMessage } from "../types.ts";

export interface HotelesWhatsAppTurnHandler {
  handleInboundMessage(args: {
    readonly organizationId: string;
    readonly propertyId: string;
    readonly phone: string;
    /** Historial completo, ya con el mensaje nuevo appended. */
    readonly messages: readonly ConversationMessage[];
  }): Promise<HotelesTurnOutcome>;
}

/**
 * Resultado de un turno. `handoff` (H-20): el agente pide que una persona continue la conversacion (lo pidio el huesped o el
 * agente, o el gobierno lo bloqueo por kill switch / presupuesto). `motivo` es un codigo corto sin PII (a-z, 0-9, _).
 * Quien procesa el mensaje (inbound.ts) marca la conversacion en `humano` y notifica; mientras este en humano el agente calla.
 */
export interface HotelesTurnOutcome {
  readonly reply: string;
  readonly fnbOrderId: string | null;
  readonly handoff?: { readonly motivo: string };
}

/**
 * Implementación mínima — SIN LLM: acusa recibo y registra un contacto no operativo
 * para que un humano de la property responda. Reemplazable sin tocar la ruta HTTP ni
 * la plomería de whatsapp/inbound.ts.
 */
export function acknowledgeOnlyTurnHandler(repo: HotelesRepository, handoffMotivo?: string): HotelesWhatsAppTurnHandler {
  return {
    async handleInboundMessage({ organizationId, propertyId, phone }) {
      await registerContactoNoOperativo(repo, {
        organizationId,
        propertyId,
        guestPhone: phone,
        guestName: null,
        reason: "mensaje_entrante_sin_agente",
        message: null,
        source: "whatsapp",
      });
      return {
        reply: "Gracias por tu mensaje. Alguien del hotel te va a contactar en breve.",
        fnbOrderId: null,
        // H-20: sin agente (pausado / sin presupuesto) el mensaje debe llegar a una persona: la conversacion pasa a humano.
        ...(handoffMotivo ? { handoff: { motivo: handoffMotivo } } : {}),
      };
    },
  };
}
