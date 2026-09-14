// packages/voice-gateway/src/bridge/gptlive-agent-bridge.ts
//
// ACTIVO desde el 12-sep-2026: GPT-Live-1 (OpenAI) escucha/habla full-duplex
// y, cuando necesita razonar o ejecutar una herramienta de negocio (buscar
// disponibilidad, cotizar, crear una reservación), delega esa decisión a un
// modelo BACKEND — ese rol es EXACTAMENTE el que `LlmGateway` (agent-core) ya
// cumple hoy para chat/texto. Este bridge lo conecta: cero infraestructura
// nueva, mismo circuit breaker, mismo presupuesto, misma escalera de
// fallback que ya usa el resto del monorepo para texto.
//
// Flujo real:
//   1. GPT-Live-1 abre el canal full-duplex vía `GptLiveVoiceProvider.startSession`.
//   2. A media conversación, GPT-Live-1 (o el bridge de telefonía/servidor
//      que orquesta la sesión) dispara `handleToolCall` con la transcripción
//      hasta ese momento.
//   3. Este bridge arma una `LlmCompletionRequest` de agent-core y llama
//      `LlmGateway.complete({ tenantId, runId, lane: 'interactive',
//      role: VOICE_TOOL_PLANNER_ROLE, request })` — MISMO gateway, mismo
//      circuit breaker, mismo presupuesto que ya usa el resto del monorepo
//      para texto.
//   4. La respuesta del backend (texto y/o resultado de tool) vuelve a
//      GPT-Live-1 para que la hable — sin romper el full-duplex.
//
// PENDIENTE DE CONFIRMAR (no inventado): el payload EXACTO que GPT-Live-1
// manda a un webhook/evento de tool-calling propio (si acaso expone uno
// nativo, en vez de que el orquestador de la vertical arme `transcriptSoFar`
// a mano desde `onTranscript` de `startSession`) no se pudo confirmar contra
// documentación real hoy — `GptLiveToolCallEvent` de abajo modela lo mínimo
// que YA se puede construir desde el contrato compartido (`VoiceTranscriptEvent`
// vía `onTranscript`), no un webhook nativo no confirmado. El llamador
// (turn handler de cada vertical) es quien arma este evento hoy, acumulando
// transcripción real de `startSession`.
//
// El registro de la escalera del rol (`gateway.registerLadder(VOICE_TOOL_PLANNER_ROLE, [...])`)
// es responsabilidad de quien construye el `LlmGateway` de la app (igual que
// cualquier otro rol) — este bridge no la registra por sí mismo, para no
// imponer qué proveedores de texto usa cada vertical.

import type { LlmGateway } from '@atiende/agent-core/gateway';

/** Nombre lógico del rol de LlmGateway que atiende las decisiones de
 *  tool-calling delegadas por GPT-Live-1 — regístralo con
 *  `gateway.registerLadder(VOICE_TOOL_PLANNER_ROLE, [...])` antes de usar
 *  este bridge (mismo requisito que cualquier otro rol de `LlmGateway`). */
export const VOICE_TOOL_PLANNER_ROLE = 'voice-tool-planner';

/** Prompt de sistema mínimo y agnóstico de vertical — cada vertical que
 *  necesite instrucciones de negocio específicas las inyecta en
 *  `transcriptSoFar`/su propio turn handler antes de llamar `handleToolCall`,
 *  igual que ya hacen con el LLM de texto; este bridge no las inventa. */
const DEFAULT_SYSTEM_PROMPT =
  'Eres el planificador de herramientas de un agente de voz full-duplex (GPT-Live-1). ' +
  'Con la transcripción de la conversación hasta ahora, decide y ejecuta la acción de negocio ' +
  'necesaria y responde con el texto exacto que el agente de voz debe decir a continuación.';

export interface GptLiveToolCallEvent {
  conversationId: string;
  /** Tenant real (organización) que paga/audita esta llamada — requerido por
   *  `LlmGateway.complete` para presupuesto y gate de residencia. */
  tenantId: string;
  transcriptSoFar: string;
}

export interface GptLiveToolCallResult {
  spokenResponse: string;
}

export interface VoiceAgentBridge {
  handleToolCall(event: GptLiveToolCallEvent): Promise<GptLiveToolCallResult>;
}

export interface GptLiveAgentBridgeOptions {
  /** Rol lógico a usar contra `LlmGateway` — por defecto `VOICE_TOOL_PLANNER_ROLE`,
   *  sobreescribible si una vertical necesita una escalera de proveedores
   *  distinta para voz que para texto. */
  role?: string;
  systemPrompt?: string;
}

export function createGptLiveAgentBridge(gateway: LlmGateway, opts: GptLiveAgentBridgeOptions = {}): VoiceAgentBridge {
  const role = opts.role ?? VOICE_TOOL_PLANNER_ROLE;
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  return {
    async handleToolCall(event: GptLiveToolCallEvent): Promise<GptLiveToolCallResult> {
      if (!event.tenantId.trim()) throw new Error('gptlive-agent-bridge: tenantId requerido');
      if (!event.conversationId.trim()) throw new Error('gptlive-agent-bridge: conversationId requerido');

      const result = await gateway.complete({
        tenantId: event.tenantId,
        // `conversationId` como `runId`: una sesión de voz completa es UNA
        // corrida a efectos de presupuesto/circuit breaker, igual que una
        // corrida de agente de texto — mismo criterio que el resto del
        // monorepo (un `runId` estable por conversación, no uno nuevo por
        // cada turno).
        runId: event.conversationId,
        lane: 'interactive',
        role,
        request: {
          system: systemPrompt,
          messages: [{ role: 'user', content: event.transcriptSoFar }],
        },
      });

      return { spokenResponse: result.text };
    },
  };
}
