import { describe, expect, it } from "vitest";
import { VERTICALS, isVertical } from "../src/index.ts";

describe("isVertical", () => {
  it("acepta exactamente las 5 verticales de esta fase", () => {
    expect(VERTICALS).toEqual(["hoteles", "restaurantes", "rentas", "licitaciones", "citas"]);
    for (const v of VERTICALS) {
      expect(isVertical(v)).toBe(true);
    }
  });

  it("rechaza 'despachos' (excluida a propósito, ver comentario de types.ts) y cualquier string arbitrario", () => {
    expect(isVertical("despachos")).toBe(false);
    expect(isVertical("otra-cosa")).toBe(false);
    expect(isVertical("")).toBe(false);
  });
});
