// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMITER — token bucket por llave, adaptado del MISMO algoritmo real de
// hoteles/packages/mcp-servers/shared/src/rate-limiter.ts (`TokenBucketRateLimiter`:
// capacidad + reposición por segundo, reloj inyectable para tests deterministas),
// generalizado aquí para llevar MÚLTIPLES buckets independientes por llave (un
// bucket por actor+ruta) en vez de un bucket único por instancia — necesario
// porque `requireAdminAccess` (admin-middleware.ts) limita intentos DENEGADOS
// por actor, no un límite global de proceso como en el adaptador de PMS/canal.
//
// No usa Redis (a diferencia de atiende-ai/src/lib/rate-limit.ts): ese archivo
// resuelve rate-limit de MENSAJES/tenant a través de despliegues múltiples y sí
// necesita estado compartido entre procesos. El límite de intentos denegados a
// /admin es defensa en profundidad de UN proceso de API — igual que el resto de
// packages/core-authz, queda como interfaz inyectable (`RateLimiter`) para que
// apps/api conecte una implementación con Redis/Postgres si el despliegue real
// termina siendo multi-proceso, sin que este paquete dependa de esa decisión.
// ═══════════════════════════════════════════════════════════════════════════

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Milisegundos hasta que vuelva a haber al menos 1 token, 0 si `allowed`. */
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  /** Intenta consumir `cost` tokens (default 1) de la llave `key`. No espera:
   * informa de inmediato si se puede o cuánto habría que esperar. */
  consume(key: string, cost?: number): RateLimitResult;
}

export interface TokenBucketRateLimiterOptions {
  /** Capacidad máxima de tokens por llave (ráfaga permitida antes de bloquear). */
  readonly capacity: number;
  /** Tokens que se reponen por segundo, por llave. */
  readonly refillPerSecond: number;
  /** Reloj inyectable para pruebas deterministas. Default `Date.now`. */
  readonly now?: () => number;
  /** Techo de buckets simultáneos en memoria — evita que un atacante con
   * actorKeys sin fin (ej. IPs falsificadas) haga crecer el Map sin límite.
   * Al llegar al techo, la llave MENOS usada recientemente se descarta antes
   * de crear una nueva (LRU simple). Default 10_000. */
  readonly maxKeys?: number;
}

interface Bucket {
  tokens: number;
  lastRefillAt: number;
  lastUsedAt: number;
}

/**
 * Un `TokenBucketRateLimiter` independiente por llave (`Map<string, Bucket>`).
 * Mismo algoritmo exacto de refill que `TokenBucketRateLimiter` en
 * mcp-servers/shared/src/rate-limiter.ts — ver ese archivo para el derivado
 * de un solo bucket.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: TokenBucketRateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  private bucketFor(key: string): Bucket {
    const existing = this.buckets.get(key);
    if (existing) return existing;

    if (this.buckets.size >= this.maxKeys) {
      this.evictLeastRecentlyUsed();
    }
    const fresh: Bucket = { tokens: this.capacity, lastRefillAt: this.now(), lastUsedAt: this.now() };
    this.buckets.set(key, fresh);
    return fresh;
  }

  private evictLeastRecentlyUsed(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastUsedAt < oldestAt) {
        oldestAt = bucket.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }

  private refill(bucket: Bucket): void {
    const nowMs = this.now();
    const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.lastRefillAt = nowMs;
  }

  consume(key: string, cost = 1): RateLimitResult {
    const bucket = this.bucketFor(key);
    this.refill(bucket);
    bucket.lastUsedAt = this.now();

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, retryAfterMs: 0 };
    }
    const missing = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((missing / this.refillPerSecond) * 1000);
    return { allowed: false, retryAfterMs };
  }

  /** Tokens disponibles ahora mismo para `key` — solo diagnóstico/pruebas. */
  available(key: string): number {
    const bucket = this.bucketFor(key);
    this.refill(bucket);
    return bucket.tokens;
  }
}
