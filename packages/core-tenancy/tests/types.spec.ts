import { describe, expect, it } from "vitest";
import { VERTICALS, isVertical } from "../src/index.ts";

describe("isVertical", () => {
  it("acepta exactamente las 6 verticales (despachos incorporada en su propia Fase 1, ver packages/domain-despachos/)", () => {
    expect(VERTICALS).toEqual(["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"]);
    for (const v of VERTICALS) {
      expect(isVertical(v)).toBe(true);
    }
  });

  it("rechaza cualquier string arbitrario que no sea una vertical soportada", () => {
    expect(isVertical("otra-cosa")).toBe(false);
    expect(isVertical("")).toBe(false);
  });
});
