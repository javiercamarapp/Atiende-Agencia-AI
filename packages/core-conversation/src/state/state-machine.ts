// ─────────────────────────────────────────────────────────────────────────────
// ConversationStateMachine — orquesta lectura + validación de transición +
// escritura CAS. Es la pieza que hace que "una transición inválida se
// rechaza, nunca se aplica parcialmente" sea verdad de punta a punta, no solo
// a nivel de storage.
// ─────────────────────────────────────────────────────────────────────────────

import type { StateStore, StoredConversationState } from './types.ts';
import { isValidTransition, type TransitionTable } from './transitions.ts';

export type TransitionOutcome<TState extends string, TContext extends Record<string, unknown>> =
  | { applied: true; from: TState | null; to: TState | null; context: TContext; version: number }
  | { applied: false; reason: 'invalid_transition'; from: TState | null; to: TState | null }
  | { applied: false; reason: 'concurrent_modification_retries_exhausted'; from: TState | null; to: TState | null }
  | { applied: false; reason: 'store_write_failed'; from: TState | null; to: TState | null };

export interface ConversationStateMachineOptions {
  /** Reintentos ante CAS perdido (otro proceso escribió primero). Default 3. */
  maxRetries?: number;
}

export class ConversationStateMachine<TState extends string, TContext extends Record<string, unknown>> {
  private readonly maxRetries: number;

  constructor(
    private readonly store: StateStore<TState, TContext>,
    private readonly transitions: TransitionTable<TState>,
    opts: ConversationStateMachineOptions = {},
  ) {
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async getState(conversationId: string): Promise<StoredConversationState<TState, TContext>> {
    return this.store.read(conversationId);
  }

  /**
   * Intenta transicionar a `to`. `contextPatch` se mergea (shallow) sobre el
   * context actual — NUNCA sobre un context leído en una iteración de retry
   * anterior, siempre sobre el fresco de la última lectura.
   *
   * Garantía: si el método devuelve `applied: true`, la nueva pareja
   * (state, context) quedó escrita atómicamente y nada más pudo haberse
   * intercalado entre la lectura que validó la transición y la escritura
   * (el store lo garantiza por versión). Si devuelve `applied: false`, el
   * store NO fue modificado — no hay estado intermedio.
   */
  async transition(
    conversationId: string,
    to: TState | null,
    contextPatch: Partial<TContext> = {},
  ): Promise<TransitionOutcome<TState, TContext>> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const current = await this.store.read(conversationId);

      if (!isValidTransition(this.transitions, current.state, to)) {
        return { applied: false, reason: 'invalid_transition', from: current.state, to };
      }

      const nextContext = { ...current.context, ...contextPatch } as TContext;
      const ok = await this.store.writeIfVersion(conversationId, current.version, {
        state: to,
        context: nextContext,
      });

      if (ok) {
        return { applied: true, from: current.state, to, context: nextContext, version: current.version + 1 };
      }
      // CAS perdido: alguien más escribió entre nuestro read y write.
      // Reintentamos releyendo — puede que la transición YA NO sea válida
      // desde el nuevo estado (ej: otro mensaje ya cerró la reservación),
      // en cuyo caso el siguiente loop la rechaza correctamente en vez de
      // pisarla.
    }
    const current = await this.store.read(conversationId);
    return { applied: false, reason: 'concurrent_modification_retries_exhausted', from: current.state, to };
  }

  async clear(conversationId: string): Promise<TransitionOutcome<TState, TContext>> {
    return this.transition(conversationId, null);
  }
}
