// ─────────────────────────────────────────────────────────────────────────────
// InMemoryLockStore — implementación real (no un mock) de `LockStore` que
// serializa de verdad, dentro de un mismo proceso Node, usando una cola de
// promesas por clave. A diferencia del `RedisLockStore` en modo fail-open
// (sin credenciales → `acquired: true` siempre, sin serialización real), esta
// SÍ bloquea: dos `acquire()` concurrentes sobre la misma `key` se resuelven
// en orden, el segundo espera a que el primero haga `release()`.
//
// Uso: tests de concurrencia determinísticos (sin Redis real) y despliegues
// single-process (un solo worker) donde no hace falta coordinación entre
// procesos.
// ─────────────────────────────────────────────────────────────────────────────

import type { AcquireLockOptions, AcquireLockResult, LockStore } from './types.ts';

interface Waiter {
  token: string;
  resolve: () => void;
}

interface KeyState {
  heldToken: string | null;
  queue: Waiter[];
}

function randomToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export class InMemoryLockStore implements LockStore {
  private readonly keys = new Map<string, KeyState>();

  private stateFor(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) {
      s = { heldToken: null, queue: [] };
      this.keys.set(key, s);
    }
    return s;
  }

  async acquire(key: string, opts: AcquireLockOptions = {}): Promise<AcquireLockResult> {
    const maxWaitMs = opts.maxWaitMs ?? 15_000;
    const state = this.stateFor(key);
    const token = randomToken();

    if (state.heldToken === null) {
      state.heldToken = token;
      return { acquired: true, token };
    }

    // Lock tomado — nos ponemos en cola y esperamos a que nos toque, con
    // timeout total de maxWaitMs (igual semántica que el adaptador Redis:
    // el mensaje NO se pierde, se espera; si excede el budget, acquired=false).
    return new Promise<AcquireLockResult>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        token,
        resolve: () => {
          if (settled) return;
          settled = true;
          state.heldToken = token;
          resolve({ acquired: true, token });
        },
      };
      state.queue.push(waiter);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = state.queue.indexOf(waiter);
        if (idx >= 0) state.queue.splice(idx, 1);
        resolve({ acquired: false });
      }, maxWaitMs);
      // No mantener el proceso vivo solo por este timer en tests.
      if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
    });
  }

  async release(key: string, token: string): Promise<void> {
    const state = this.keys.get(key);
    if (!state) return;
    if (state.heldToken !== token) return; // defensa vs. release de otro dueño
    const next = state.queue.shift();
    if (next) {
      // Traspaso directo: el siguiente en la cola toma el lock YA (sin hueco
      // donde una tercera adquisición se cuele entre release y el siguiente acquire).
      next.resolve();
    } else {
      state.heldToken = null;
    }
  }

  async extend(key: string, token: string): Promise<boolean> {
    const state = this.keys.get(key);
    if (!state) return false;
    return state.heldToken === token;
  }
}
