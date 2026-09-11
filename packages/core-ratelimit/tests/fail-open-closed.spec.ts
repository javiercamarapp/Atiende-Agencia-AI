// ─────────────────────────────────────────────────────────────────────────────
// Fail-open vs. fail-closed — Redis está CONFIGURADO pero el intento FALLA a
// media petición (red caída, timeout, respuesta de error). Ver la cabecera
// de rate-limiter.ts y la tabla en endpoint-policy.ts para el criterio.
//
// Patrón portado de
// ~/likida.ai/src/lib/ratelimit_redis.test.ts, describe "Redis configurado
// pero el intento falla — nunca rompe la petición" (11-sep-2026): red caída
// nunca lanza, y la respuesta por default niega salvo que se pida
// explícitamente lo contrario. Generalizado aquí de una sola env var global
// a la tabla por-categoría de endpoint-policy.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from 'vitest';
import { DistributedRateLimiter, rateLimit, resetDefaultRateLimiterForTests } from '../src/rate-limiter.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetDefaultRateLimiterForTests();
});

function makeLimiter(onEvent?: (e: unknown) => void) {
  return new DistributedRateLimiter({
    redisUrl: 'https://fake-redis.upstash.io',
    redisToken: 'tok-de-prueba',
    onEvent: onEvent as never,
  });
}

describe('Redis caído — categoría CERRADA (mcp:cfdi) niega, nunca lanza', () => {
  it('red caída (fetch rechaza): niega, no lanza', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const limiter = makeLimiter();

    await expect(limiter.check('cfdi:timbrar:tenant-1', 100, 60_000, { category: 'mcp:cfdi' })).resolves.toEqual({
      allowed: false,
      backend: 'redis',
      degraded: true,
    });
  });

  it('timeout (AbortSignal.timeout dispara): mismo tratamiento que red caída', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((_res, rej) => {
            const e = new Error('The operation was aborted');
            e.name = 'TimeoutError';
            rej(e);
          }),
      ),
    );
    const limiter = makeLimiter();

    const outcome = await limiter.check('cfdi:timbrar:tenant-2', 5, 60_000, { category: 'mcp:cfdi' });
    expect(outcome.allowed).toBe(false);
  });

  it('Upstash responde con error (comando inválido, 400): niega, no lanza', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'ERR algo salió mal' }), { status: 400 })),
    );
    const limiter = makeLimiter();

    const outcome = await limiter.check('cfdi:timbrar:tenant-3', 5, 60_000, { category: 'mcp:cfdi' });
    expect(outcome.allowed).toBe(false);
  });

  it('emite el evento redis_failure con failClosed:true y SIN la llave completa (nunca filtra IP/id)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const events: unknown[] = [];
    const limiter = makeLimiter((e) => events.push(e));

    await limiter.check('cfdi:timbrar:tenant-sensible-999', 5, 60_000, { category: 'mcp:cfdi' });

    expect(events).toEqual([{ type: 'redis_failure', category: 'mcp:cfdi', failClosed: true }]);
    expect(JSON.stringify(events)).not.toContain('tenant-sensible-999');
  });

  it('categoría desconocida ante Redis caído: también niega (default seguro, no abierto por omisión)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const limiter = makeLimiter();

    const outcome = await limiter.check('sin-categoria-catalogada', 5, 60_000, {});
    expect(outcome.allowed).toBe(false);
  });
});

describe('Redis caído — categoría ABIERTA (mcp:pms) degrada a memoria, el tope local SIGUE aplicando', () => {
  it('degrada al backend en memoria: la primera pasa, pero el tope local sigue limitando', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const limiter = makeLimiter();

    const first = await limiter.check('pms:disponibilidad:tenant-1', 1, 60_000, { category: 'mcp:pms' });
    expect(first).toEqual({ allowed: true, backend: 'memory', degraded: true });

    // "Fail-open" NUNCA significa "sin límite": el backend en memoria de esta
    // instancia sigue imponiendo el mismo tope mientras dure la avería.
    const second = await limiter.check('pms:disponibilidad:tenant-1', 1, 60_000, { category: 'mcp:pms' });
    expect(second).toEqual({ allowed: false, backend: 'memory', degraded: true });
  });
});

describe('opts.failClosed explícito por-llamada gana sobre la categoría', () => {
  it('{ failClosed: false } abre una categoría catalogada como cerrada', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const limiter = makeLimiter();

    const outcome = await limiter.check('login:1.2.3.4', 5, 60_000, { category: 'auth:login', failClosed: false });
    expect(outcome).toEqual({ allowed: true, backend: 'memory', degraded: true });
  });

  it('{ failClosed: true } cierra una categoría catalogada como abierta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const limiter = makeLimiter();

    const outcome = await limiter.check('pms:x', 5, 60_000, { category: 'mcp:pms', failClosed: true });
    expect(outcome).toEqual({ allowed: false, backend: 'redis', degraded: true });
  });
});

describe('sin credenciales configuradas — nunca intenta Redis, usa memoria directo', () => {
  it('isRedisConfigured() es false y fetch jamás se llama', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const limiter = new DistributedRateLimiter({}); // sin url/token

    expect(limiter.isRedisConfigured()).toBe(false);
    const outcome = await limiter.check('sin-creds', 1, 60_000, { category: 'auth:login' });
    expect(outcome).toEqual({ allowed: true, backend: 'memory', degraded: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('API simple rateLimit() (default singleton, credenciales por env)', () => {
  it('sin env configurada, igual aplica un límite vía memoria', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await rateLimit('simple-api-k', 1, 60_000)).toBe(true);
    expect(await rateLimit('simple-api-k', 1, 60_000)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('con env configurada y Redis caído, categoría cerrada niega vía la API simple', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake-redis.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    expect(await rateLimit('simple-api-login:9.9.9.9', 5, 60_000, { category: 'auth:login' })).toBe(false);
  });
});
