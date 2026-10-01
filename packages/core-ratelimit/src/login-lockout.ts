// ─────────────────────────────────────────────────────────────────────────────
// LoginLockout — bloqueo temporal por intentos de login FALLIDOS, con backoff
// exponencial, por llave (el caller arma "email normalizado + IP").
//
// Por qué existe, si ya hay `rateLimit()` en POST /auth/login: el rate limit
// cuenta CUALQUIER intento (acertado o no) en una ventana fija de 5 min y se
// reinicia solo; no distingue un usuario legítimo que tecleó mal una vez de
// quien prueba contraseñas, ni escala el castigo con la insistencia. Este
// módulo cuenta solo FALLOS, bloquea al llegar a `threshold` y alarga cada
// bloqueo sucesivo (base × 2^(fallos - umbral), con tope), de modo que probar
// contraseñas de forma sostenida se vuelve inviable aunque se respete el
// rate limit. Un login correcto borra el contador (`recordSuccess`).
//
// Reglas de diseño:
//  - El caller registra fallos de cuentas inexistentes IGUAL que de cuentas
//    reales: el bloqueo depende solo de la llave, nunca de si la cuenta existe
//    (no hay forma de distinguirlas por el bloqueo).
//  - Un intento hecho MIENTRAS la llave está bloqueada NO suma fallos (si no,
//    quien espera con un script mantendría el bloqueo escalando para siempre
//    y se podría usar para dejar fuera a la víctima de forma indefinida: el
//    bloqueo máximo es `maxLockMs`).
//  - La llave se hashea (SHA-256) antes de tocar Redis o el Map: ni el correo
//    ni la IP quedan en claro como llave.
//  - Con Redis configurado, el estado es global (script Lua atómico). Si una
//    llamada a Redis falla, se degrada al contador en memoria de ESTA
//    instancia (nunca "sin bloqueo"): el rate limit de `auth:login` (fail-
//    closed) sigue siendo la barrera global mientras dure la avería.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';

export interface LoginLockoutOptions {
  /** Default: `process.env.UPSTASH_REDIS_REST_URL`. */
  redisUrl?: string;
  /** Default: `process.env.UPSTASH_REDIS_REST_TOKEN`. */
  redisToken?: string;
  /** Prefijo de llaves en Redis. Default `'lockout:'`. */
  keyPrefix?: string;
  /** Timeout por llamada a Redis (ms). Default 1200. */
  timeoutMs?: number;
  /** Fallos consecutivos que disparan el primer bloqueo. Default 5. */
  threshold?: number;
  /** Duración del primer bloqueo (ms). Default 30 s. */
  baseLockMs?: number;
  /** Tope de un bloqueo (ms). Default 15 min. */
  maxLockMs?: number;
  /** Cuánto tiempo sin fallos hace falta para olvidar el conteo (ms). Default 30 min. */
  failureWindowMs?: number;
  /** Observabilidad opcional; nunca recibe la llave. */
  onEvent?: (event: { type: 'redis_failure'; op: 'status' | 'failure' | 'success' }) => void;
}

export interface LockoutStatus {
  locked: boolean;
  /** Milisegundos hasta que el bloqueo termina (0 si no está bloqueada). */
  retryAfterMs: number;
  /** true si Redis estaba configurado pero esta llamada cayó al respaldo en memoria. */
  degraded: boolean;
}

export interface LockoutFailureResult extends LockoutStatus {
  /** Fallos acumulados tras este (en el backend que decidió). */
  failures: number;
}

/** Duración del bloqueo tras `failures` fallos consecutivos (0 si aún no llega al umbral). */
export function lockDurationMs(failures: number, threshold: number, baseLockMs: number, maxLockMs: number): number {
  if (failures < threshold) return 0;
  const exponent = Math.min(failures - threshold, 20);
  return Math.min(Math.floor(baseLockMs * 2 ** exponent), maxLockMs);
}

// Atómico: cuenta el fallo, refresca la ventana de olvido y, si ya llegó al umbral,
// fija la llave de bloqueo con su TTL de backoff. Devuelve {fallos, bloqueoMs}.
export const SCRIPT_RECORD_FAILURE = `
local n = redis.call("INCR", KEYS[1])
redis.call("PEXPIRE", KEYS[1], ARGV[1])
local thr = tonumber(ARGV[2])
local lock = 0
if n >= thr then
  lock = tonumber(ARGV[3]) * (2 ^ math.min(n - thr, 20))
  if lock > tonumber(ARGV[4]) then lock = tonumber(ARGV[4]) end
  lock = math.floor(lock)
  redis.call("SET", KEYS[2], "1", "PX", lock)
end
return {n, lock}
`;

interface MemEntry {
  failures: number;
  forgetAt: number;
  lockedUntil: number;
}

const MAX_KEYS = 5000;

export class LoginLockout {
  private readonly mem = new Map<string, MemEntry>();
  private readonly redisUrl: string | undefined;
  private readonly redisToken: string | undefined;
  private readonly keyPrefix: string;
  private readonly timeoutMs: number;
  private readonly threshold: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly failureWindowMs: number;
  private readonly onEvent: LoginLockoutOptions['onEvent'];

  constructor(opts: LoginLockoutOptions = {}) {
    this.redisUrl = opts.redisUrl ?? process.env.UPSTASH_REDIS_REST_URL;
    this.redisToken = opts.redisToken ?? process.env.UPSTASH_REDIS_REST_TOKEN;
    this.keyPrefix = opts.keyPrefix ?? 'lockout:';
    this.timeoutMs = opts.timeoutMs ?? 1200;
    this.threshold = opts.threshold ?? 5;
    this.baseLockMs = opts.baseLockMs ?? 30_000;
    this.maxLockMs = opts.maxLockMs ?? 15 * 60_000;
    this.failureWindowMs = opts.failureWindowMs ?? 30 * 60_000;
    this.onEvent = opts.onEvent;
  }

  isRedisConfigured(): boolean {
    return Boolean(this.redisUrl && this.redisToken);
  }

  private hashed(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
  }

  private async redis(command: unknown[]): Promise<unknown | null> {
    try {
      const res = await fetch(this.redisUrl!, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const json = (await res.json()) as { result?: unknown };
      if (!res.ok || json.result === undefined) return null;
      return json.result;
    } catch {
      return null;
    }
  }

  /** ¿Está bloqueada la llave ahora? No suma nada. */
  async status(key: string): Promise<LockoutStatus> {
    const h = this.hashed(key);
    let degraded = false;
    if (this.isRedisConfigured()) {
      const ttl = await this.redis(['PTTL', `${this.keyPrefix}lock:${h}`]);
      if (typeof ttl === 'number') {
        return ttl > 0 ? { locked: true, retryAfterMs: ttl, degraded: false } : { locked: false, retryAfterMs: 0, degraded: false };
      }
      this.onEvent?.({ type: 'redis_failure', op: 'status' });
      degraded = true;
    }
    const e = this.mem.get(h);
    const now = Date.now();
    if (e && e.lockedUntil > now) return { locked: true, retryAfterMs: e.lockedUntil - now, degraded };
    return { locked: false, retryAfterMs: 0, degraded };
  }

  /** Registra un login fallido. Devuelve si, con este fallo, la llave queda bloqueada. */
  async recordFailure(key: string): Promise<LockoutFailureResult> {
    const h = this.hashed(key);
    let degraded = false;
    if (this.isRedisConfigured()) {
      const r = await this.redis([
        'EVAL',
        SCRIPT_RECORD_FAILURE,
        2,
        `${this.keyPrefix}fail:${h}`,
        `${this.keyPrefix}lock:${h}`,
        this.failureWindowMs,
        this.threshold,
        this.baseLockMs,
        this.maxLockMs,
      ]);
      if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number') {
        return { failures: r[0], locked: r[1] > 0, retryAfterMs: r[1], degraded: false };
      }
      this.onEvent?.({ type: 'redis_failure', op: 'failure' });
      degraded = true;
    }
    const now = Date.now();
    const prev = this.mem.get(h);
    const base = prev && prev.forgetAt > now ? prev : { failures: 0, forgetAt: 0, lockedUntil: 0 };
    const failures = base.failures + 1;
    const lock = lockDurationMs(failures, this.threshold, this.baseLockMs, this.maxLockMs);
    this.mem.set(h, {
      failures,
      forgetAt: now + this.failureWindowMs,
      lockedUntil: lock > 0 ? now + lock : base.lockedUntil,
    });
    if (this.mem.size > MAX_KEYS) this.prune(now);
    return { failures, locked: lock > 0, retryAfterMs: lock, degraded };
  }

  /** Login correcto: olvida los fallos y levanta cualquier bloqueo de esa llave. */
  async recordSuccess(key: string): Promise<void> {
    const h = this.hashed(key);
    this.mem.delete(h);
    if (this.isRedisConfigured()) {
      const r = await this.redis(['DEL', `${this.keyPrefix}fail:${h}`, `${this.keyPrefix}lock:${h}`]);
      if (r === null) this.onEvent?.({ type: 'redis_failure', op: 'success' });
    }
  }

  private prune(now: number): void {
    for (const [k, e] of this.mem) {
      if (e.forgetAt <= now && e.lockedUntil <= now) this.mem.delete(k);
    }
    if (this.mem.size <= MAX_KEYS) return;
    // Backstop: descarta primero las que expiran antes (nunca una bloqueada vigente mientras haya otras).
    const byExpiry = [...this.mem.entries()].sort((a, b) => Math.max(a[1].forgetAt, a[1].lockedUntil) - Math.max(b[1].forgetAt, b[1].lockedUntil));
    const excess = this.mem.size - Math.floor(MAX_KEYS * 0.75);
    for (let i = 0; i < excess; i++) {
      const entry = byExpiry[i];
      if (entry) this.mem.delete(entry[0]);
    }
  }

  /** Solo para pruebas. */
  resetForTests(): void {
    this.mem.clear();
  }
}

let defaultLockout: LoginLockout | undefined;

/** Instancia por-proceso con las credenciales de `process.env` (mismo patrón que `rateLimit()`). */
export function getDefaultLoginLockout(): LoginLockout {
  defaultLockout ??= new LoginLockout();
  return defaultLockout;
}

/** Solo para pruebas: descarta la instancia por-proceso. */
export function resetDefaultLoginLockoutForTests(): void {
  defaultLockout = undefined;
}
