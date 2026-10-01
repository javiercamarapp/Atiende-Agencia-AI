// LoginLockout: bloqueo por fallos con backoff, backend en memoria y Redis (fetch falso).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { LoginLockout, lockDurationMs, SCRIPT_RECORD_FAILURE } from '../src/login-lockout.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('lockDurationMs', () => {
  it('0 antes del umbral, base en el umbral, se duplica y topa en el máximo', () => {
    expect(lockDurationMs(4, 5, 30_000, 900_000)).toBe(0);
    expect(lockDurationMs(5, 5, 30_000, 900_000)).toBe(30_000);
    expect(lockDurationMs(6, 5, 30_000, 900_000)).toBe(60_000);
    expect(lockDurationMs(7, 5, 30_000, 900_000)).toBe(120_000);
    expect(lockDurationMs(50, 5, 30_000, 900_000)).toBe(900_000);
  });
});

describe('LoginLockout en memoria (sin Redis)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  const make = () => new LoginLockout({ redisUrl: '', redisToken: '' });

  it('no bloquea antes del umbral y bloquea al 5º fallo', async () => {
    const l = make();
    for (let i = 0; i < 4; i++) expect((await l.recordFailure('a@x.mx|1.1.1.1')).locked).toBe(false);
    expect((await l.status('a@x.mx|1.1.1.1')).locked).toBe(false);
    const fifth = await l.recordFailure('a@x.mx|1.1.1.1');
    expect(fifth).toMatchObject({ locked: true, retryAfterMs: 30_000, failures: 5 });
    expect(await l.status('a@x.mx|1.1.1.1')).toMatchObject({ locked: true, degraded: false });
  });

  it('el bloqueo termina y el siguiente fallo lo duplica (backoff)', async () => {
    const l = make();
    for (let i = 0; i < 5; i++) await l.recordFailure('k');
    vi.setSystemTime(Date.now() + 30_001);
    expect((await l.status('k')).locked).toBe(false);
    expect(await l.recordFailure('k')).toMatchObject({ locked: true, retryAfterMs: 60_000 });
  });

  it('llaves distintas (otro correo u otra IP) no comparten bloqueo', async () => {
    const l = make();
    for (let i = 0; i < 5; i++) await l.recordFailure('a@x.mx|1.1.1.1');
    expect((await l.status('a@x.mx|2.2.2.2')).locked).toBe(false);
    expect((await l.status('b@x.mx|1.1.1.1')).locked).toBe(false);
  });

  it('recordSuccess borra el conteo y levanta el bloqueo', async () => {
    const l = make();
    for (let i = 0; i < 5; i++) await l.recordFailure('k');
    await l.recordSuccess('k');
    expect((await l.status('k')).locked).toBe(false);
    expect((await l.recordFailure('k')).failures).toBe(1);
  });

  it('sin fallos durante la ventana de olvido el conteo se reinicia', async () => {
    const l = make();
    for (let i = 0; i < 4; i++) await l.recordFailure('k');
    vi.setSystemTime(Date.now() + 30 * 60_000 + 1);
    expect((await l.recordFailure('k')).failures).toBe(1);
  });
});

describe('LoginLockout con Redis', () => {
  const mk = (onEvent?: (e: { type: 'redis_failure'; op: 'status' | 'failure' | 'success' }) => void) => new LoginLockout({ redisUrl: 'https://fake.upstash.io', redisToken: 't', onEvent });

  it('recordFailure usa el script atómico y no manda la llave en claro', async () => {
    const calls: unknown[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ result: [5, 30000] }), { status: 200 });
    }));
    const r = await mk().recordFailure('persona@correo.mx|9.9.9.9');
    expect(r).toEqual({ failures: 5, locked: true, retryAfterMs: 30000, degraded: false });
    expect(calls[0]![0]).toBe('EVAL');
    expect(calls[0]![1]).toBe(SCRIPT_RECORD_FAILURE);
    expect(JSON.stringify(calls[0])).not.toContain('persona@correo.mx');
    expect(JSON.stringify(calls[0])).not.toContain('9.9.9.9');
  });

  it('status lee PTTL: >0 bloqueada, -2 libre', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    f.mockResolvedValueOnce(new Response(JSON.stringify({ result: 12000 }), { status: 200 }));
    expect(await mk().status('k')).toEqual({ locked: true, retryAfterMs: 12000, degraded: false });
    f.mockResolvedValueOnce(new Response(JSON.stringify({ result: -2 }), { status: 200 }));
    expect(await mk().status('k')).toEqual({ locked: false, retryAfterMs: 0, degraded: false });
  });

  it('Redis caído: nunca lanza, degrada al conteo en memoria y SÍ bloquea', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const events: unknown[] = [];
    const l = mk((e) => { events.push(e); });
    let last;
    for (let i = 0; i < 5; i++) last = await l.recordFailure('k');
    expect(last).toMatchObject({ locked: true, degraded: true, failures: 5 });
    expect(await l.status('k')).toMatchObject({ locked: true, degraded: true });
    await expect(l.recordSuccess('k')).resolves.toBeUndefined();
    expect(events.length).toBeGreaterThan(0);
  });

  it('respuesta de forma inesperada se trata como avería (degrada), no como "libre" ni "bloqueada"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x' }), { status: 500 })));
    expect(await mk().status('k')).toEqual({ locked: false, retryAfterMs: 0, degraded: true });
  });
});
