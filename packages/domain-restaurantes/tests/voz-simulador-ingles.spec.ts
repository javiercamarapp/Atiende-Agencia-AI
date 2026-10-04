// R-44 -- prueba ciega de voz con un llamante que habla ingles, contra el simulador local con el proveedor FALSO (mismo nucleo real:
// maquina de estados, ejecutor de herramientas, motor de pedidos). Que Gemini entienda ingles se prueba a mano (`evals:voz:real`).
import { describe, expect, it } from "vitest";
import { correrGuion } from "../src/voz/simulador/correr-guion.ts";
import { evaluarLlamadaEn } from "../src/voz/simulador/graders-voz.ts";
import { GUIONES_EN } from "../src/voz/simulador/guiones-en.ts";
import { instruccionVozPm } from "../src/voz/simulador/prompt-voz.ts";
import { COMPORTAMIENTO_VOZ_MAX, comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";

describe("prueba ciega en ingles de voz (proveedor falso)", () => {
  it("el set trae 3 guiones con ids unicos", () => {
    expect(GUIONES_EN).toHaveLength(3);
    expect(new Set(GUIONES_EN.map((g) => g.id)).size).toBe(3);
  });

  describe.each(GUIONES_EN.map((g) => [g.id, g] as const))("%s", (_id, guion) => {
    it("pasa todos los graders deterministas, incluido el de idioma", async () => {
      const llamada = await correrGuion(guion);
      const fallos = (await evaluarLlamadaEn(llamada)).filter((r) => !r.ok);
      expect(fallos, JSON.stringify(fallos)).toEqual([]);
    });
  });

  it("el grader de idioma rechaza a un agente que contesta en espanol a un llamante en ingles", async () => {
    const malo = { ...GUIONES_EN[2]!, turnos: [{ ...GUIONES_EN[2]!.turnos[0]!, agente: [{ dice: "Lamento mucho lo ocurrido. Voy a pasar su llamada con una persona del restaurante." }] }] } as (typeof GUIONES_EN)[number];
    const llamada = await correrGuion(malo);
    const resultados = await evaluarLlamadaEn(llamada);
    expect(resultados.find((r) => r.grader === "G_IDIOMA_EN")?.ok).toBe(false);
  });
});

describe("el comportamiento de voz le dice al modelo que conteste en el idioma del llamante", () => {
  const branches = [{ propertyId: "p1", slug: "fco-montejo", name: "Francisco de Montejo", address: null }];

  it("la instruccion del simulador y el comportamiento sembrado traen la regla de idioma y siguen cabiendo en el tope de 8000", () => {
    const instruccion = instruccionVozPm(branches, "lunes 18:30", "lunes", "fco-montejo");
    const sembrado = comportamientoVozPm({ businessName: PM_CONFIG_POR_OMISION.businessName, agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches });
    for (const texto of [instruccion, sembrado]) {
      expect(texto).toContain("si habla inglés, responda en inglés cortés");
      expect(texto).toContain("siguen en español");
    }
    expect(sembrado.length).toBeLessThanOrEqual(COMPORTAMIENTO_VOZ_MAX);
  });
});
