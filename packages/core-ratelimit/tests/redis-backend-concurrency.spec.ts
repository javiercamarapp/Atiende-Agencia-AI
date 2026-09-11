// ─────────────────────────────────────────────────────────────────────────────
// EL backend distribuido — el conteo es del SERVIDOR, no de la instancia.
//
// Portado del patrón de test real de
// ~/likida.ai/src/lib/ratelimit_redis.test.ts (describe "backend Redis — el
// conteo es del servidor, no de la instancia", 11-sep-2026). Mismo doble de
// la REST API de Upstash: SÍ hace lo que el script Lua promete (incrementa,
// TTL solo la primera vez) sin interpretar Lua de verdad — representa lo que
// Redis garantiza server-side, que es justo lo que `attemptRedisIncrement`
// no debe — ni puede — reimplementar.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from 'vitest';
import { DistributedRateLimiter } from '../src/rate-limiter.ts';
import { SCRIPT_INCR_WITH_TTL } from '../src/redis-backend.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fakeUpstashFetch() {
  const counters = new Map<string, { n: number; expiresAt: number }>();
  const calls: Array<{ body: unknown; auth: string | null }> = [];

  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const [, , , key, windowMs] = JSON.parse(String(init.body)) as [string, string, number, string, number];
    calls.push({ body: init.body, auth: (init.headers as Record<string, string>)?.Authorization ?? null });

    const now = Date.now();
    const existing = counters.get(key);
    const alive = existing && existing.expiresAt > now;
    const n = alive ? existing.n + 1 : 1;
    counters.set(key, { n, expiresAt: alive ? existing.expiresAt : now + windowMs });

    return new Response(JSON.stringify({ result: n }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { fn, calls };
}

function makeLimiter() {
  return new DistributedRateLimiter({ redisUrl: 'https://fake-redis.upstash.io', redisToken: 'tok-de-prueba' });
}

describe('DistributedRateLimiter + Redis — el límite se respeta bajo concurrencia REAL', () => {
  it('30 llamadas concurrentes a la MISMA llave con límite 5: exactamente 5 pasan (simula varias instancias serverless)', async () => {
    const { fn } = fakeUpstashFetch();
    vi.stubGlobal('fetch', fn);
    const limiter = makeLimiter();

    // Promise.all sin await intermedio: las 30 llamadas quedan genuinamente
    // intercaladas por el event loop contra el MISMO contador remoto — es el
    // escenario real que motiva este paquete: N instancias de Vercel/Lambda
    // pegándole a la misma llave a la vez. Con un Map por-instancia (sin
    // Redis) cada una permitiría sus propios 5; aquí solo hay UN contador.
    const outcomes = await Promise.all(
      Array.from({ length: 30 }, () => limiter.check('carrera:1.2.3.4', 5, 60_000)),
    );

    expect(outcomes.filter((o) => o.allowed).length).toBe(5);
    expect(outcomes.every((o) => o.backend === 'redis' && !o.degraded)).toBe(true);
  });

  it('dos limitadores INDEPENDIENTES (dos "instancias" reales) comparten el mismo tope vía Redis', async () => {
    // A diferencia del test anterior (un solo objeto DistributedRateLimiter),
    // aquí cada "instancia serverless" es un objeto propio con su propio
    // InMemoryWindowStore — la única fuente compartida es el fetch falso que
    // hace de Redis. Esto es lo que prueba que el límite es GLOBAL y no
    // "global porque comparten el mismo objeto JS en el test".
    const { fn } = fakeUpstashFetch();
    vi.stubGlobal('fetch', fn);
    const instanceA = makeLimiter();
    const instanceB = makeLimiter();

    const outcomes = await Promise.all([
      ...Array.from({ length: 10 }, () => instanceA.check('multi-instancia', 4, 60_000)),
      ...Array.from({ length: 10 }, () => instanceB.check('multi-instancia', 4, 60_000)),
    ]);

    expect(outcomes.filter((o) => o.allowed).length).toBe(4);
  });

  it('llaves distintas no comparten contador', async () => {
    const { fn } = fakeUpstashFetch();
    vi.stubGlobal('fetch', fn);
    const limiter = makeLimiter();

    expect((await limiter.check('a', 1, 60_000)).allowed).toBe(true);
    expect((await limiter.check('b', 1, 60_000)).allowed).toBe(true);
    expect((await limiter.check('a', 1, 60_000)).allowed).toBe(false);
  });

  it('manda el token como Bearer, el comando como EVAL con el script real, y windowMs en ms', async () => {
    const { fn, calls } = fakeUpstashFetch();
    vi.stubGlobal('fetch', fn);
    const limiter = new DistributedRateLimiter({
      redisUrl: 'https://fake-redis.upstash.io',
      redisToken: 'tok-de-prueba',
      keyPrefix: 'rl-test:',
    });

    await limiter.check('x', 1, 30_000);

    expect(calls[0]!.auth).toBe('Bearer tok-de-prueba');
    const body = JSON.parse(String(calls[0]!.body));
    expect(body[0]).toBe('EVAL');
    expect(body[1]).toBe(SCRIPT_INCR_WITH_TTL);
    expect(body[3]).toBe('rl-test:x'); // keyPrefix aplicado antes de llegar al backend
    expect(body[4]).toBe(30_000); // windowMs viaja tal cual, para PEXPIRE
  });

  it('la ventana caduca (TTL) y vuelve a permitir', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { fn } = fakeUpstashFetch();
    vi.stubGlobal('fetch', fn);
    const limiter = makeLimiter();

    expect((await limiter.check('ventana', 1, 60_000)).allowed).toBe(true);
    expect((await limiter.check('ventana', 1, 60_000)).allowed).toBe(false);
    vi.setSystemTime(60_001);
    expect((await limiter.check('ventana', 1, 60_000)).allowed).toBe(true);
  });
});
