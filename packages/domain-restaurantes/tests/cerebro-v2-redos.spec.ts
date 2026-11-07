// CodeQL js/polynomial-redos (#718, alertas 119/127/128): salud.ts (limpieza de la nota sin negaciones y corte de cláusulas «me cae mal») y prompt-v2.ts
// (recorte R7 del pedido grande). Arreglo sin cambiar comportamiento: misma salida que la versión anterior en un corpus normal y una entrada patológica de
// 50k caracteres termina en menos de 50 ms.
import { describe, expect, it } from "vitest";
import { sinClausulasCaeMal, textoDeclaradoSinNegaciones } from "../src/whatsapp/cerebro-v2/salud.ts";
import { adaptarPromptPmV2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { PM_CONFIG_POR_OMISION, buildSystemPrompt } from "../src/whatsapp/llm-turn-handler.ts";

const ms = (f: () => unknown) => {
  f();
  const t = performance.now();
  f();
  return performance.now() - t;
};

// Versión anterior (referencia de comportamiento) del corte de cláusulas.
const PREFERENCIA = (c: string) => sinClausulasCaeMal(c) === "";
const anterior = (texto: string) =>
  String(texto ?? "").split(/[,;.!?\n]+|\s+(?:y|e|pero)\s+/i).map((c) => c.trim()).filter((c) => c && !PREFERENCIA(c)).join(", ");

const CORPUS = [
  "me cae mal el cerdo y a mi hijo la nuez lo pone malito",
  "Me cae mal el cerdo pero  sin cebolla porfa",
  "dos tacos de pastor, sin cebolla\ny una coca",
  "soy alérgica al cacahuate Y a la nuez",
  "no tengo alergias, mis papás sí: al camarón",
  "el pollo e   hígado me caen pesados; quiero 3 gringas",
  "",
];

describe("redos: entradas patológicas de 50k caracteres en menos de 50 ms", () => {
  it("sinClausulasCaeMal (separadores « y » / « pero » con espacios repetidos)", () => {
    for (const p of [" ".repeat(50_000), `a${" ".repeat(50_000)}x`, `${" y".repeat(25_000)}`, `\t`.repeat(50_000)]) expect(ms(() => sinClausulasCaeMal(p))).toBeLessThan(50);
  });
  it("textoDeclaradoSinNegaciones (limpieza de espacios antes de un signo)", () => {
    for (const p of [`no soy alérgico${" ".repeat(50_000)}x`, `no tengo alergia${" ".repeat(25_000)},${" ".repeat(25_000)}.`]) expect(ms(() => textoDeclaradoSinNegaciones(p))).toBeLessThan(50);
  });
  it("adaptarPromptPmV2 (recorte R7 con « Pedido grande (» repetido)", () => {
    const p = " Pedido grande (".repeat(Math.ceil(50_000 / 16));
    expect(ms(() => adaptarPromptPmV2(p))).toBeLessThan(50);
  });
});

describe("redos: mismo comportamiento que antes", () => {
  it("sinClausulasCaeMal da lo mismo que la versión anterior en el corpus", () => {
    // `anterior` usa la función nueva solo para decidir si una cláusula es preferencia (el filtro no cambió).
    for (const t of CORPUS) expect(sinClausulasCaeMal(t)).toBe(anterior(t));
  });
  it("el recorte R7 sigue quitando el párrafo de pedido grande del prompt real y nada más", () => {
    const base = buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, new Date("2026-10-06T13:00:00-06:00"), null, "", "", false, true);
    const v2 = adaptarPromptPmV2(base);
    expect(v2).not.toContain("NO llame escalar_a_humano con motivo pedido_grande");
    expect(v2).toContain("Una cantidad exagerada");
    expect(base.length - v2.length).toBe(3955);
  });
  it("textoDeclaradoSinNegaciones conserva la cita sin la negación", () => {
    expect(textoDeclaradoSinNegaciones("No tengo alergia al cacahuate , pero sí al camarón")).toBe(textoDeclaradoSinNegaciones("No tengo alergia al cacahuate, pero sí al camarón"));
  });
});
