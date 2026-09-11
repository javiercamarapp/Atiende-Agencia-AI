import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// ─── RedisLockStore: mismo algoritmo que atiende.ai, mock de @upstash/redis ─
// Portado del test real: ~/GitHub-repos-backup/atiende.ai/atiende-ai/
//   src/lib/whatsapp/__tests__/conversation-lock.test.ts

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  setThrows: false,
  evalThrows: false,
  evalReturn: 1 as number,
}));

vi.mock('@upstash/redis', () => ({
  Redis: class {
    async set(key: string, value: string, opts: { nx?: boolean; ex?: number }) {
      if (mocks.setThrows) throw new Error('redis set fail');
      if (opts.nx && mocks.store.has(key)) return null;
      mocks.store.set(key, value);
      return 'OK';
    }
    async eval(script: string, keys: string[], args: string[]) {
      if (mocks.evalThrows) throw new Error('redis eval fail');
      const k = keys[0]!;
      const expectedToken = args[0];
      if (script.includes('del') && mocks.store.get(k) === expectedToken) {
        mocks.store.delete(k);
        return 1;
      }
      if (script.includes('expire') && mocks.store.get(k) === expectedToken) {
        return 1;
      }
      return mocks.evalReturn;
    }
  },
}));

const { RedisLockStore } = await import('../src/lock/redis-lock-store.ts');

describe('RedisLockStore', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.setThrows = false;
    mocks.evalThrows = false;
    mocks.evalReturn = 1;
  });

  const makeStore = () => new RedisLockStore({ url: 'https://test.upstash.io', token: 'tok' });

  it('happy path: acquiere con token', async () => {
    const r = await makeStore().acquire('t-1:+1');
    expect(r.acquired).toBe(true);
    expect(r.token).toBeTruthy();
  });

  it('fail-open ante error de Redis en acquire', async () => {
    mocks.setThrows = true;
    const r = await makeStore().acquire('t-1:+1');
    expect(r.acquired).toBe(true);
  });

  it('fail-open sin credenciales configuradas (dev/CI sin Redis)', async () => {
    const store = new RedisLockStore({}); // sin url/token
    const r = await store.acquire('t-1:+1');
    expect(r.acquired).toBe(true);
  });

  it('acquired=false cuando otro proceso ya tiene el lock y se agota el timeout', async () => {
    mocks.store.set('lock:conv:t-1:+1', 'other-token');
    const r = await makeStore().acquire('t-1:+1', { maxWaitMs: 100, pollIntervalMs: 50 });
    expect(r.acquired).toBe(false);
  }, 5000);

  it('release: NO libera si el token no coincide (defensa vs. carrera)', async () => {
    const store = makeStore();
    await store.acquire('t-1:+1');
    await store.release('t-1:+1', 'wrong-token');
    expect(mocks.store.has('lock:conv:t-1:+1')).toBe(true);
  });

  it('release: libera con el token correcto', async () => {
    const store = makeStore();
    const r = await store.acquire('t-1:+1');
    await store.release('t-1:+1', r.token!);
    expect(mocks.store.has('lock:conv:t-1:+1')).toBe(false);
  });

  it('extend: false cuando el token ya no coincide (lock perdido)', async () => {
    mocks.evalReturn = 0;
    const ok = await makeStore().extend('t-1:+1', 'wrong-token');
    expect(ok).toBe(false);
  });

  it('extend: fail-open si Redis truena', async () => {
    mocks.evalThrows = true;
    const ok = await makeStore().extend('t-1:+1', 'token');
    expect(ok).toBe(true);
  });
});
