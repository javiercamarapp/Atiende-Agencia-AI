// ─────────────────────────────────────────────────────────────────────────────
// PostgresStateStore — adaptador de producción. Extiende el patrón real de
// atiende.ai (`supabase/migrations/set_conversation_state_rpc.sql`,
// `src/lib/actions/state-machine.ts`): metadata JSONB con `jsonb_set` vía RPC
// para evitar el race read-modify-write en código de aplicación.
//
// Diferencia deliberada vs. el original: el RPC de atiende.ai escribe
// incondicionalmente (confía en que el caller ya serializó con el lock de
// conversación). Aquí agregamos compare-and-swap explícito por `version`
// dentro del propio RPC (ver migrations/001_conversation_state_cas.sql) —
// defensa en profundidad: incluso si dos procesos llegaran a escribir sin
// pasar por el lock (bug futuro, deploy parcial, worker sin el guard), el
// segundo WRITE pierde limpiamente en vez de pisar al primero.
//
// No depende de `@supabase/supabase-js` directamente — recibe un `PgRpcClient`
// mínimo (una función `rpc(name, args)`) para no atar core-conversation a un
// cliente concreto antes de que la Fase de infra real decida el proyecto
// Supabase consolidado (ver wiki: decisión 2026-09-11, "un solo proyecto
// Supabase consolidado"). El adaptador real de Supabase se conecta pasando
// `supabaseAdmin.rpc.bind(supabaseAdmin)`.
// ─────────────────────────────────────────────────────────────────────────────

import type { StateStore, StoredConversationState } from './types.ts';

export interface PgRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export interface PostgresStateStoreOptions {
  /** Nombre de la tabla que tiene la columna `metadata` JSONB. Default 'conversations'. */
  table?: string;
  onError?: (op: 'read' | 'write', err: { message: string; code?: string }, meta: Record<string, unknown>) => void;
}

interface RawStateColumn {
  state: string | null;
  context: Record<string, unknown>;
  version: number;
}

export class PostgresStateStore<TState extends string, TContext extends Record<string, unknown>>
  implements StateStore<TState, TContext>
{
  constructor(
    private readonly client: PgRpcClient,
    private readonly opts: PostgresStateStoreOptions = {},
  ) {}

  async read(conversationId: string): Promise<StoredConversationState<TState, TContext>> {
    const { data, error } = await this.client.rpc('get_conversation_state', {
      p_conversation_id: conversationId,
      p_table: this.opts.table ?? 'conversations',
    });
    if (error) {
      this.opts.onError?.('read', error, { conversationId });
      return { state: null, context: {} as TContext, version: 0 };
    }
    const row = data as RawStateColumn | null;
    if (!row) return { state: null, context: {} as TContext, version: 0 };
    return {
      state: (row.state ?? null) as TState | null,
      context: (row.context ?? {}) as TContext,
      version: row.version ?? 0,
    };
  }

  async writeIfVersion(
    conversationId: string,
    expectedVersion: number,
    next: { state: TState | null; context: TContext },
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('set_conversation_state_cas', {
      p_conversation_id: conversationId,
      p_expected_version: expectedVersion,
      p_state: next.state,
      p_context: next.context,
      p_table: this.opts.table ?? 'conversations',
    });
    if (error) {
      // Fail-closed a propósito (a diferencia del lock): un error de RPC en
      // la escritura de estado NO debe reportarse como "aplicado". El
      // caller reintenta o el mensaje se procesa sin memoria de estado
      // (degradado pero seguro) en vez de mentir sobre si el CAS ganó.
      this.opts.onError?.('write', error, { conversationId, expectedVersion, next });
      return false;
    }
    return data === true;
  }
}
