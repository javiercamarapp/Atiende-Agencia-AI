// Seam explícito hacia Fase 2 (diseño Fase 1 §4.3/§6): el loop de tool-use real
// contra un LLM (`@atiende/agent-core`'s GatewayRouter con las tools
// buscar_producto/cotizar_pedido/crear_pedido/registrar_contacto/
// buscar_sucursal_cercana) es exactamente el "agente de WhatsApp completo end-to-end
// con LLM real" que esta fase deja fuera a propósito. Esta interfaz es el punto de
// inyección: Fase 2 reemplaza `acknowledgeOnlyTurnHandler` por una implementación real
// sin tocar la ruta HTTP ni la plomería de whatsapp/inbound.ts.
import { registerCallbackRequest } from "../callback-requests.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { ConversationMessage } from "../repository.ts";
import type { CustomerLookupResult } from "../types.ts";

export interface WhatsAppTurnHandler {
  handleInboundMessage(args: {
    readonly organizationId: string;
    readonly phone: string;
    /** Historial completo, ya con el mensaje nuevo appended. */
    readonly messages: readonly ConversationMessage[];
    readonly customer: CustomerLookupResult;
  }): Promise<{ readonly reply: string; readonly orderId: string | null; readonly propertyId: string | null }>;
}

/**
 * Implementación mínima de Fase 1 — SIN LLM, solo para que el webhook esté
 * end-to-end vivo: acusa recibo y crea un callback_request para que un humano del
 * restaurante responda. Fase 2 reemplaza esta implementación por una que use
 * agent-core/gateway + las tools reales — la ruta HTTP no cambia.
 */
export function acknowledgeOnlyTurnHandler(repo: RestaurantesRepository): WhatsAppTurnHandler {
  return {
    async handleInboundMessage({ organizationId, phone }) {
      await registerCallbackRequest(repo, {
        organizationId,
        customerName: "Contacto de WhatsApp",
        customerPhone: phone,
        source: "whatsapp",
        reason: "mensaje_entrante_sin_agente",
      });
      return {
        reply: "Gracias por tu mensaje. Alguien de nuestro equipo te va a contactar en breve.",
        orderId: null,
        propertyId: null,
      };
    },
  };
}
