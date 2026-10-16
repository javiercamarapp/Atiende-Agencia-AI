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
import type { CustomerLookupResult, WhatsAppAgentConfigInput } from "../types.ts";

export interface WhatsAppTurnHandler {
  handleInboundMessage(args: {
    readonly organizationId: string;
    readonly phone: string;
    /** Historial completo, ya con el mensaje nuevo appended. */
    readonly messages: readonly ConversationMessage[];
    readonly customer: CustomerLookupResult;
    /** Sucursal dueña del número de WhatsApp que recibió el mensaje (modelo PM: un número
     * por sucursal). `null`/ausente = número por defecto de la organización. */
    readonly propertyId?: string | null;
    /** Id del mensaje de Meta que dispara este turno: hace idempotente el aviso al equipo ante reenvios y reintentos. */
    readonly messageId?: string;
    /** Instante absoluto (ms, mismo reloj que `Date.now`) antes del cual el turno debe TERMINAR para que la funcion del
     * webhook alcance a confirmar la transaccion y encolar la respuesta. Ausente = solo manda el presupuesto propio del handler. */
    readonly finTurnoMs?: number;
    /** Prueba del dueno en el panel (NO el webhook): `preview` corre las herramientas SIN efectos (pedido simulado, sin avisos).
     * Lo fija solo el servidor desde la ruta de preview; nunca sale de un argumento del modelo ni del cliente de WhatsApp. */
    readonly modo?: "real" | "preview";
    /** Solo `preview`: cliente de la organizacion que el panel eligio simular (ver `AgentToolContext.previewCustomerId`). */
    readonly previewCustomerId?: string | null;
    /** Solo `preview`: configuracion del agente en BORRADOR (ya validada) para probarla antes de guardar. Ausente = la vigente. */
    readonly configBorrador?: WhatsAppAgentConfigInput | null;
  }): Promise<{
    readonly reply: string;
    readonly orderId: string | null;
    readonly propertyId: string | null;
    /** R-21: el agente pidio un humano (`escalar_a_humano`); el webhook abre la toma de handoff. */
    readonly escalacion?: { readonly motivo: string };
    /** El agente pide la ubicacion del cliente con el boton nativo de WhatsApp (una sola vez por pedido): el webhook encola, ademas del
     * texto, un mensaje interactivo `location_request_message` (dentro de la ventana de 24 h del cliente). */
    readonly pedirUbicacion?: true;
    /** B03: el turno termino mostrando el resumen de un pedido por confirmar. El webhook lo envia en UN mensaje interactivo con los botones «Confirmar pedido» y
     * «Cambiar algo» atados a esta cotizacion (huella e instante); el «si» escrito sigue valiendo. Ausente = texto solo, como siempre. */
    readonly pedirConfirmacion?: { readonly quoteHash: string; readonly quotedAtMs: number };
    /** Solo `preview`: el pedido SIMULADO que devolvio `crear_pedido` (no existe en la base). */
    readonly pedidoSimulado?: unknown;
  }>;
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
