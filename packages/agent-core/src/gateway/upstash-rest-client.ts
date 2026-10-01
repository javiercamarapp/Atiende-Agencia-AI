// Cliente minimo de la REST API de Upstash Redis con la forma `RedisClientLike`, para que el
// circuit breaker del gateway se COMPARTA entre instancias (hallazgo G7: con el store en memoria
// cada instancia de Vercel descubre por su cuenta que un modelo esta caido). Sin SDK: comando crudo
// como array JSON por `fetch`, mismo patron que core-ratelimit (`attemptRedisIncrement`) y
// core-conversation (`RedisLockStore`), y las MISMAS variables UPSTASH_REDIS_REST_URL/_TOKEN.
//
// A diferencia de esos dos, aqui los errores SI se lanzan: `CircuitBreaker` ya captura cualquier
// fallo del store y degrada a fail-open (el breaker es defensa en profundidad, no un control unico),
// asi que lanzar es lo correcto y el comportamiento sin Redis es identico al breaker en memoria
// ausente. Timeout corto: el breaker se consulta en el camino de cada llamada al modelo.
import type { RedisClientLike } from './circuit-breaker.js';

export interface UpstashRestClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class UpstashRestClient implements RedisClientLike {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: UpstashRestClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 800;
  }

  private async command(args: readonly (string | number)[]): Promise<unknown> {
    const res = await this.fetchImpl(this.opts.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || json.error) throw new Error(`upstash ${res.status}`);
    return json.result;
  }

  async get(key: string): Promise<string | null> {
    const r = await this.command(['GET', key]);
    return r === null || r === undefined ? null : String(r);
  }
  async set(key: string, value: string, opts: { EX: number }): Promise<unknown> {
    return this.command(['SET', key, value, 'EX', opts.EX]);
  }
  async ttl(key: string): Promise<number> {
    return Number(await this.command(['TTL', key]));
  }
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.command(['EVAL', script, keys.length, ...keys, ...args]);
  }
  async del(key: string): Promise<unknown> {
    return this.command(['DEL', key]);
  }
}
