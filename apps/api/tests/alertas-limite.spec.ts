// Piso por hora por (tipo, destino). Sin Redis: backend en memoria del limitador real.
import { describe, expect, it, vi } from "vitest";
import { DistributedRateLimiter } from "@atiende/core-ratelimit";
import { LIMITE_POR_HORA_POR_DEFECTO, crearLimitadorAlertas, llaveLimite, normalizarLimitePorHora } from "../src/alertas/limite-horario.ts";

const SIN_REDIS = { redisUrl: "", redisToken: "" };

describe("normalizarLimitePorHora", () => {
  it("acepta enteros validos, acota al maximo y cae al default con basura (nunca 0)", () => {
    expect(normalizarLimitePorHora("5")).toBe(5);
    expect(normalizarLimitePorHora(3)).toBe(3);
    expect(normalizarLimitePorHora(9999)).toBe(60);
    for (const malo of [0, -1, "0", "abc", "", Number.NaN, undefined, null]) expect(normalizarLimitePorHora(malo)).toBe(LIMITE_POR_HORA_POR_DEFECTO);
  });
});

describe("llaveLimite", () => {
  it("nunca incluye el destino en claro", () => {
    const k = llaveLimite("cron_error:/x", "superadmin@empresa.com");
    expect(k).not.toContain("superadmin");
    expect(k).not.toContain("empresa");
  });
});

describe("crearLimitadorAlertas", () => {
  it("permite N por hora por (tipo, destino) y suprime el resto", async () => {
    const lim = crearLimitadorAlertas({ limitePorHora: 2, limiter: new DistributedRateLimiter(SIN_REDIS) });
    expect([await lim.permitir("a", "d1"), await lim.permitir("a", "d1"), await lim.permitir("a", "d1")]).toEqual([true, true, false]);
  });

  it("cuenta aparte por tipo y por destino", async () => {
    const lim = crearLimitadorAlertas({ limitePorHora: 1, limiter: new DistributedRateLimiter(SIN_REDIS) });
    expect(await lim.permitir("a", "d1")).toBe(true);
    expect(await lim.permitir("a", "d1")).toBe(false);
    expect(await lim.permitir("b", "d1")).toBe(true);
    expect(await lim.permitir("a", "d2")).toBe(true);
  });

  it("la ventana se reabre pasada una hora", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
      const lim = crearLimitadorAlertas({ limitePorHora: 1, limiter: new DistributedRateLimiter(SIN_REDIS) });
      expect(await lim.permitir("a", "d")).toBe(true);
      expect(await lim.permitir("a", "d")).toBe(false);
      vi.setSystemTime(new Date("2026-09-30T11:00:01Z"));
      expect(await lim.permitir("a", "d")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("si el limitador falla, la alerta SALE (fail-open) y se pide failClosed:false", async () => {
    const check = vi.fn().mockRejectedValue(new Error("redis caido"));
    const lim = crearLimitadorAlertas({ limiter: { check } });
    expect(await lim.permitir("a", "d")).toBe(true);
    const ok = vi.fn().mockResolvedValue({ allowed: true, backend: "memory", degraded: false });
    await crearLimitadorAlertas({ limiter: { check: ok } }).permitir("a", "d");
    expect(ok.mock.calls[0]?.[3]).toEqual({ failClosed: false });
    expect(ok.mock.calls[0]?.[2]).toBe(3_600_000);
  });
});
