// packages/voice-gateway/src/bridge/gptlive-agent-bridge.ts
//
// DISEÑO (no implementado — no hay API de GPT-Live-1 contra la cual
// implementar nada real todavía). Deja el ENCHUFE listo para el día en que
// exista: GPT-Live-1 escucha/habla full-duplex y, cuando necesita razonar o
// ejecutar una herramienta de negocio (buscar disponibilidad, cotizar,
// crear una reservación), delega esa decisión a un modelo BACKEND — ese rol
// es el que `LlmGateway` (agent-core) ya cumple hoy para chat/texto.
//
// Flujo diseñado:
//   1. GPT-Live-1 abre el canal full-duplex vía `GptLiveVoiceProvider.startSession`.
//   2. A media conversación, GPT-Live-1 dispara un webhook/evento de
//      tool-calling (payload exacto: DESCONOCIDO hasta que exista la API
//      real — no se inventa aquí).
//   3. Este bridge traduce ese evento a una `LlmCompletionRequest` de
//      agent-core y llama `LlmGateway.complete({ tenantId, runId,
//      lane: 'interactive', role: 'voice-tool-planner', request })` —
//      MISMO gateway, mismo circuit breaker, mismo presupuesto que ya usa
//      el resto del monorepo para texto. Ninguna infraestructura nueva.
//   4. La respuesta del backend (texto y/o resultado de tool) vuelve a
//      GPT-Live-1 para que la hable — sin romper el full-duplex.
//
// Import type-only: agent-core es una dependencia real del monorepo, no un
// stub — el bridge referencia su tipo público real hoy mismo, aunque el
// cuerpo del método esté sin implementar.

import type { LlmGateway } from '@atiende/agent-core/gateway';

/** Payload real de GPT-Live-1 al pedir una decisión al backend — TBD hasta
 *  que exista documentación pública de la API. Placeholder deliberadamente
 *  mínimo, NO inventado más allá de lo que ya se sabe (que delega a un
 *  modelo backend separado). */
export interface GptLiveToolCallEvent {
  conversationId: string;
  transcriptSoFar: string;
  // El resto del shape se confirma contra la documentación real de
  // GPT-Live-1 el día que exista — no se rellena a ciegas.
}

export interface GptLiveToolCallResult {
  spokenResponse: string;
}

export interface VoiceAgentBridge {
  handleToolCall(event: GptLiveToolCallEvent): Promise<GptLiveToolCallResult>;
}

/**
 * INERTE por la misma razón que GptLiveVoiceProvider: no hay API contra la
 * cual implementar el cuerpo real todavía. El día que exista, este método
 * se llena — la firma y la dependencia de `LlmGateway` ya quedan fijas hoy.
 */
export function createGptLiveAgentBridge(_gateway: LlmGateway): VoiceAgentBridge {
  return {
    async handleToolCall(_event: GptLiveToolCallEvent): Promise<GptLiveToolCallResult> {
      throw new Error(
        'gptlive-agent-bridge: GPT-Live-1 aún no tiene API pública — este bridge no puede activarse todavía.',
      );
    },
  };
}
