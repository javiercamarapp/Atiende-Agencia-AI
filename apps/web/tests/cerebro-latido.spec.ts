// Latido del Cerebro (portado de latido.test.ts de Likida, FE-16): con la pestana OCULTA no se late; al volver late UNA vez; dos
// latidos no se enciman; al parar se suelta el reloj y el oyente.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arrancarLatido } from "../src/superadmin/cerebro/latido.ts";

const MIN = 60_000;

function pestana() {
  let oculta = false;
  const oyentes = new Set<() => void>();
  return {
    oculto: () => oculta,
    alCambiarVisibilidad: (cb: () => void) => {
      oyentes.add(cb);
      return () => oyentes.delete(cb);
    },
    poner(v: boolean) {
      oculta = v;
      oyentes.forEach((cb) => cb());
    },
    get oyentes() {
      return oyentes.size;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("el latido del Cerebro", () => {
  it("con la pestana a la vista late cada intervalo", async () => {
    const p = pestana();
    const latir = vi.fn();
    const parar = arrancarLatido({ intervaloMs: 5 * MIN, ...p, latir });
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(latir).toHaveBeenCalledTimes(3);
    parar();
  });

  it("OCULTA no late, pasen las horas que pasen", async () => {
    const p = pestana();
    const latir = vi.fn();
    const parar = arrancarLatido({ intervaloMs: 5 * MIN, ...p, latir });
    p.poner(true);
    await vi.advanceTimersByTimeAsync(8 * 60 * MIN);
    expect(latir).not.toHaveBeenCalled();
    parar();
  });

  it("al volver, UNA sola actualizacion y no los 96 latidos que se salto", async () => {
    const p = pestana();
    const latir = vi.fn();
    const parar = arrancarLatido({ intervaloMs: 5 * MIN, ...p, latir });
    p.poner(true);
    await vi.advanceTimersByTimeAsync(8 * 60 * MIN);
    p.poner(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(latir).toHaveBeenCalledTimes(1);
    parar();
  });

  it("entrar y salir de la pestana SIN que pase el intervalo no dispara nada", async () => {
    const p = pestana();
    const latir = vi.fn();
    const parar = arrancarLatido({ intervaloMs: 5 * MIN, ...p, latir });
    p.poner(true);
    await vi.advanceTimersByTimeAsync(MIN);
    p.poner(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(latir).not.toHaveBeenCalled();
    parar();
  });

  it("dos latidos no se enciman: con la red lenta, el siguiente espera", async () => {
    const p = pestana();
    let resolver: (() => void) | null = null;
    const latir = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolver = r;
        }),
    );
    const parar = arrancarLatido({ intervaloMs: 5 * MIN, ...p, latir });
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(latir).toHaveBeenCalledTimes(1);
    (resolver as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(latir).toHaveBeenCalledTimes(2);
    parar();
  });

  it("al parar se suelta el reloj Y el oyente de visibilidad", async () => {
    const p = pestana();
    const latir = vi.fn();
    const parar = arrancarLatido({ intervaloMs: 5 * MIN, ...p, latir });
    expect(p.oyentes).toBe(1);
    parar();
    expect(p.oyentes).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(latir).not.toHaveBeenCalled();
  });
});
