// ─────────────────────────────────────────────────────────────────────────────
// Contrato del store de estado de conversación. La escritura es SIEMPRE
// compare-and-swap (CAS) por `version`: el caller lee `version`, y solo puede
// escribir si nadie más escribió desde entonces. Si otro proceso escribió
// primero, `writeIfVersion` devuelve `false` y NO aplica nada — nunca hay
// escritura parcial ni "el último que llega gana" silencioso.
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredConversationState<TState extends string, TContext extends Record<string, unknown>> {
  state: TState | null;
  context: TContext;
  /** Contador monotónico — la base del compare-and-swap. Arranca en 0. */
  version: number;
}

export interface StateStore<TState extends string, TContext extends Record<string, unknown>> {
  read(conversationId: string): Promise<StoredConversationState<TState, TContext>>;

  /**
   * Escribe `next` SOLO si la versión actual en el store sigue siendo
   * `expectedVersion`. Devuelve `true` y deja `version = expectedVersion + 1`
   * si escribió; `false` sin tocar nada si alguien más escribió primero
   * (el caller debe releer y decidir: reintentar validando la transición de
   * nuevo, o abortar).
   */
  writeIfVersion(
    conversationId: string,
    expectedVersion: number,
    next: { state: TState | null; context: TContext },
  ): Promise<boolean>;
}
