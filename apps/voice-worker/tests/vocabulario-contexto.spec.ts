// El worker lee `vocabulario` del contexto de la API de forma defensiva (hasta 50 textos cortos).
import { describe, expect, it } from "vitest";
import { leerVocabulario } from "../src/api-cliente.ts";

describe("leerVocabulario", () => {
  it("acepta textos, descarta lo que no lo es y topa en 50", () => {
    expect(leerVocabulario(["gringas", 3, "", "  ", null, "x".repeat(61), "alambre"])).toEqual(["gringas", "alambre"]);
    expect(leerVocabulario(Array.from({ length: 80 }, (_, i) => `p${i}`))).toHaveLength(50);
    expect(leerVocabulario(undefined)).toEqual([]);
    expect(leerVocabulario("gringas")).toEqual([]);
  });
});
