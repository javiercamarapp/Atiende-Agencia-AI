// ─────────────────────────────────────────────────────────────────────────────
// Contrato del lock distribuido de conversación.
//
// Puerto/adaptador: el motor de acciones y el orquestador del agente dependen
// SOLO de esta interfaz. `InMemoryLockStore` (packages/core-conversation) sirve
// para tests y para dev/CI sin infra real. `RedisLockStore` es el adaptador de
// producción, portado 1:1 del patrón real de
// atiende.ai (`src/lib/whatsapp/conversation-lock.ts`).
// ─────────────────────────────────────────────────────────────────────────────

export interface AcquireLockOptions {
  /** Cuánto esperar (ms) si el lock está tomado antes de rendirse. Default 15000. */
  maxWaitMs?: number;
  /** Intervalo de poll (ms) mientras se espera. Default 500. */
  pollIntervalMs?: number;
  /** TTL (segundos) del lock — safety release si el proceso muere sin liberar. Default 30. */
  ttlSeconds?: number;
}

export interface AcquireLockResult {
  acquired: boolean;
  /** Token único de esta adquisición. Requerido para release/extend. Solo presente si acquired=true. */
  token?: string;
}

/**
 * Lock distribuido por clave lógica (normalmente `${tenantId}:${customerKey}`).
 * Garantiza que, para la MISMA clave, solo un proceso puede tener el lock
 * a la vez — es la pieza que serializa mensajes concurrentes del mismo
 * cliente sobre la misma conversación/reserva.
 */
export interface LockStore {
  /**
   * Intenta tomar el lock. Si está tomado, espera (poll) hasta `maxWaitMs`.
   * Debe ser fail-open ante errores del backend (nunca perder un mensaje por
   * un lock roto) — el caller SIEMPRE recibe `acquired: true` cuando el
   * backend no está disponible o falla, dejando la defensa de última línea
   * a la restricción única de la capa de datos.
   */
  acquire(key: string, opts?: AcquireLockOptions): Promise<AcquireLockResult>;

  /**
   * Libera el lock SOLO si `token` coincide con el dueño actual — evita que
   * un pipeline lento libere el lock de OTRO proceso que ya lo re-adquirió
   * tras expirar el TTL del primero.
   */
  release(key: string, token: string): Promise<void>;

  /**
   * Heartbeat: extiende el TTL si seguimos siendo dueños. Devuelve `false`
   * si el lock ya no nos pertenece (perdido por TTL) para que el caller
   * pueda abortar side effects largos en marcha.
   */
  extend(key: string, token: string, extendSeconds?: number): Promise<boolean>;
}

export function lockKey(tenantId: string, customerKey: string): string {
  return `${tenantId}:${customerKey}`;
}
