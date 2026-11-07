// Reglas condicionales del prompt de voz (dieta del prompt, 7-nov-2026): la instruccion lleva solo el nucleo y las reglas por tema llegan con la apertura.
// La cascada v2 las agrega a la conversacion cuando el cliente toca el tema; los escalones que no saben hacerlo (Gemini Live, cascada OpenRouter) las reciben
// TODAS dentro de la instruccion, asi que ninguna regla se pierde al caer de escalon. Sin red.
import { describe, expect, it } from "vitest";
import { crearEscaleraLlamada, instruccionConReglasFijas, normalizarParaReglas, reglasActivadas } from "../../src/index.ts";
import type { AperturaLlamada, EscalonLlamada, ManejadoresSesion, ReglaCondicional } from "../../src/index.ts";

const REGLAS: ReglaCondicional[] = [
  { id: "kilos", patron: String.raw`\bkilos?\b|cuarto`, texto: "- KILOS: un renglon por presentacion." },
  { id: "combo", patron: String.raw`nacho|martes`, texto: "- COMBO: aguas solo con orden completa." },
  { id: "rota", patron: "(", texto: "- nunca se activa: patron invalido" },
];

describe("reglasActivadas", () => {
  it("normaliza acentos y mayusculas del texto del cliente", () => {
    expect(normalizarParaReglas("¿Medio KILO y un Cuárto?")).toBe("¿medio kilo y un cuarto?");
    expect(reglasActivadas(REGLAS, "Un CUÁRTO de bistec", new Set()).map((r) => r.id)).toEqual(["kilos"]);
  });

  it("devuelve solo las nuevas: una regla ya activa no se repite", () => {
    expect(reglasActivadas(REGLAS, "un kilo y nachos", new Set(["kilos"]))).toEqual([{ id: "combo", texto: "- COMBO: aguas solo con orden completa." }]);
  });

  it("un patron invalido no truena: se ignora", () => {
    expect(reglasActivadas(REGLAS, "(", new Set())).toEqual([]);
  });

  it("sin reglas o sin texto no activa nada", () => {
    expect(reglasActivadas(undefined, "un kilo", new Set())).toEqual([]);
    expect(reglasActivadas(REGLAS, "   ", new Set())).toEqual([]);
  });
});

describe("instruccionConReglasFijas", () => {
  it("anexa TODAS las reglas por tema al final de la instruccion", () => {
    const i = instruccionConReglasFijas("Eres el agente.", REGLAS);
    expect(i.startsWith("Eres el agente.")).toBe(true);
    for (const r of REGLAS) expect(i).toContain(r.texto);
  });
  it("sin reglas deja la instruccion igual", () => {
    expect(instruccionConReglasFijas("Eres el agente.", undefined)).toBe("Eres el agente.");
    expect(instruccionConReglasFijas("Eres el agente.", [])).toBe("Eres el agente.");
  });
});

describe("escalera: quien no sabe de reglas condicionales las recibe en la instruccion", () => {
  function escalon(id: EscalonLlamada["id"]): EscalonLlamada & { aperturas: AperturaLlamada[] } {
    const aperturas: AperturaLlamada[] = [];
    return { id, aperturas, abrirSesion: async (a) => (aperturas.push(a), { enviarTexto: () => undefined, interrumpir: () => undefined, cerrar: async () => undefined }) };
  }
  const APERTURA: AperturaLlamada = { instruccion: "Eres el agente.", voiceId: "Kore", herramientas: [], reglasCondicionales: REGLAS };
  const H = { caido: () => undefined } as unknown as ManejadoresSesion;

  it("cascada v2: la instruccion sigue corta y las reglas viajan aparte", async () => {
    const v2 = escalon("cascada-v2");
    await crearEscaleraLlamada([v2]).abrirSesion(APERTURA, H);
    expect(v2.aperturas[0]!.instruccion).toBe("Eres el agente.");
    expect(v2.aperturas[0]!.reglasCondicionales).toEqual(REGLAS);
  });

  it.each(["gemini-3.8-live", "cascada-openrouter"] as const)("%s: recibe las reglas dentro de la instruccion", async (id) => {
    const e = escalon(id);
    await crearEscaleraLlamada([e]).abrirSesion(APERTURA, H);
    for (const r of REGLAS) expect(e.aperturas[0]!.instruccion).toContain(r.texto);
    expect(e.aperturas[0]!.reglasCondicionales).toBeUndefined();
  });
});
