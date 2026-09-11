// Circuit breaker por proveedor — NUEVO, no existía en ningún repo origen (ni hoteles
// ni licitaciones). Evita seguir intentando contra un proveedor que ya demostró estar
// caído: tras `failureThreshold` fallos TRANSITORIOS consecutivos, se abre
// (`canAttempt()` devuelve false) durante `openMs`, luego permite una cantidad
// limitada de llamadas de prueba en "half_open" antes de decidir si cierra o reabre.
//
// Solo `ProviderTransientError` cuenta como fallo del breaker — el mismo criterio que
// hoteles ya usa para decidir fallback cross-provider (ver provider.ts): un
// `ProviderHttpError` (401/400/...) es un problema de config, no de disponibilidad, y
// reintentar no lo arregla, así que NUNCA cuenta como fallo aquí ni dispara apertura.
import { ProviderTransientError } from "./provider.ts";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  readonly failureThreshold: number; // fallos TRANSITORIOS consecutivos para abrir (default 5)
  readonly openMs: number; // tiempo en "open" antes de pasar a half-open (default 30_000)
  readonly halfOpenMaxAttempts: number; // llamadas de prueba permitidas en half-open (default 1)
  readonly now?: () => number;
}

export interface CircuitBreaker {
  readonly providerId: string;
  state(): CircuitState;
  /** false si "open" y aún no venció `openMs`; transiciona a "half_open" internamente
   * en cuanto el tiempo se cumple (side effect intencional: es la única forma de que
   * el breaker vuelva a probar el proveedor sin un temporizador externo). */
  canAttempt(): boolean;
  /** Resetea el contador de fallos y cierra el circuito (también desde half_open). */
  onSuccess(): void;
  /** Solo incrementa/actúa ante `ProviderTransientError`; cualquier otro error se
   * ignora silenciosamente a propósito (ver comentario de archivo). */
  onFailure(err: unknown): void;
}

const DEFAULT_OPTIONS = {
  failureThreshold: 5,
  openMs: 30_000,
  halfOpenMaxAttempts: 1,
} as const;

export function createCircuitBreaker(
  providerId: string,
  options: Partial<CircuitBreakerOptions> = {},
): CircuitBreaker {
  const failureThreshold = options.failureThreshold ?? DEFAULT_OPTIONS.failureThreshold;
  const openMs = options.openMs ?? DEFAULT_OPTIONS.openMs;
  const halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? DEFAULT_OPTIONS.halfOpenMaxAttempts;
  const now = options.now ?? Date.now;

  let state: CircuitState = "closed";
  let consecutiveFailures = 0;
  let openedAt = 0;
  let halfOpenAttempts = 0;

  function maybeTransitionFromOpen(): void {
    if (state === "open" && now() - openedAt >= openMs) {
      state = "half_open";
      halfOpenAttempts = 0;
    }
  }

  return {
    providerId,
    state(): CircuitState {
      maybeTransitionFromOpen();
      return state;
    },
    canAttempt(): boolean {
      maybeTransitionFromOpen();
      if (state === "closed") return true;
      if (state === "open") return false;
      // half_open: solo se permiten `halfOpenMaxAttempts` llamadas de prueba mientras
      // no se resuelva (onSuccess la cierra, onFailure la reabre).
      if (halfOpenAttempts < halfOpenMaxAttempts) {
        halfOpenAttempts += 1;
        return true;
      }
      return false;
    },
    onSuccess(): void {
      state = "closed";
      consecutiveFailures = 0;
      halfOpenAttempts = 0;
    },
    onFailure(err: unknown): void {
      if (!(err instanceof ProviderTransientError)) return; // ver comentario de archivo
      if (state === "half_open") {
        // La llamada de prueba también falló: reabre inmediatamente, sin volver a
        // contar contra `failureThreshold` (ya se demostró que sigue caído).
        state = "open";
        openedAt = now();
        halfOpenAttempts = 0;
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        state = "open";
        openedAt = now();
      }
    },
  };
}
