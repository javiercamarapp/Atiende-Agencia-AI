// ═══════════════════════════════════════════════════════════════════════════
// Circuit breaker por proveedor, respaldado en Redis.
//
// PUERTO de atiende.ai/src/lib/llm/circuit-breaker.ts (patrón de
// packages/llm/orchestrator.ts): mismo diseño de 3 estados (CLOSED/OPEN/
// HALF_OPEN vía TTL), mismo fail-open cuando el store no responde ("el
// breaker es defense-in-depth, no el único control"), mismo truco
// INCR+EXPIRE atómico para no dejar keys inmortales.
//
// DIFERENCIA con el original: aquí el gateway habla con VARIOS proveedores
// (OpenRouter, Anthropic directo, OpenAI directo…), así que el breaker es
// POR PROVEEDOR (`cb:<providerId>`) en vez de una sola instancia fija para
// OpenRouter. Un proveedor caído no debe abrir el breaker de los demás.
//
// El store es una interfaz mínima (`CircuitBreakerStore`) en vez de importar
// `@upstash/redis` directo: el adaptador de producción (`RedisCircuitBreakerStore`)
// envuelve cualquier cliente con esa forma (Upstash, ioredis, etc.) con el
// mismo truco Lua de INCR+EXPIRE atómico del original; los tests usan
// `InMemoryCircuitBreakerStore`, que implementa el mismo contrato sin
// infraestructura real — ningún test aquí depende de un Redis vivo.
// ═══════════════════════════════════════════════════════════════════════════

import { CircuitOpenError } from './errors.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

/** Fallas consecutivas antes de abrir el breaker de un proveedor. */
export const DEFAULT_FAILURE_THRESHOLD = 5;
/** Ventana para considerar fallas como consecutivas (segundos). */
export const DEFAULT_FAILURE_WINDOW_SECONDS = 60;
/** Duración del estado OPEN antes de dejar pasar una request de prueba (half-open). */
export const DEFAULT_OPEN_DURATION_SECONDS = 30;

/**
 * Contrato mínimo que necesita el breaker. `incrWithExpiry` es el equivalente
 * empaquetado del script Lua `INCR + EXPIRE si es la primera` del original —
 * atómico en el adaptador Redis real, trivial en el fake de memoria.
 */
export interface CircuitBreakerStore {
  get(key: string): Promise<string | null>;
  /** Pone la key en 'open' con expiración en `ttlSeconds`. */
  setOpen(key: string, ttlSeconds: number): Promise<void>;
  /** Segundos restantes de vida de la key, o 0 si no existe/ya expiró. */
  ttlSeconds(key: string): Promise<number>;
  /** Incrementa el contador; si es la primera vez, arma su expiración. Atómico. */
  incrWithExpiry(key: string, windowSeconds: number): Promise<number>;
  /** Lee el contador SIN incrementarlo (solo para `getBreakerState`, dashboard/tests). */
  peekCounter(key: string): Promise<number>;
  del(key: string): Promise<void>;
}

/**
 * Adaptador de producción sobre cualquier cliente con forma de Redis
 * (Upstash, ioredis…). No importa el paquete del cliente aquí a propósito
 * —evita atar `agent-core` a una librería concreta antes de que la Fase 0
 * decida cuál—: quien lo instancie pasa el cliente ya conectado.
 *
 * El tipo estructural es intencionalmente mínimo (duck typing): cualquier
 * cliente que exponga `get`, `set` con `{ EX }`, `ttl`, `eval` y `del` sirve.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  ttl(key: string): Promise<number>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class RedisCircuitBreakerStore implements CircuitBreakerStore {
  constructor(private readonly client: RedisClientLike) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setOpen(key: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, 'open', { EX: ttlSeconds });
  }

  async ttlSeconds(key: string): Promise<number> {
    const ttl = await this.client.ttl(key);
    return ttl > 0 ? ttl : 0;
  }

  async incrWithExpiry(key: string, windowSeconds: number): Promise<number> {
    // Mismo script que atiende.ai circuit-breaker.ts: INCR, y solo si es la
    // PRIMERA vez (v === 1) se arma el EXPIRE — evita la ventana de carrera
    // donde un segundo request llega entre INCR y EXPIRE y deja la key
    // inmortal si el EXPIRE del primero falla.
    const result = await this.client.eval(
      "local v = redis.call('INCR', KEYS[1]); if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return v",
      [key],
      [String(windowSeconds)],
    );
    return Number(result);
  }

  async peekCounter(key: string): Promise<number> {
    const raw = await this.client.get(key);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

/**
 * Store de memoria para tests y desarrollo local sin infraestructura. Mismo
 * contrato exacto que el adaptador Redis, así que el `CircuitBreaker` que lo
 * consume no sabe (ni le importa) cuál de los dos está detrás.
 */
export class InMemoryCircuitBreakerStore implements CircuitBreakerStore {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  private now(): number {
    return Date.now();
  }

  private expire<K, V extends { expiresAt: number }>(map: Map<K, V>, key: K): void {
    const entry = map.get(key);
    if (entry && entry.expiresAt <= this.now()) map.delete(key);
  }

  async get(key: string): Promise<string | null> {
    this.expire(this.values, key);
    return this.values.get(key)?.value ?? null;
  }

  async setOpen(key: string, ttlSeconds: number): Promise<void> {
    this.values.set(key, { value: 'open', expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async ttlSeconds(key: string): Promise<number> {
    this.expire(this.values, key);
    const entry = this.values.get(key);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.expiresAt - this.now()) / 1000));
  }

  async incrWithExpiry(key: string, windowSeconds: number): Promise<number> {
    this.expire(this.counters, key);
    const existing = this.counters.get(key);
    if (existing) {
      existing.count += 1;
      return existing.count;
    }
    this.counters.set(key, { count: 1, expiresAt: this.now() + windowSeconds * 1000 });
    return 1;
  }

  async peekCounter(key: string): Promise<number> {
    this.expire(this.counters, key);
    return this.counters.get(key)?.count ?? 0;
  }

  async del(key: string): Promise<void> {
    this.counters.delete(key);
  }

  /** Solo para tests: limpia todo el estado. */
  reset(): void {
    this.values.clear();
    this.counters.clear();
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  failureWindowSeconds?: number;
  openDurationSeconds?: number;
}

/**
 * Breaker por proveedor. `store` es `undefined` cuando no hay Redis
 * configurado — igual que atiende.ai, el breaker entonces es FAIL-OPEN (deja
 * pasar todo): es defensa en profundidad, no el único control de fallas.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly failureWindowSeconds: number;
  private readonly openDurationSeconds: number;

  constructor(
    private readonly store: CircuitBreakerStore | undefined,
    opts: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.failureWindowSeconds = opts.failureWindowSeconds ?? DEFAULT_FAILURE_WINDOW_SECONDS;
    this.openDurationSeconds = opts.openDurationSeconds ?? DEFAULT_OPEN_DURATION_SECONDS;
  }

  private breakerKey(providerId: string): string {
    return `cb:${providerId}`;
  }
  private failureKey(providerId: string): string {
    return `cb:${providerId}:failures`;
  }

  /** Lanza `CircuitOpenError` si el breaker de este proveedor está OPEN. */
  async checkCircuit(providerId: string): Promise<void> {
    if (!this.store) return; // fail-open sin store
    try {
      const state = await this.store.get(this.breakerKey(providerId));
      if (state === 'open') {
        const ttl = await this.store.ttlSeconds(this.breakerKey(providerId));
        throw new CircuitOpenError(providerId, ttl > 0 ? ttl : this.openDurationSeconds);
      }
    } catch (err) {
      if (err instanceof CircuitOpenError) throw err;
      // El store falló (no el breaker en sí) → fail-open, igual que el original.
    }
  }

  async reportFailure(providerId: string, reason: string): Promise<void> {
    if (!this.store) return;
    try {
      const count = await this.store.incrWithExpiry(this.failureKey(providerId), this.failureWindowSeconds);
      if (count >= this.failureThreshold) {
        await this.store.setOpen(this.breakerKey(providerId), this.openDurationSeconds);
        await this.store.del(this.failureKey(providerId));
        void reason; // el llamador puede loguearlo; el breaker no impone logger.
      }
    } catch {
      /* store no disponible: no-op, ya se dejó pasar en checkCircuit */
    }
  }

  async reportSuccess(providerId: string): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.del(this.failureKey(providerId));
    } catch {
      /* no-op */
    }
  }

  async getBreakerState(providerId: string): Promise<BreakerState> {
    if (!this.store) return 'closed';
    try {
      const state = await this.store.get(this.breakerKey(providerId));
      if (state === 'open') return 'open';
      const failures = await this.store.peekCounter(this.failureKey(providerId));
      return failures > 0 ? 'half_open' : 'closed';
    } catch {
      return 'closed';
    }
  }
}
