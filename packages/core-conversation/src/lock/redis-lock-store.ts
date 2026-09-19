// ─────────────────────────────────────────────────────────────────────────────
// RedisLockStore — adaptador de producción. Portado 1:1 (mismo algoritmo, SET
// NX EX + Lua check-and-delete/check-and-expire atómico) de:
//   ~/GitHub-repos-backup/atiende.ai/atiende-ai/src/lib/whatsapp/conversation-lock.ts
//
// Cambios vs. el original (generalización para core-conversation, mismo
// comportamiento):
//  - La clave lógica (antes `tenantId` + `phone` por separado) ahora es un
//    solo string `key` que el caller compone (ver `lockKey`) — el paquete no
//    asume que el cliente siempre se identifica por teléfono de WhatsApp;
//    otros canales (web chat, email) usan otras claves de cliente.
//  - `LOCK_TTL_SECONDS` es configurable por-llamada (`opts.ttlSeconds`) en vez
//    de constante de módulo — el resto de la lógica (fail-open, Lua atómico
//    para release/extend) es idéntica al original.
//
// Hallazgo de auditoría de credenciales (fix/conversation-lock-upstash) — DOS
// correcciones sobre la versión anterior de este archivo:
//
//  1. Nombre de variables: antes leía `UPSTASH_REDIS_URL`/`UPSTASH_REDIS_TOKEN`
//     (sin "_REST_"), un par DISTINTO del que usa `packages/core-ratelimit`
//     (`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`) para el MISMO
//     Redis de Upstash — nadie tenía ese segundo par configurado (verificado
//     contra docs/CREDENCIALES.md). Ahora lee el mismo par que core-ratelimit:
//     una sola credencial pegada una sola vez activa ambos.
//  2. Cliente REST por `fetch`, sin el SDK `@upstash/redis` — mismo patrón que
//     `packages/core-ratelimit/src/redis-backend.ts::attemptRedisIncrement`
//     (comando crudo como array JSON, `AbortSignal.timeout`, nunca lanza).
//     Se elige por consistencia (un solo patrón de cliente Upstash en todo el
//     monorepo, mockeable en tests con `vi.stubGlobal('fetch', ...)` sin
//     mockear una clase entera del SDK) y para no cargar una dependencia extra
//     por 3 comandos Redis. El algoritmo (SET NX EX, Lua de release/extend) no
//     cambia — solo el transporte.
// ─────────────────────────────────────────────────────────────────────────────

import type { AcquireLockOptions, AcquireLockResult, LockStore } from './types.ts';

const DEFAULT_TTL_SECONDS = 30; // safety release — pipeline normal tarda <10s
const DEFAULT_MAX_WAIT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
// Mismo criterio que core-ratelimit (rate-limiter.ts): la REST API de Upstash
// contesta en decenas de ms; 1.2s ya es "algo está mal".
const DEFAULT_TIMEOUT_MS = 1200;

// Lua atómico: solo borra/extiende si el token todavía coincide — evita el
// race GET+DEL (o GET+EXPIRE) no atómico entre dos procesos.
const RELEASE_SCRIPT = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
const EXTEND_SCRIPT = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("expire",KEYS[1],ARGV[2]) else return 0 end`;

export interface RedisLockStoreOptions {
  /** Default: `process.env.UPSTASH_REDIS_REST_URL` — MISMA variable que `@atiende/core-ratelimit`. */
  url?: string;
  /** Default: `process.env.UPSTASH_REDIS_REST_TOKEN` — MISMA variable que `@atiende/core-ratelimit`. */
  token?: string;
  /** Prefijo de namespace para las keys de Redis. Default 'lock:conv:'. */
  keyPrefix?: string;
  /** Timeout por intento contra Redis, en ms. Default 1200. */
  timeoutMs?: number;
}

function randomToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Un comando crudo contra la REST API de Upstash. `null` = no se pudo saber
 * (red caída, timeout, respuesta no-2xx, forma inesperada) — NUNCA LANZA, el
 * caller decide fail-open/fail-closed. Mismo contrato que
 * `attemptRedisIncrement` de core-ratelimit.
 */
async function upstashCommand(url: string, token: string, command: readonly unknown[], timeoutMs: number): Promise<{ result: unknown } | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (!res.ok) return null;
    return { result: json.result };
  } catch {
    // Timeout (AbortError) o red caída: "no se pudo saber".
    return null;
  }
}

export class RedisLockStore implements LockStore {
  private readonly url: string | undefined;
  private readonly token: string | undefined;
  private readonly keyPrefix: string;
  private readonly timeoutMs: number;

  constructor(opts: RedisLockStoreOptions = {}) {
    this.url = opts.url ?? process.env.UPSTASH_REDIS_REST_URL;
    this.token = opts.token ?? process.env.UPSTASH_REDIS_REST_TOKEN;
    this.keyPrefix = opts.keyPrefix ?? 'lock:conv:';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** true si hay credenciales para hablar con Redis de verdad (no solo fail-open). */
  isConfigured(): boolean {
    return Boolean(this.url && this.token);
  }

  private k(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async acquire(key: string, opts: AcquireLockOptions = {}): Promise<AcquireLockResult> {
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const deadline = Date.now() + maxWaitMs;

    if (!this.isConfigured()) {
      // fail-open: sin Redis (CI/dev, o producción sin credenciales todavía)
      // no hay serialización real a este nivel — el caller (createDefaultConversationGuard)
      // debe preferir InMemoryLockStore en este caso para seguir serializando
      // DENTRO de una instancia; ver InMemoryLockStore para tests que SÍ
      // necesitan serialización real determinística.
      return { acquired: true, token: randomToken() };
    }

    while (true) {
      const token = randomToken();
      const outcome = await upstashCommand(this.url!, this.token!, ['SET', this.k(key), token, 'NX', 'EX', ttlSeconds], this.timeoutMs);

      if (outcome === null) {
        console.warn('[core-conversation] redis error en acquire, procediendo sin lock');
        return { acquired: true, token };
      }
      if (outcome.result === 'OK') return { acquired: true, token };

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { acquired: false };
      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
    }
  }

  async release(key: string, token: string): Promise<void> {
    if (!this.isConfigured()) return;
    // fail-open — si esto falla, el TTL libera el lock eventualmente.
    await upstashCommand(this.url!, this.token!, ['EVAL', RELEASE_SCRIPT, 1, this.k(key), token], this.timeoutMs);
  }

  async extend(key: string, token: string, extendSeconds = DEFAULT_TTL_SECONDS): Promise<boolean> {
    if (!this.isConfigured()) return true; // fail-open en dev/CI
    const outcome = await upstashCommand(this.url!, this.token!, ['EVAL', EXTEND_SCRIPT, 1, this.k(key), token, String(extendSeconds)], this.timeoutMs);
    if (outcome === null) return true; // fail-open — no abortar un pipeline en marcha por Redis flaky.
    return outcome.result === 1;
  }
}
