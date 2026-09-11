// ─────────────────────────────────────────────────────────────────────────────
// Memoria de estado inyectada al prompt del LLM.
//
// atiende.ai NO tiene una función dedicada para esto — el estado se pasaba
// ad-hoc al armar el system prompt en el orquestador (`src/lib/llm/*`). Aquí
// se extrae como pieza reusable y testeable: dado el estado/contexto
// persistido de la conversación, produce el bloque de texto que se inyecta al
// system prompt para que el agente sepa qué ya se decidió ANTES de este
// mensaje (evita que, p. ej., vuelva a preguntar la fecha que el cliente ya
// dio, o que re-ofrezca un horario que el flow ya descartó).
// ─────────────────────────────────────────────────────────────────────────────

import type { StoredConversationState } from './state/types.ts';

/**
 * Serializa el estado activo a un bloque de texto plano para el system
 * prompt. Determinístico y sin PII más allá de lo que el propio `context` ya
 * tenía (el caller decide qué guarda ahí).
 */
export function buildStatePromptBlock<TState extends string, TContext extends Record<string, unknown>>(
  stored: StoredConversationState<TState, TContext>,
): string {
  if (!stored.state) {
    return 'MEMORIA DE CONVERSACIÓN: sin flow multi-turno activo — este es un mensaje nuevo o de seguimiento libre.';
  }

  const contextEntries = Object.entries(stored.context);
  const contextLines = contextEntries.length
    ? contextEntries.map(([k, v]) => `  - ${k}: ${formatValue(v)}`).join('\n')
    : '  (sin datos adicionales todavía)';

  return [
    `MEMORIA DE CONVERSACIÓN: hay un flow en curso, estado actual = "${stored.state}".`,
    'Datos ya confirmados en este flow (NO los vuelvas a preguntar):',
    contextLines,
    'Si el mensaje del cliente no corresponde a este flow, puedes cambiar de tema, pero no ignores estos datos si retoma el flow.',
  ].join('\n');
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
