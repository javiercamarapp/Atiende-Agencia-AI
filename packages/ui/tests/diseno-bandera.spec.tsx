// @vitest-environment jsdom
//
// (.tsx a proposito: el tsconfig raiz no tiene DOM y excluye los .tsx de packages/ui; el typecheck de la UI no incluye tests.)
// `DISENO_DS3` es `true` para todos; el unico interruptor es de build y de emergencia: VITE_DISENO_LEGADO=1 (apagado por omision).
import { afterEach, describe, expect, it, vi } from "vitest";

async function cargar() {
  vi.resetModules();
  return import("../src/lib/diseno.ts");
}

afterEach(() => {
  document.documentElement.removeAttribute("data-diseno");
});

describe("DISENO_DS3", () => {
  it("encendida por omision: sin atributo en <html> y sin valor de build", async () => {
    document.documentElement.removeAttribute("data-diseno");
    const m = await cargar();
    expect(m.DISENO_DS3).toBe(true);
    expect(m.leerDisenoDs3()).toBe(true);
    expect(m.disenoLegadoActivo()).toBe(false);
  });

  it("un atributo distinto en <html> no la apaga (el atributo ya no es fuente)", async () => {
    document.documentElement.dataset.diseno = "off";
    const m = await cargar();
    expect(m.DISENO_DS3).toBe(true);
  });

  it("regla pura del interruptor de emergencia VITE_DISENO_LEGADO: solo el valor exacto «1» (recortado) lo activa", async () => {
    const m = await cargar();
    expect(m.disenoLegadoActivo(undefined)).toBe(false);
    expect(m.disenoLegadoActivo("")).toBe(false);
    expect(m.disenoLegadoActivo("0")).toBe(false);
    expect(m.disenoLegadoActivo("true")).toBe(false);
    expect(m.disenoLegadoActivo(" 1 ")).toBe(true);
  });
});
