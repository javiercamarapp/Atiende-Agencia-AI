// Seam explícito hacia Fase 2 §2 (mismo patrón que
// domain-restaurantes/src/whatsapp/turn-handler.ts): el loop de tool-use real
// contra un LLM (`llm-turn-handler.ts`, más abajo en esta misma carpeta) implementa
// esta interfaz. `whatsapp/inbound.ts` depende SOLO de `WhatsAppTurnHandler`, nunca
// de `createLlmWhatsAppTurnHandler` directamente — así un test de plomería puede
// inyectar un handler de prueba sin montar un LlmGateway real.
import type { ConversationMessage } from "../repository.ts";
import type { CitasCustomerContext } from "../customers.ts";

export interface WhatsAppTurnHandler {
  handleInboundMessage(args: {
    readonly organizationId: string;
    readonly phone: string;
    /** Historial completo, ya con el mensaje nuevo appended. SOLO texto (ver
     * diseño Fase 2 §2.5) — nunca tool_calls/resultados crudos. */
    readonly messages: readonly ConversationMessage[];
    readonly customer: CitasCustomerContext;
  }): Promise<{ readonly reply: string; readonly appointmentId: string | null; readonly propertyId: string | null }>;
}

/**
 * Fallback mínimo SIN LLM — útil para tests de plomería que no necesitan ejercitar
 * el agente real, y como último recurso si algún día se necesita desactivar el
 * agente sin tocar `whatsapp/inbound.ts` ni la ruta HTTP del webhook (mismo rol que
 * `acknowledgeOnlyTurnHandler` en domain-restaurantes, simplificado: citas no tiene
 * un concepto de "callback request" propio, así que este handler no escribe nada,
 * solo acusa recibo).
 */
export function acknowledgeOnlyTurnHandler(): WhatsAppTurnHandler {
  return {
    async handleInboundMessage() {
      return {
        reply: "Gracias por tu mensaje. Alguien de nuestro equipo te va a contactar en breve.",
        appointmentId: null,
        propertyId: null,
      };
    },
  };
}
