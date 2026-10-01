// R-11 -- reglas puras del tiempo real del panel de pedidos (backoff, pedidos nuevos, etiquetas, sonido).
import { describe, expect, it } from "vitest";
import {
  SONDEO_BASE_MS,
  SONDEO_MAX_MS,
  etiquetaActualizado,
  faltaPara,
  guardarSonido,
  idsNuevos,
  leerSonido,
  siguienteIntervaloMs,
} from "../src/verticals/restaurantes/lib/sondeo-pedidos.ts";

describe("siguienteIntervaloMs (backoff)", () => {
  it("sin fallos es el intervalo base; cada fallo seguido lo duplica hasta el tope", () => {
    expect(siguienteIntervaloMs(0)).toBe(SONDEO_BASE_MS);
    expect(siguienteIntervaloMs(1)).toBe(SONDEO_BASE_MS * 2);
    expect(siguienteIntervaloMs(2)).toBe(SONDEO_BASE_MS * 4);
    expect(siguienteIntervaloMs(3)).toBe(SONDEO_MAX_MS);
    expect(siguienteIntervaloMs(50)).toBe(SONDEO_MAX_MS);
  });

  it("valores raros (negativos, decimales, enormes) nunca dan menos que la base ni Infinity", () => {
    expect(siguienteIntervaloMs(-3)).toBe(SONDEO_BASE_MS);
    expect(siguienteIntervaloMs(1.9)).toBe(SONDEO_BASE_MS * 2);
    expect(siguienteIntervaloMs(Number.MAX_SAFE_INTEGER)).toBe(SONDEO_MAX_MS);
  });
});

describe("idsNuevos", () => {
  it("la primera consulta (sin linea base) no marca nada como nuevo", () => {
    expect(idsNuevos(null, ["a", "b"])).toEqual([]);
  });
  it("devuelve solo los ids que no estaban", () => {
    expect(idsNuevos(new Set(["a", "b"]), ["b", "c", "d"])).toEqual(["c", "d"]);
    expect(idsNuevos(new Set(["a"]), [])).toEqual([]);
  });
});

describe("etiquetas de tiempo", () => {
  const T0 = Date.parse("2026-10-02T12:00:00Z");
  it("etiquetaActualizado", () => {
    expect(etiquetaActualizado(null, T0)).toBe("Sin actualizar todavía");
    expect(etiquetaActualizado(T0 - 2_000, T0)).toBe("Actualizado ahora");
    expect(etiquetaActualizado(T0 - 12_000, T0)).toBe("Actualizado hace 12 s");
    expect(etiquetaActualizado(T0 - 185_000, T0)).toBe("Actualizado hace 3 min");
    expect(etiquetaActualizado(T0 + 5_000, T0)).toBe("Actualizado ahora"); // reloj adelantado: nunca negativo
  });
  it("faltaPara cruza horas y dias", () => {
    const en = (min: number) => new Date(T0 + min * 60_000).toISOString();
    expect(faltaPara(en(40), T0)).toBe("en 40 min");
    expect(faltaPara(en(60), T0)).toBe("en 1 h");
    expect(faltaPara(en(135), T0)).toBe("en 2 h 15 min");
    expect(faltaPara(en(26 * 60), T0)).toBe("en 1 d 2 h");
    expect(faltaPara(en(0), T0)).toBe("ya es la hora");
    expect(faltaPara(en(-90), T0)).toBe("ya es la hora");
    expect(faltaPara(null, T0)).toBeNull();
    expect(faltaPara("no-es-fecha", T0)).toBeNull();
  });
});

describe("preferencia de sonido", () => {
  it("se guarda por organizacion y sucursal", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(leerSonido(storage, "demo", "p1")).toBe(false);
    guardarSonido(storage, "demo", "p1", true);
    expect(leerSonido(storage, "demo", "p1")).toBe(true);
    expect(leerSonido(storage, "demo", "p2")).toBe(false);
    guardarSonido(storage, "demo", "p1", false);
    expect(leerSonido(storage, "demo", "p1")).toBe(false);
  });
  it("sin almacenamiento o con almacenamiento que lanza, no rompe", () => {
    const roto = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(leerSonido(null, "demo", "p1")).toBe(false);
    expect(leerSonido(roto, "demo", "p1")).toBe(false);
    expect(() => guardarSonido(roto, "demo", "p1", true)).not.toThrow();
    expect(() => guardarSonido(null, "demo", "p1", true)).not.toThrow();
  });
});
