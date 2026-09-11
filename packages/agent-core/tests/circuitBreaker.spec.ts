import { describe, expect, it } from "vitest";
import { createCircuitBreaker } from "../src/gateway/circuitBreaker.ts";
import { ProviderTransientError, ProviderHttpError } from "../src/gateway/provider.ts";

function clock(startMs = 0) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("createCircuitBreaker", () => {
  it("empieza cerrado y permite intentos", () => {
    const cb = createCircuitBreaker("p1");
    expect(cb.state()).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("se abre tras `failureThreshold` fallos TRANSITORIOS consecutivos", () => {
    const c = clock();
    const cb = createCircuitBreaker("p1", { failureThreshold: 3, now: c.now });
    cb.onFailure(new ProviderTransientError("p1", "x"));
    cb.onFailure(new ProviderTransientError("p1", "x"));
    expect(cb.state()).toBe("closed");
    cb.onFailure(new ProviderTransientError("p1", "x"));
    expect(cb.state()).toBe("open");
    expect(cb.canAttempt()).toBe(false);
  });

  it("un ProviderHttpError NUNCA cuenta como fallo del breaker (config, no disponibilidad)", () => {
    const cb = createCircuitBreaker("p1", { failureThreshold: 1 });
    cb.onFailure(new ProviderHttpError("p1", 401, "credencial inválida"));
    expect(cb.state()).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("un error genérico (no ProviderTransientError) tampoco cuenta como fallo", () => {
    const cb = createCircuitBreaker("p1", { failureThreshold: 1 });
    cb.onFailure(new Error("algo raro"));
    expect(cb.state()).toBe("closed");
  });

  it("pasa a half_open después de `openMs` y permite hasta `halfOpenMaxAttempts` intentos de prueba", () => {
    const c = clock();
    const cb = createCircuitBreaker("p1", { failureThreshold: 1, openMs: 1000, halfOpenMaxAttempts: 2, now: c.now });
    cb.onFailure(new ProviderTransientError("p1", "x"));
    expect(cb.state()).toBe("open");
    expect(cb.canAttempt()).toBe(false);

    c.advance(1000);
    expect(cb.state()).toBe("half_open");
    expect(cb.canAttempt()).toBe(true); // intento de prueba 1
    expect(cb.canAttempt()).toBe(true); // intento de prueba 2
    expect(cb.canAttempt()).toBe(false); // se agotaron los intentos de prueba permitidos
  });

  it("un éxito en half_open cierra el circuito y resetea el contador de fallos", () => {
    const c = clock();
    const cb = createCircuitBreaker("p1", { failureThreshold: 1, openMs: 1000, now: c.now });
    cb.onFailure(new ProviderTransientError("p1", "x"));
    c.advance(1000);
    expect(cb.state()).toBe("half_open");
    cb.onSuccess();
    expect(cb.state()).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("un fallo transitorio en half_open reabre inmediatamente (no vuelve a contar contra failureThreshold)", () => {
    const c = clock();
    const cb = createCircuitBreaker("p1", { failureThreshold: 5, openMs: 1000, now: c.now });
    for (let i = 0; i < 5; i++) cb.onFailure(new ProviderTransientError("p1", "x"));
    expect(cb.state()).toBe("open");
    c.advance(1000);
    expect(cb.state()).toBe("half_open");
    cb.onFailure(new ProviderTransientError("p1", "x"));
    expect(cb.state()).toBe("open");
  });
});
