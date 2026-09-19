import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryLockStore } from '../src/lock/in-memory-lock-store.ts';

// ─── InMemoryLockStore: serialización REAL dentro del proceso ──────────────

describe('InMemoryLockStore', () => {
  it('acquire feliz: da el lock con token', async () => {
    const store = new InMemoryLockStore();
    const r = await store.acquire('t-1:+521');
    expect(r.acquired).toBe(true);
    expect(r.token).toBeTruthy();
  });

  it('serializa: un segundo acquire concurrente sobre la misma key espera al release del primero', async () => {
    const store = new InMemoryLockStore();
    const order: string[] = [];

    const first = store.acquire('t-1:+521').then((r) => {
      order.push('first-acquired');
      return r;
    });
    const r1 = await first;

    // Mientras el primero sigue "trabajando" (no ha liberado), el segundo
    // acquire debe quedar pendiente — no resolver hasta el release.
    let secondResolved = false;
    const secondPromise = store.acquire('t-1:+521').then((r) => {
      secondResolved = true;
      order.push('second-acquired');
      return r;
    });

    // Deja correr microtasks/macrotasks — el segundo NO debe haber resuelto todavía.
    await new Promise((r) => setTimeout(r, 20));
    expect(secondResolved).toBe(false);

    await store.release('t-1:+521', r1.token!);
    const r2 = await secondPromise;

    expect(r2.acquired).toBe(true);
    expect(r2.token).not.toBe(r1.token);
    expect(order).toEqual(['first-acquired', 'second-acquired']);
  });

  it('locks distintos NO se bloquean entre sí (separación por key)', async () => {
    const store = new InMemoryLockStore();
    const a = await store.acquire('t-1:+521');
    const b = await store.acquire('t-1:+999'); // mismo tenant, cliente distinto
    const c = await store.acquire('t-2:+521'); // tenant distinto, mismo cliente
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(c.acquired).toBe(true);
  });

  it('acquired=false cuando se agota maxWaitMs con el lock tomado', async () => {
    const store = new InMemoryLockStore();
    const r1 = await store.acquire('t-1:+521');
    expect(r1.acquired).toBe(true);
    const r2 = await store.acquire('t-1:+521', { maxWaitMs: 80 });
    expect(r2.acquired).toBe(false);
  }, 2000);

  it('release NO libera si el token no coincide (defensa vs. release de otro dueño)', async () => {
    const store = new InMemoryLockStore();
    const r1 = await store.acquire('t-1:+521');
    await store.release('t-1:+521', 'token-equivocado');
    // Sigue tomado por r1 — un segundo acquire con timeout corto debe fallar.
    const r2 = await store.acquire('t-1:+521', { maxWaitMs: 50 });
    expect(r2.acquired).toBe(false);
    expect(r1.acquired).toBe(true);
  });

  it('extend: true mientras seguimos siendo dueños, false si no', async () => {
    const store = new InMemoryLockStore();
    const r1 = await store.acquire('t-1:+521');
    expect(await store.extend('t-1:+521', r1.token!)).toBe(true);
    expect(await store.extend('t-1:+521', 'otro-token')).toBe(false);
  });
});

// ─── RedisLockStore: mismo algoritmo que atiende.ai, ahora sobre `fetch` ────
// Portado del test real: ~/GitHub-repos-backup/atiende.ai/atiende-ai/
//   src/lib/whatsapp/__tests__/conversation-lock.test.ts
//
// Desde fix/conversation-lock-upstash, RedisLockStore habla REST crudo por
// `fetch` (mismo patrón que core-ratelimit) en vez del SDK `@upstash/redis` —
// estos tests mockean `fetch` con `packages/core-conversation/tests/fake-upstash.ts`
// en vez de mockear una clase del SDK.
import { RedisLockStore, type RedisLockStoreOptions } from '../src/lock/redis-lock-store.ts';
import { makeFakeUpstash, type FakeUpstash } from './fake-upstash.ts';

describe('RedisLockStore', () => {
  let upstash: FakeUpstash;

  beforeEach(() => {
    upstash = makeFakeUpstash();
    vi.stubGlobal('fetch', upstash.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeStore = (opts: Partial<RedisLockStoreOptions> = {}) => new RedisLockStore({ url: 'https://test.upstash.io', token: 'tok', ...opts });

  it('isConfigured(): true con url+token, false sin ellos', () => {
    expect(makeStore().isConfigured()).toBe(true);
    expect(new RedisLockStore({}).isConfigured()).toBe(false);
  });

  it('adquirir: happy path — SET NX EX gana, token propio', async () => {
    const r = await makeStore().acquire('t-1:+1');
    expect(r.acquired).toBe(true);
    expect(r.token).toBeTruthy();
    expect(upstash.has('lock:conv:t-1:+1')).toBe(true);
  });

  it('fail-open ante error de Redis en acquire (red caída) — nunca pierde el mensaje', async () => {
    upstash.down = true;
    const r = await makeStore().acquire('t-1:+1');
    expect(r.acquired).toBe(true);
  });

  it('fail-open sin credenciales configuradas (dev/CI sin Redis) — nunca llama a fetch', async () => {
    const store = new RedisLockStore({}); // sin url/token
    const r = await store.acquire('t-1:+1');
    expect(r.acquired).toBe(true);
    expect(upstash.fetch).not.toHaveBeenCalled();
  });

  it('contención: acquired=false cuando otro proceso ya tiene el lock y se agota el timeout', async () => {
    upstash.seed('lock:conv:t-1:+1', 'other-token', 30);
    const r = await makeStore().acquire('t-1:+1', { maxWaitMs: 100, pollIntervalMs: 30 });
    expect(r.acquired).toBe(false);
  }, 5000);

  it('contención: si el otro dueño libera antes del timeout, el que esperaba SÍ adquiere', async () => {
    const store = makeStore();
    const first = await store.acquire('t-1:+1', { ttlSeconds: 30 });
    expect(first.acquired).toBe(true);

    const waiterPromise = store.acquire('t-1:+1', { maxWaitMs: 2000, pollIntervalMs: 30 });
    await new Promise((r) => setTimeout(r, 60)); // deja correr al menos 1 poll
    await store.release('t-1:+1', first.token!);

    const waiter = await waiterPromise;
    expect(waiter.acquired).toBe(true);
    expect(waiter.token).not.toBe(first.token);
  });

  it('expiración por TTL: un lock vencido se puede volver a adquirir de inmediato (nunca hay que esperar el poll)', async () => {
    upstash.seed('lock:conv:t-1:+1', 'stale-token', 10); // TTL corto
    upstash.advance(11_000); // el reloj falso avanza más allá del TTL

    const r = await makeStore().acquire('t-1:+1', { maxWaitMs: 200, pollIntervalMs: 50 });
    expect(r.acquired).toBe(true);
    expect(r.token).not.toBe('stale-token');
  });

  it('release: NO libera si el token no coincide (defensa vs. carrera con otro dueño)', async () => {
    const store = makeStore();
    await store.acquire('t-1:+1');
    await store.release('t-1:+1', 'wrong-token');
    expect(upstash.has('lock:conv:t-1:+1')).toBe(true);
  });

  it('release: libera con el token correcto (propietario)', async () => {
    const store = makeStore();
    const r = await store.acquire('t-1:+1');
    await store.release('t-1:+1', r.token!);
    expect(upstash.has('lock:conv:t-1:+1')).toBe(false);
  });

  it('release: fail-open si Redis truena — no lanza, el TTL libera eventualmente', async () => {
    const store = makeStore();
    const r = await store.acquire('t-1:+1');
    upstash.down = true;
    await expect(store.release('t-1:+1', r.token!)).resolves.toBeUndefined();
  });

  it('extend: true mientras el token sigue siendo el dueño', async () => {
    const store = makeStore();
    const r = await store.acquire('t-1:+1', { ttlSeconds: 10 });
    const ok = await store.extend('t-1:+1', r.token!, 30);
    expect(ok).toBe(true);
  });

  it('extend: false cuando el token ya no coincide (lock perdido/re-adquirido por otro)', async () => {
    upstash.seed('lock:conv:t-1:+1', 'other-token', 30);
    const ok = await makeStore().extend('t-1:+1', 'wrong-token');
    expect(ok).toBe(false);
  });

  it('extend: fail-open si Redis truena — no aborta un pipeline en marcha', async () => {
    upstash.down = true;
    const ok = await makeStore().extend('t-1:+1', 'token');
    expect(ok).toBe(true);
  });
});
