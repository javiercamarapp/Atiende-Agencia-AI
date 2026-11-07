// i18n ES/EN: el trinquete no confunde con texto las listas de clases utilitarias ni el nombre de la marca.
import { describe, expect, it } from "vitest";
import { detectar, esListaDeClases } from "../../../scripts/i18n-guard/detector.ts";

describe("detector: clases y marca", () => {
  it("una lista de clases no es texto; una frase si", () => {
    expect(esListaDeClases("group-[.toast]:text-sm group-[.toast]:font-semibold")).toBe(true);
    expect(esListaDeClases("mt-0.5 text-xs")).toBe(true);
    expect(esListaDeClases("Sin datos aún")).toBe(false);
    expect(esListaDeClases("ver ficha")).toBe(false);
  });

  it("no cuenta clases en una prop visible ni la marca", () => {
    expect(detectar(`const o = { description: "group-[.toast]:text-xs group-[.toast]:leading-snug" };\nconst m = <span>atiende</span>;`, "x.tsx")).toEqual([]);
  });
});
