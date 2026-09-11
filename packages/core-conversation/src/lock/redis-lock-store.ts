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
// ─────────────────────────────────────────────────────────────────────────────

import { Redis } from '@upstash/redis';
import type { AcquireLockOptions, AcquireLockResult, LockStore } from './types.ts';

const DEFAULT_TTL_SECONDS = 30; // safety release — pipeline normal tarda <10s
const DEFAULT_MAX_WAIT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface RedisLockStoreOptions {
  url?: string;
  token?: string;
  /** Prefijo de namespace para las keys de Redis. Default 'lock:conv:'. */
  keyPrefix?: string;
}

function randomToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class RedisLockStore implements LockStore {
  private client: Redis | null;
  private readonly keyPrefix: string;

  constructor(opts: RedisLockStoreOptions = {}) {
    const url = opts.url ?? process.env.UPSTASH_REDIS_URL;
    const token = opts.token ?? process.env.UPSTASH_REDIS_TOKEN;
    this.keyPrefix = opts.keyPrefix ?? 'lock:conv:';
    // fail-open en CI/dev sin Redis configurado — igual que el original.
    this.client = url && token ? new Redis({ url, token }) : null;
  }

  private k(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async acquire(key: string, opts: AcquireLockOptions = {}): Promise<AcquireLockResult> {
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const deadline = Date.now() + maxWaitMs;

    if (!this.client) {
      // fail-open: sin Redis (CI/dev) no hay serialización real a este nivel;
      // la restricción única de la capa de datos sigue protegiendo contra
      // doble-booking. Ver InMemoryLockStore para tests que SÍ necesitan
      // serialización real determinística.
      return { acquired: true, token: randomToken() };
    }

    while (true) {
      const token = randomToken();
      try {
        const result = await this.client.set(this.k(key), token, {
          nx: true,
          ex: ttlSeconds,
        });
        if (result === 'OK') return { acquired: true, token };
      } catch (err) {
        console.warn(
          '[core-conversation] redis error en acquire, procediendo sin lock:',
          err instanceof Error ? err.message : err,
        );
        return { acquired: true, token };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { acquired: false };
      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
    }
  }

  async release(key: string, token: string): Promise<void> {
    if (!this.client) return;
    try {
      // Lua atómico: solo borra si el token todavía coincide — evita el
      // race GET+DEL no atómico (borrar el lock de OTRO proceso que lo
      // re-adquirió entre nuestro GET y nuestro DEL).
      await this.client.eval(
        `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`,
        [this.k(key)],
        [token],
      );
    } catch {
      /* fail-open — el TTL libera el lock eventualmente */
    }
  }

  async extend(key: string, token: string, extendSeconds = DEFAULT_TTL_SECONDS): Promise<boolean> {
    if (!this.client) return true; // fail-open en dev/CI
    try {
      const result = await this.client.eval(
        `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("expire",KEYS[1],ARGV[2]) else return 0 end`,
        [this.k(key)],
        [token, String(extendSeconds)],
      );
      return result === 1;
    } catch {
      return true; // fail-open — no abortar un pipeline en marcha por Redis flaky.
    }
  }
}
