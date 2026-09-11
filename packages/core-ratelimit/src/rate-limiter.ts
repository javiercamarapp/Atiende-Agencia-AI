// ─────────────────────────────────────────────────────────────────────────────
// DistributedRateLimiter — orquesta el backend Redis (distribuido, atómico
// vía Lua — ver redis-backend.ts) con el backend en memoria (local, sliding
// window — ver memory-window.ts), y decide fail-open/fail-closed cuando Redis
// está configurado pero un intento falla a media petición.
//
// Reproduce la decisión de `rateLimit()` en
// ~/likida.ai/src/lib/ratelimit.ts (líneas 283-299 al portar): con Redis
// configurado y sano, el conteo es del servidor (atómico entre instancias);
// sin credenciales, cae al Map local; con credenciales pero el intento
// fallando, decide fail-open/closed según opciones. La diferencia real con
// el original es DE DÓNDE sale esa decisión: Likida la lee de una sola env
// var global (`RATELIMIT_REDIS_FALLA_CERRADO`) más una opción por-llamada.
// Este paquete generaliza eso a una TABLA por categoría de endpoint
// (`endpoint-policy.ts`) — necesario porque este monorepo sirve varios
// dominios (hoteles, restaurantes, citas, licitaciones, rentas) con
// endpoints de riesgo muy distinto, no los ~4 endpoints públicos de un solo
// producto. `opts.failClosed` explícito sigue disponible y sigue ganando —
// mismo criterio de "por llamada gana sobre el default" que el original.
// ─────────────────────────────────────────────────────────────────────────────

import { InMemoryWindowStore } from './memory-window.ts';
import { attemptRedisIncrement } from './redis-backend.ts';
import { resolvePolicy } from './endpoint-policy.ts';

export interface RateLimiterOptions {
  /** Default: `process.env.UPSTASH_REDIS_REST_URL`. */
  redisUrl?: string;
  /** Default: `process.env.UPSTASH_REDIS_REST_TOKEN`. */
  redisToken?: string;
  /** Prefijo de namespace para las llaves en Redis. Default `'ratelimit:'`. */
  keyPrefix?: string;
  /** Timeout del intento contra Redis, en ms. Default 1200 — la REST API de
   *  Upstash contesta en decenas de ms; 1.2s ya es "algo está mal". */
  timeoutMs?: number;
  /** Observabilidad opcional: nunca recibe la llave completa (puede llevar
   *  IP o id de cliente), solo la categoría — mismo cuidado que `categoria()`
   *  en el original ante la filtración SEG-4/reincidente-22 de Likida. */
  onEvent?: (event: RateLimitEvent) => void;
}

export interface RateLimitCallOptions {
  /** Categoría del endpoint — resuelve la política fail-open/closed de
   *  `endpoint-policy.ts` cuando `failClosed` no se indica explícitamente.
   *  Sin categoría, el default es CERRADO (ver `resolvePolicy`). */
  category?: string;
  /** Fuerza el comportamiento ante avería de Redis para ESTA llamada, sin
   *  importar la categoría ni la tabla de políticas. `true` niega; `false`
   *  degrada al backend en memoria. */
  failClosed?: boolean;
}

export interface RateLimitOutcome {
  allowed: boolean;
  backend: 'redis' | 'memory';
  /** true si Redis estaba configurado pero ESTA llamada no pudo usarlo
   *  (degradó a memoria, o negó por fail-closed). */
  degraded: boolean;
}

export type RateLimitEvent =
  | { type: 'redis_ok'; category?: string }
  | { type: 'redis_failure'; category?: string; failClosed: boolean };

export class DistributedRateLimiter {
  private readonly memory = new InMemoryWindowStore();
  private readonly redisUrl: string | undefined;
  private readonly redisToken: string | undefined;
  private readonly keyPrefix: string;
  private readonly timeoutMs: number;
  private readonly onEvent: ((event: RateLimitEvent) => void) | undefined;

  constructor(opts: RateLimiterOptions = {}) {
    this.redisUrl = opts.redisUrl ?? process.env.UPSTASH_REDIS_REST_URL;
    this.redisToken = opts.redisToken ?? process.env.UPSTASH_REDIS_REST_TOKEN;
    this.keyPrefix = opts.keyPrefix ?? 'ratelimit:';
    this.timeoutMs = opts.timeoutMs ?? 1200;
    this.onEvent = opts.onEvent;
  }

  isRedisConfigured(): boolean {
    return Boolean(this.redisUrl && this.redisToken);
  }

  /**
   * Devuelve si la petición se PERMITE, y con qué backend se decidió.
   *
   * Con Redis configurado y sano, el conteo es GLOBAL (mismo resultado sin
   * importar cuántas instancias atiendan la ráfaga). Sin credenciales, cae
   * directo al backend en memoria. Con credenciales pero el intento
   * fallando, decide fail-open/closed: `opts.failClosed` explícito gana; si
   * no se indica, gana la política de `opts.category` (`endpoint-policy.ts`);
   * sin categoría, CERRADO.
   */
  async check(key: string, limit: number, windowMs: number, opts: RateLimitCallOptions = {}): Promise<RateLimitOutcome> {
    if (this.isRedisConfigured()) {
      const count = await attemptRedisIncrement({
        url: this.redisUrl!,
        token: this.redisToken!,
        key: `${this.keyPrefix}${key}`,
        windowMs,
        timeoutMs: this.timeoutMs,
      });

      if (count !== null) {
        this.onEvent?.({ type: 'redis_ok', category: opts.category });
        return { allowed: count <= limit, backend: 'redis', degraded: false };
      }

      const failClosed = opts.failClosed ?? resolvePolicy(opts.category).failClosed;
      this.onEvent?.({ type: 'redis_failure', category: opts.category, failClosed });

      if (failClosed) {
        return { allowed: false, backend: 'redis', degraded: true };
      }
      return { allowed: this.memory.check(key, limit, windowMs), backend: 'memory', degraded: true };
    }

    return { allowed: this.memory.check(key, limit, windowMs), backend: 'memory', degraded: false };
  }

  /** Solo para pruebas: limpia el backend en memoria de esta instancia. */
  resetForTests(): void {
    this.memory.reset();
  }
}

let defaultLimiter: DistributedRateLimiter | undefined;

function getDefaultLimiter(): DistributedRateLimiter {
  defaultLimiter ??= new DistributedRateLimiter();
  return defaultLimiter;
}

/**
 * API simple para cualquier endpoint del monorepo: true si la petición se
 * PERMITE. Usa un limitador por-proceso construido con las credenciales de
 * `process.env.UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`.
 *
 * Para inyectar credenciales explícitas, un `keyPrefix` propio, o para
 * pruebas que necesitan aislamiento entre casos, usa `DistributedRateLimiter`
 * directamente en vez de esta función.
 *
 * @example
 *   import { rateLimit } from '@atiende/core-ratelimit';
 *   const ok = await rateLimit(`login:${ip}`, 10, 5 * 60_000, { category: 'auth:login' });
 *   if (!ok) return respond(429);
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  opts?: RateLimitCallOptions,
): Promise<boolean> {
  const outcome = await getDefaultLimiter().check(key, limit, windowMs, opts);
  return outcome.allowed;
}

/** Solo para pruebas: descarta el limitador por-proceso usado por `rateLimit()`. */
export function resetDefaultRateLimiterForTests(): void {
  defaultLimiter = undefined;
}
