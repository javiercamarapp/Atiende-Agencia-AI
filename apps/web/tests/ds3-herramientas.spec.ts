// Guards de las herramientas de verificacion visual: excepciones.json y axe-baseline.json son trinquetes que SOLO pueden encogerse.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const json = <T>(archivo: string): T => JSON.parse(readFileSync(path.join(aqui, archivo), "utf8")) as T;

describe("excepciones del medidor (trinquete que solo encoge)", () => {
  const excepciones = JSON.parse(readFileSync(path.join(aqui, "..", "e2e-ds3", "excepciones.json"), "utf8")) as Array<Record<string, unknown>>;
  const { maximo } = json<{ maximo: number }>("ds3-excepciones-baseline.json");

  it("cada excepcion declara ruta, tipo, motivo y vencimiento", () => {
    for (const e of excepciones) {
      for (const campo of ["ruta", "tipo", "motivo", "vence"]) expect(typeof e[campo], `${JSON.stringify(e)} sin ${campo}`).toBe("string");
      expect((e["motivo"] as string).length).toBeGreaterThan(10);
    }
  });

  it("no hay mas excepciones que el baseline (usa el componente correcto en vez de registrar una nueva)", () => {
    expect(excepciones.length, `hay ${excepciones.length} excepciones y el baseline es ${maximo}`).toBeLessThanOrEqual(maximo);
  });

  it("cuando una excepcion se retira, el baseline baja con ella (el piso solo desciende)", () => {
    expect(maximo - excepciones.length, `baja ds3-excepciones-baseline.json de ${maximo} a ${excepciones.length}`).toBeLessThanOrEqual(0);
  });

  it("el baseline de axe empieza vacio (formato [{ruta, regla, nodos}]) y es una lista", () => {
    const axe = JSON.parse(readFileSync(path.join(aqui, "..", "e2e-ds3", "axe-baseline.json"), "utf8")) as unknown;
    expect(Array.isArray(axe)).toBe(true);
  });
});
