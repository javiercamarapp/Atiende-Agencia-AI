// PAQUETE A (PM): módulo de prompt (se enlaza después en perfil-pm.ts por el integrador). Sin LLM.
import { describe, expect, it } from "vitest";
import { PROMPT_PM_PAQUETE_A, construirPromptPaqueteA } from "../src/whatsapp/prompt-pm-paquete-a.ts";

describe("prompt PM paquete A", () => {
  const t = construirPromptPaqueteA();
  it("exporta el mismo texto por constante y por función", () => {
    expect(PROMPT_PM_PAQUETE_A).toBe(t);
  });
  it("unidades de la orden", () => {
    expect(t).toMatch(/bistec, chuleta, arrachera y pollo[^.]*3 tacos/i);
    expect(t).toMatch(/pastor[^.]*individual/i);
    expect(t).toMatch(/gringas[^.]*2/i);
    expect(t).toMatch(/Quesobich[^.]*UNA pieza[^.]*sin tortilla ni totopos[^.]*salsa y cebolla/i);
    expect(t).toMatch(/alitas[^.]*7/i);
    expect(t).toMatch(/crujientes[^.]*aproximadamente 12/i);
    expect(t).toMatch(/flauta[^.]*UNA/i);
  });
  it("variantes que debe preguntar", () => {
    expect(t).toMatch(/harina, maíz o mixta/i);
    expect(t).toMatch(/frijol con tostada o frijoles charros/i);
    expect(t).toMatch(/cambray[^.]*preparada o natural/i);
    expect(t).toMatch(/piña[^.]*gratis[^.]*pregunt/i);
  });
  it("salsas: incluidas vs solo bajo petición, extra $19", () => {
    expect(t).toMatch(/roja, verde, cebolla con cilantro y limones/i);
    expect(t).toMatch(/habanero, crema de ajo y guacamolera[^.]*solo si el cliente las pide/i);
    expect(t).toMatch(/\$19/);
  });
  it("desambigua orden, kilo y pieza", () => {
    expect(t).toMatch(/orden[^.]*kilo[^.]*pieza/i);
    expect(t).toMatch(/medio de pastor/i);
  });
  it("no inventa precios: solo $19 y consulte la sucursal", () => {
    const montos = [...t.matchAll(/\$\s?\d[\d,]*/g)].map((m) => m[0].replace(/\s/g, ""));
    expect(new Set(montos)).toEqual(new Set(["$19"]));
    expect(t).toMatch(/consulte la sucursal/i);
  });
  it("recurrente: solo con dato real, sin inventar historial", () => {
    expect(t).toMatch(/lo de siempre/i);
    expect(t).toMatch(/nunca invente historial/i);
  });
  it("no menciona datos personales ni nombres reales", () => {
    expect(t).not.toMatch(/\b\d{10}\b/);
    expect(t).not.toMatch(/@/);
  });
});
