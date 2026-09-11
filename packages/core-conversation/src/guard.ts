// ─────────────────────────────────────────────────────────────────────────────
// withConversationLock — punto de entrada único que junta las 3 piezas:
//   1. Lock distribuido (serializa mensajes concurrentes del mismo cliente)
//   2. Lectura de estado (para inyectar al prompt del LLM)
//   3. Handler del caller, que al terminar puede pedir una transición atómica
//
// Este es el wrapper que el webhook de WhatsApp / el orquestador de mensajes
// entrantes debe usar alrededor de CADA mensaje entrante, tal como
// `acquireConversationLock`/`releaseConversationLock` se usan en
// atiende.ai alrededor del pipeline completo (parse → LLM → acción → respuesta).
// ─────────────────────────────────────────────────────────────────────────────

import type { LockStore, AcquireLockOptions } from './lock/types.ts';
import { lockKey } from './lock/types.ts';
import type { ConversationStateMachine } from './state/state-machine.ts';
import type { StoredConversationState } from './state/types.ts';
import { buildStatePromptBlock } from './prompt-context.ts';

export interface ConversationGuardResult<T> {
  /** false si no se pudo tomar el lock a tiempo — el caller debe reintentar (ej: 500 → retry de QStash), NUNCA procesar sin serializar. */
  locked: boolean;
  result?: T;
}

/**
 * Ejecuta `handler` con el lock de `(tenantId, customerKey)` tomado. El
 * handler recibe el estado actual (para inyectar al prompt) y la máquina de
 * estados ya ligada a esta conversación para pedir transiciones atómicas.
 * Libera el lock SIEMPRE (éxito o excepción) — nunca deja un lock huérfano
 * antes de su TTL.
 */
export async function withConversationLock<
  TState extends string,
  TContext extends Record<string, unknown>,
  T,
>(
  opts: {
    lockStore: LockStore;
    stateMachine: ConversationStateMachine<TState, TContext>;
    tenantId: string;
    customerKey: string;
    conversationId: string;
    lockOptions?: AcquireLockOptions;
  },
  handler: (ctx: {
    state: StoredConversationState<TState, TContext>;
    promptBlock: string;
    transition: (
      to: TState | null,
      contextPatch?: Partial<TContext>,
    ) => ReturnType<ConversationStateMachine<TState, TContext>['transition']>;
  }) => Promise<T>,
): Promise<ConversationGuardResult<T>> {
  const key = lockKey(opts.tenantId, opts.customerKey);
  const { acquired, token } = await opts.lockStore.acquire(key, opts.lockOptions);

  if (!acquired) {
    return { locked: false };
  }

  try {
    const state = await opts.stateMachine.getState(opts.conversationId);
    const promptBlock = buildStatePromptBlock(state);

    const result = await handler({
      state,
      promptBlock,
      transition: (to, contextPatch) => opts.stateMachine.transition(opts.conversationId, to, contextPatch),
    });

    return { locked: true, result };
  } finally {
    if (token) await opts.lockStore.release(key, token);
  }
}
