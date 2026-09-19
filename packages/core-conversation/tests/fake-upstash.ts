// ─────────────────────────────────────────────────────────────────────────────
// Fake mínimo de la REST API de Upstash, servido por un `fetch` inyectado vía
// `vi.stubGlobal('fetch', ...)` — mismo patrón de test que
// packages/core-ratelimit/tests/fail-open-closed.spec.ts, generalizado a los 2
// comandos que RedisLockStore necesita (SET NX EX, EVAL). Implementa EX de
// verdad (con un reloj inyectable) para poder probar expiración por TTL sin
// esperar tiempo real.
// ─────────────────────────────────────────────────────────────────────────────
import { vi } from 'vitest';

interface Entry {
  value: string;
  expiresAt: number;
}

export interface FakeUpstash {
  /** El mock de `fetch` — pásalo a `vi.stubGlobal('fetch', fake.fetch)`. */
  fetch: ReturnType<typeof vi.fn>;
  /** Reloj falso que consulta el fake para decidir si una entry ya expiró —
   *  avanza el tiempo con `fake.advance(ms)` para probar expiración de TTL. */
  advance(ms: number): void;
  /** true mientras el fake deba simular Redis caído (toda llamada falla). */
  down: boolean;
  /** Pre-carga una entry directo en el store (para simular "otro proceso ya
   *  tiene el lock" sin pasar por un `acquire` real). */
  seed(key: string, value: string, ttlSeconds: number): void;
  has(key: string): boolean;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export function makeFakeUpstash(): FakeUpstash {
  const store = new Map<string, Entry>();
  let now = Date.now();
  const state = { down: false };

  function liveGet(key: string): string | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (state.down) throw new Error('ECONNREFUSED (fake-upstash: down=true)');

    const command = JSON.parse(String(init?.body ?? '[]')) as unknown[];
    const [cmd, ...rest] = command;

    if (cmd === 'SET') {
      const [key, value, nxFlag, exFlag, ttlSeconds] = rest as [string, string, string, string, number];
      if (nxFlag !== 'NX' || exFlag !== 'EX') throw new Error(`fake-upstash: comando SET no soportado: ${JSON.stringify(command)}`);
      if (liveGet(key) !== null) return jsonResponse({ result: null }); // NX: ya existe y sigue vivo
      store.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
      return jsonResponse({ result: 'OK' });
    }

    if (cmd === 'EVAL') {
      const [script, _numkeys, key, token, extendSecondsRaw] = rest as [string, number, string, string, string?];
      const current = liveGet(key);
      if (script.includes('del')) {
        if (current === token) {
          store.delete(key);
          return jsonResponse({ result: 1 });
        }
        return jsonResponse({ result: 0 });
      }
      if (script.includes('expire')) {
        if (current === token) {
          const entry = store.get(key)!;
          entry.expiresAt = now + Number(extendSecondsRaw) * 1000;
          return jsonResponse({ result: 1 });
        }
        return jsonResponse({ result: 0 });
      }
      throw new Error(`fake-upstash: script EVAL no reconocido: ${script}`);
    }

    throw new Error(`fake-upstash: comando no soportado: ${JSON.stringify(command)}`);
  });

  return {
    fetch: fetchMock,
    advance(ms: number) {
      now += ms;
    },
    get down() {
      return state.down;
    },
    set down(value: boolean) {
      state.down = value;
    },
    seed(key: string, value: string, ttlSeconds: number) {
      store.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
    },
    has(key: string) {
      return liveGet(key) !== null;
    },
  };
}
