// ─────────────────────────────────────────────────────────────────────────────
// InMemoryStateStore — implementación real de `StateStore` con CAS genuino
// (no un mock): usa un Map + comparación de versión. Sirve para tests
// determinísticos de la máquina de estados y como fallback dev/CI sin
// Postgres real.
// ─────────────────────────────────────────────────────────────────────────────

import type { StateStore, StoredConversationState } from './types.ts';

export class InMemoryStateStore<TState extends string, TContext extends Record<string, unknown>>
  implements StateStore<TState, TContext>
{
  private readonly rows = new Map<string, StoredConversationState<TState, TContext>>();

  /** Retraso artificial (ms) antes de aplicar la escritura — para simular
   * latencia real de red/DB en tests de concurrencia (sin esto, el event
   * loop de Node podría nunca intercalar dos "transacciones" en el mismo
   * tick y el test de carrera no probaría nada real). */
  constructor(private readonly simulatedLatencyMs = 0) {}

  async read(conversationId: string): Promise<StoredConversationState<TState, TContext>> {
    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }
    const existing = this.rows.get(conversationId);
    if (existing) return { ...existing, context: { ...existing.context } };
    return { state: null, context: {} as TContext, version: 0 };
  }

  async writeIfVersion(
    conversationId: string,
    expectedVersion: number,
    next: { state: TState | null; context: TContext },
  ): Promise<boolean> {
    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }
    const current = this.rows.get(conversationId) ?? { state: null, context: {} as TContext, version: 0 };
    if (current.version !== expectedVersion) return false; // CAS falló — alguien más escribió primero
    this.rows.set(conversationId, {
      state: next.state,
      context: next.context,
      version: expectedVersion + 1,
    });
    return true;
  }
}
