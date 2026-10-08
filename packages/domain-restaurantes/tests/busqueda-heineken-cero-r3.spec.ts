// QA-PM-R3-reglas-07 (P2): "Heineken cero" / "cero alcohol" no encontraba Heineken 0.0 (RW19 fallaba en 1 de 3 corridas). Todas las formas de decirlo son el mismo token.
import { describe, expect, it } from "vitest";
import { matchesProductSearch, tokenizeForProductSearch } from "../src/product-search.ts";

const heineken00 = { name: "Heineken 0.0", description: null, categoryName: "Cervezas", searchKeywords: [] as string[] };
const sol = { name: "Sol", description: null, categoryName: "Cervezas", searchKeywords: [] as string[] };

describe("Heineken 0.0 en todas sus formas", () => {
  it.each(["heineken cero", "heineken cero alcohol", "heineken 0.0", "heineken 0,0", "heineken cero punto cero", "una heineken cero cero", "Heineken CERO"])("%s", (q) => {
    const tokens = tokenizeForProductSearch(q);
    expect(matchesProductSearch(tokens, heineken00)).toBe(true);
    expect(matchesProductSearch(tokens, sol)).toBe(false);
  });
  it("una cerveza normal no se confunde con la 0.0", () => {
    expect(matchesProductSearch(tokenizeForProductSearch("heineken"), heineken00)).toBe(true);
    expect(matchesProductSearch(tokenizeForProductSearch("sol"), heineken00)).toBe(false);
  });
});
