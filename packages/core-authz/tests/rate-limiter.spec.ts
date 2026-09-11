import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../src/index.ts";

describe("InMemoryRateLimiter", () => {
  it("permite hasta la capacidad, luego bloquea", () => {
    const now = 0;
    const rl = new InMemoryRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => now });
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(true);
    const blocked = rl.consume("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("cada llave tiene su propio bucket — bloquear una llave no afecta a otra", () => {
    const now = 0;
    const rl = new InMemoryRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
    expect(rl.consume("actor-a").allowed).toBe(true);
    expect(rl.consume("actor-a").allowed).toBe(false);
    expect(rl.consume("actor-b").allowed).toBe(true); // llave distinta, bucket lleno
  });

  it("repone tokens con el paso del tiempo (reloj inyectado, determinista)", () => {
    let now = 0;
    const rl = new InMemoryRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(false);
    now += 1_000; // 1s después, a 1 token/seg ya repuso el único token
    expect(rl.consume("k").allowed).toBe(true);
  });

  it("evict LRU: al superar maxKeys, descarta el bucket menos usado recientemente en vez de crecer sin límite", () => {
    let now = 0;
    const rl = new InMemoryRateLimiter({ capacity: 1, refillPerSecond: 0.001, now: () => now, maxKeys: 2 });
    rl.consume("viejo"); // usado en t=0
    now = 10;
    rl.consume("reciente"); // usado en t=10
    now = 20;
    rl.consume("nuevo"); // fuerza evict — "viejo" es el menos usado recientemente
    // "viejo" debería haberse reciclado a un bucket fresco (capacidad completa de nuevo)
    expect(rl.available("viejo")).toBe(1);
  });
});
