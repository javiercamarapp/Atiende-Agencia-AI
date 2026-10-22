import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearAlertaRepetida, INTERVALO_ALERTA_MS, SILENCIO_MS } from "../../src/verticals/restaurantes/lib/alerta-pedido-nuevo.ts";
import { debeUsarOscuro, esHorarioNocturno } from "../../src/verticals/restaurantes/lib/tema-nocturno.ts";
import { solicitarWakeLock } from "../../src/verticals/restaurantes/lib/wake-lock.ts";

describe("alerta repetida de pedido nuevo", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("suena de inmediato y cada 8 s hasta detenerla", () => {
    const reproducir = vi.fn();
    const vibrar = vi.fn();
    const a = crearAlertaRepetida({ reproducir, vibrar });
    a.iniciar();
    expect(reproducir).toHaveBeenCalledTimes(1);
    expect(vibrar).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INTERVALO_ALERTA_MS * 3);
    expect(reproducir).toHaveBeenCalledTimes(4);
    a.detener();
    vi.advanceTimersByTime(INTERVALO_ALERTA_MS * 3);
    expect(reproducir).toHaveBeenCalledTimes(4);
    expect(a.sonando()).toBe(false);
  });

  it("iniciar dos veces no duplica el ciclo", () => {
    const reproducir = vi.fn();
    const a = crearAlertaRepetida({ reproducir });
    a.iniciar();
    a.iniciar();
    vi.advanceTimersByTime(INTERVALO_ALERTA_MS);
    expect(reproducir).toHaveBeenCalledTimes(2);
    a.detener();
  });

  it("silenciar 5 min calla y despues vuelve a sonar si siguen pendientes", () => {
    const reproducir = vi.fn();
    const a = crearAlertaRepetida({ reproducir });
    a.iniciar();
    a.silenciar();
    expect(a.silenciada()).toBe(true);
    vi.advanceTimersByTime(SILENCIO_MS - 1);
    expect(reproducir).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(reproducir).toHaveBeenCalledTimes(2);
    expect(a.silenciada()).toBe(false);
    a.detener();
  });

  it("si se atendieron los pedidos durante el silencio, no vuelve a sonar", () => {
    const reproducir = vi.fn();
    const a = crearAlertaRepetida({ reproducir });
    a.iniciar();
    a.silenciar();
    a.detener();
    vi.advanceTimersByTime(SILENCIO_MS * 2);
    expect(reproducir).toHaveBeenCalledTimes(1);
  });

  it("un fallo de audio no rompe el ciclo", () => {
    const reproducir = vi.fn(() => {
      throw new Error("sin audio");
    });
    const a = crearAlertaRepetida({ reproducir });
    expect(() => a.iniciar()).not.toThrow();
    a.detener();
  });
});

describe("tema nocturno", () => {
  it("de 19:00 a 07:00 es noche", () => {
    expect(esHorarioNocturno(new Date(2026, 9, 21, 19, 0))).toBe(true);
    expect(esHorarioNocturno(new Date(2026, 9, 21, 23, 59))).toBe(true);
    expect(esHorarioNocturno(new Date(2026, 9, 21, 6, 59))).toBe(true);
    expect(esHorarioNocturno(new Date(2026, 9, 21, 7, 0))).toBe(false);
    expect(esHorarioNocturno(new Date(2026, 9, 21, 18, 59))).toBe(false);
  });
  it("respeta la eleccion explicita; sin eleccion usa hora o sistema", () => {
    const dia = new Date(2026, 9, 21, 12, 0);
    const noche = new Date(2026, 9, 21, 21, 0);
    expect(debeUsarOscuro("claro", noche, true)).toBe(false);
    expect(debeUsarOscuro("oscuro", dia, false)).toBe(true);
    expect(debeUsarOscuro("sistema", noche, false)).toBe(false);
    expect(debeUsarOscuro(null, noche, false)).toBe(true);
    expect(debeUsarOscuro(null, dia, true)).toBe(true);
    expect(debeUsarOscuro(null, dia, false)).toBe(false);
  });
});

describe("wake lock", () => {
  it("sin soporte lo dice (no finge)", async () => {
    const estados: string[] = [];
    await solicitarWakeLock((e) => estados.push(e), { navigator: {} });
    expect(estados).toEqual(["no_soportado"]);
  });
  it("si el navegador lo niega, reporta denegado", async () => {
    const estados: string[] = [];
    await solicitarWakeLock((e) => estados.push(e), { navigator: { wakeLock: { request: async () => Promise.reject(new Error("no")) } } });
    expect(estados).toEqual(["denegado"]);
  });
  it("lo obtiene y lo libera", async () => {
    const estados: string[] = [];
    const release = vi.fn(async () => undefined);
    const c = await solicitarWakeLock((e) => estados.push(e), { navigator: { wakeLock: { request: async () => ({ release }) } } });
    expect(estados).toEqual(["activo"]);
    await c.liberar();
    expect(release).toHaveBeenCalled();
    expect(estados.at(-1)).toBe("inactivo");
  });
});
