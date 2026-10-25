// @vitest-environment jsdom
//
// ds3 / 0.2: `DISENO_DS3` se lee UNA vez al cargar el modulo. Fuentes: `html.dataset.diseno` (lo pone /theme-boot.js) y el valor
// de build VITE_DISENO_DEFAULT (vacio = diseno actual).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function cargar() {
  vi.resetModules();
  return import("../src/lib/diseno");
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-diseno");
});

afterEach(() => {
  document.documentElement.removeAttribute("data-diseno");
});

describe("DISENO_DS3", () => {
  it("apagada por defecto: sin atributo y sin valor de build", async () => {
    const m = await cargar();
    expect(m.DISENO_DS3).toBe(false);
    expect(m.disenoPorDefecto()).toBe("");
  });

  it("se enciende con html[data-diseno=ds3]", async () => {
    document.documentElement.dataset.diseno = "ds3";
    const m = await cargar();
    expect(m.DISENO_DS3).toBe(true);
  });

  it("un valor distinto de ds3 no la enciende", async () => {
    document.documentElement.dataset.diseno = "otro";
    const m = await cargar();
    expect(m.DISENO_DS3).toBe(false);
  });

  it("regla pura: el atributo o el valor de build ds3 la encienden (con espacios sobrantes tambien); cualquier otro valor no", async () => {
    const m = await cargar();
    expect(m.resolverDisenoDs3(undefined, "")).toBe(false);
    expect(m.resolverDisenoDs3("ds3", "")).toBe(true);
    expect(m.resolverDisenoDs3(undefined, " ds3 ")).toBe(true);
    expect(m.resolverDisenoDs3("otro", "otro")).toBe(false);
    expect(m.resolverDisenoDs3("off", "")).toBe(false);
  });

  it("se lee una sola vez: cambiar el atributo despues no la mueve, leerDisenoDs3() si refleja el estado actual", async () => {
    const m = await cargar();
    expect(m.DISENO_DS3).toBe(false);
    document.documentElement.dataset.diseno = "ds3";
    expect(m.DISENO_DS3).toBe(false);
    expect(m.leerDisenoDs3()).toBe(true);
  });
});
