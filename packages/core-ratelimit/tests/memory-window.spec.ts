// ─── InMemoryWindowStore: sliding window real dentro del proceso ───────────

import { describe, it, expect, vi } from 'vitest';
import { InMemoryWindowStore } from '../src/memory-window.ts';

describe('InMemoryWindowStore', () => {
  it('permite hasta el límite y niega el siguiente', () => {
    const store = new InMemoryWindowStore();
    expect(store.check('k', 3, 60_000)).toBe(true);
    expect(store.check('k', 3, 60_000)).toBe(true);
    expect(store.check('k', 3, 60_000)).toBe(true);
    expect(store.check('k', 3, 60_000)).toBe(false); // 4º hit, límite 3
  });

  it('llaves distintas no comparten cubeta', () => {
    const store = new InMemoryWindowStore();
    expect(store.check('a', 1, 60_000)).toBe(true);
    expect(store.check('b', 1, 60_000)).toBe(true);
    expect(store.check('a', 1, 60_000)).toBe(false);
    expect(store.check('b', 1, 60_000)).toBe(false);
  });

  it('sliding real: los sellos fuera de la ventana no cuentan (no es ventana fija)', async () => {
    // Reloj falso en vez de setTimeout(real) + Date.now()(real): antes, este
    // test dependía de que el wall-clock real cumpliera los 25ms/40ms exactos
    // que asume cada aserción — bajo carga de máquina (varios `vitest run`
    // en paralelo compitiendo por CPU, como en esta Mac con varios
    // constructores a la vez) el scheduler de Node puede atrasar el
    // setTimeout lo suficiente para que un sello que "debía" seguir vivo ya
    // no lo esté (o viceversa), hasta desde el hallazgo original: flaky
    // conocido, ver progreso-r4-ci-typecheck-lint-tests.md. `vi.useFakeTimers()`
    // fija tanto `Date.now()` como el scheduler de timers a un reloj virtual
    // que solo avanza cuando el test se lo pide explícitamente
    // (`vi.advanceTimersByTimeAsync`) — los 25ms/40ms dejan de ser una
    // promesa sobre el wall-clock real y pasan a ser exactos siempre, sin
    // importar cuánta CPU tenga libre la máquina en ese instante.
    vi.useFakeTimers();
    try {
      const store = new InMemoryWindowStore();
      expect(store.check('sliding', 2, 40)).toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      expect(store.check('sliding', 2, 40)).toBe(true); // 2 vivos, cabe
      expect(store.check('sliding', 2, 40)).toBe(false); // 3er hit dentro de la ventana de los 2 vivos: niega
      await vi.advanceTimersByTimeAsync(25); // el primer sello (t=0) ya salió de la ventana de 40ms
      expect(store.check('sliding', 2, 40)).toBe(true); // solo 1 sello vivo (t=25) + este nuevo = 2, cabe
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset() limpia el estado', () => {
    const store = new InMemoryWindowStore();
    expect(store.check('k', 1, 60_000)).toBe(true);
    expect(store.check('k', 1, 60_000)).toBe(false);
    store.reset();
    expect(store.check('k', 1, 60_000)).toBe(true);
  });

  it('backstop de memoria: podar mantiene el tamaño acotado sin perder cubetas VIVAS', () => {
    const store = new InMemoryWindowStore();
    // 5001 llaves con ventana larga (todas siguen "vivas") dispara la poda por
    // caducidad-primero-luego-más-antigua en vez de crecer sin límite.
    for (let i = 0; i < 5001; i++) {
      store.check(`k${i}`, 10, 60_000);
    }
    expect(store.size()).toBeLessThanOrEqual(5000);
    // Las últimas llaves creadas (las más "nuevas") deben seguir vivas —
    // la poda descarta por caducidad/antigüedad, no por si son las últimas
    // insertadas ni al azar.
    expect(store.check('k5000', 10, 60_000)).toBe(true);
  });
});
