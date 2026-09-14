// ─────────────────────────────────────────────────────────────────────────────
// InMemoryWindowStore — backend LOCAL, por instancia. Sliding window real:
// descarta cada sello fuera de la ventana en cada check, en vez de contar por
// ventana fija. Es el respaldo cuando Redis no está configurado, y a lo que
// se degrada una llamada individual en fail-open acotado cuando Redis SÍ está
// configurado pero un intento falla (ver rate-limiter.ts).
//
// Portado de: ~/proyecto-origen/src/lib/ratelimit.ts — `buckets`/`limiteLocal`/
// `podar` (líneas 102-156 al momento de portar, 11-sep-2026 — commit
// 6a2cdec era HEAD de ese repo entonces). Mismo algoritmo y mismo criterio de
// poda (por CADUCIDAD primero, no por orden de inserción: ver el comentario
// original sobre el bug que corrigió — una llave bloqueada podía perder su
// bloqueo antes que cubetas ya caducadas, porque `Map` conserva orden de alta
// y `set` sobre una llave existente no la mueve al final).
//
// Cambios vs. el original: clase en vez de `Map` de módulo — para que cada
// `DistributedRateLimiter` (o cada test) tenga su propio estado aislado en
// vez de compartir un Map global del proceso — y nombres en inglés, que es
// lo que usa el resto de los símbolos públicos de este paquete. La lógica de
// conteo y de poda no cambió.
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket {
  timestamps: number[];
  expiresAt: number;
}

const MAX_KEYS = 5000; // backstop de memoria
const TARGET_AFTER_PRUNE = Math.floor(MAX_KEYS * 0.75);

export class InMemoryWindowStore {
  private buckets = new Map<string, Bucket>();

  /** true si la petición se PERMITE. */
  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const prev = this.buckets.get(key);
    const alive = (prev?.timestamps ?? []).filter((t) => now - t < windowMs);

    // La cubeta deja de decir nada cuando su sello más nuevo sale de la ventana.
    const save = (timestamps: number[]) => {
      this.buckets.set(key, {
        timestamps,
        expiresAt: (timestamps.length ? Math.max(...timestamps) : now) + windowMs,
      });
    };

    if (alive.length >= limit) {
      save(alive);
      return false;
    }
    alive.push(now);
    save(alive);

    if (this.buckets.size > MAX_KEYS) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [k, b] of this.buckets) {
      if (b.expiresAt <= now) this.buckets.delete(k);
    }
    if (this.buckets.size <= MAX_KEYS) return;

    const byExpiry = [...this.buckets.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const excess = this.buckets.size - TARGET_AFTER_PRUNE;
    for (let i = 0; i < excess; i++) {
      const entry = byExpiry[i];
      if (entry) this.buckets.delete(entry[0]);
    }
  }

  /** Solo para pruebas / reciclar una instancia entre llamadas. */
  reset(): void {
    this.buckets.clear();
  }

  /** Solo para pruebas: cuántas llaves vivas hay en este momento. */
  size(): number {
    return this.buckets.size;
  }
}
