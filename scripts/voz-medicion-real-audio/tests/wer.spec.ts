import { describe, expect, it } from "vitest";
import { erroresNumeros, erroresTerminos, esDireccion, normalizar, wer } from "../wer.ts";

describe("normalizar", () => {
  it("quita tildes y signos, y pasa numeros en letra a cifras", () => {
    expect(normalizar("Tres tacos de pastor, ¡por favor!")).toEqual(["3", "tacos", "de", "pastor", "por", "favor"]);
    expect(normalizar("calle treinta y dos numero trescientos cuarenta y cinco")).toEqual(["calle", "32", "numero", "345"]);
    expect(normalizar("$1,200 a las 12:30")).toEqual(["1200", "a", "las", "12", "30"]);
  });
  it("cifras separadas por la gramatica: cruzamientos", () => { expect(normalizar("por veinte y veintidos")).toEqual(["por", "20", "22"]); });
});

describe("wer", () => {
  it("0 si es igual y cuenta S/D/I", () => {
    expect(wer(["a", "b", "c"], ["a", "b", "c"])).toMatchObject({ wer: 0, n: 3 });
    expect(wer(["a", "b", "c"], ["a", "x", "c"])).toMatchObject({ sustituciones: 1, borrados: 0, insertados: 0 });
    expect(wer(["a", "b", "c"], ["a", "c"])).toMatchObject({ borrados: 1 });
    expect(wer(["a", "c"], ["a", "b", "c"])).toMatchObject({ insertados: 1 });
    expect(wer(["a", "b"], ["x", "y", "z"]).wer).toBeCloseTo(1.5);
  });
  it("referencia vacia: wer null", () => { expect(wer([], ["a"]).wer).toBeNull(); });
  it("cifra vs letra no cuenta como error tras normalizar", () => {
    expect(wer(normalizar("treinta y dos tacos"), normalizar("32 tacos")).wer).toBe(0);
  });
});

describe("erroresNumeros", () => {
  it("cuenta cifras de la referencia ausentes en la hipotesis (multiconjunto)", () => {
    expect(erroresNumeros(["calle", "32", "345"], ["calle", "32", "354"])).toMatchObject({ n: 2, errores: 1, faltantes: ["345"] });
    expect(erroresNumeros(["2", "2"], ["2"])).toMatchObject({ n: 2, errores: 1 });
    expect(erroresNumeros(["hola"], ["hola"])).toMatchObject({ n: 0, errores: 0 });
  });
});

describe("erroresTerminos", () => {
  const vocab = ["Gringa de Pastor", "Alambre", "Horchata"];
  it("detecta el termino del menu dicho y mal transcrito", () => {
    const r = erroresTerminos("quiero un alambre y una horchata", "quiero un alambre y una orchata", vocab);
    expect(r.n).toBe(2); expect(r.errores).toBe(1); expect(r.faltantes).toEqual(["horchata"]);
  });
  it("palabras significativas de nombres compuestos", () => { expect(erroresTerminos("una gringa", "una gringa", vocab)).toMatchObject({ n: 1, errores: 0 }); });
  it("lo que el cliente no dijo no cuenta", () => { expect(erroresTerminos("hola", "ola", vocab).n).toBe(0); });
});

describe("esDireccion", () => {
  it("reconoce turnos de direccion", () => {
    expect(esDireccion("calle treinta y dos por veinte y veintidos colonia Garcia Lavin")).toBe(true);
    expect(esDireccion("tres tacos de pastor")).toBe(false);
  });
});
