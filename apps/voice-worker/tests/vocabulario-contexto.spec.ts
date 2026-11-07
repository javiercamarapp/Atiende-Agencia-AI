// El worker lee `vocabulario` del contexto de la API de forma defensiva (hasta 50 textos cortos).
import { describe, expect, it } from "vitest";
import { leerReglasCondicionales, leerVocabulario } from "../src/api-cliente.ts";

describe("leerVocabulario", () => {
  it("acepta textos, descarta lo que no lo es y topa en 50", () => {
    expect(leerVocabulario(["gringas", 3, "", "  ", null, "x".repeat(61), "alambre"])).toEqual(["gringas", "alambre"]);
    expect(leerVocabulario(Array.from({ length: 80 }, (_, i) => `p${i}`))).toHaveLength(50);
    expect(leerVocabulario(undefined)).toEqual([]);
    expect(leerVocabulario("gringas")).toEqual([]);
  });
});

describe("leerReglasCondicionales (dieta del prompt de voz)", () => {
  const ok = { id: "kilos", patron: "kilo|cuarto", texto: "- KILOS: un renglon por presentacion." };
  it("acepta reglas bien formadas y descarta las demas sin tumbar la llamada", () => {
    expect(leerReglasCondicionales([ok, { id: "Mal Id", patron: "x", texto: "y" }, { id: "rota", patron: "(", texto: "z" }, { id: "larga", patron: "x".repeat(401), texto: "t" }, { id: "sin_texto", patron: "x", texto: "" }, 7, null])).toEqual([ok]);
  });
  it("API vieja (sin el campo) o forma invalida: sin reglas", () => {
    expect(leerReglasCondicionales(undefined)).toEqual([]);
    expect(leerReglasCondicionales({ kilos: ok })).toEqual([]);
  });
  it("tope de 40 reglas y sin ids repetidos", () => {
    expect(leerReglasCondicionales(Array.from({ length: 60 }, (_, i) => ({ ...ok, id: `r${i}` })))).toHaveLength(40);
    expect(leerReglasCondicionales([ok, { ...ok, texto: "- otra" }])).toEqual([ok]);
  });
});
