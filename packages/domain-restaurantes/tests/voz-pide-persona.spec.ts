// Regresion QA-restaurantes-R1-agentes-14 (pedir una persona de viva voz escala de forma determinista aunque el modelo lo ignore), contra el simulador de voz es-MX (proveedor FALSO guionado, nucleo real de voice-core).
import { describe, expect, it } from "vitest";
import { correrGuion } from "../src/voz/simulador/correr-guion.ts";
import { evaluarLlamada } from "../src/voz/simulador/graders-voz.ts";
import { evaluarPersonaVoz, MOTIVO_PERSONA_VOZ, TEXTO_PERSONA_VOZ } from "../src/voz/guardia-persona.ts";
import type { GuionLlamada, PasoAgente } from "../src/voz/simulador/tipos.ts";

const dice = (texto: string): PasoAgente => ({ dice: texto });

async function correr(g: GuionLlamada) {
  const llamada = await correrGuion(g);
  const fallos = (await evaluarLlamada(llamada)).filter((r) => !r.ok);
  return { llamada, fallos };
}

describe("agentes-14 (simulador de voz es-MX)", () => {
  it("14 'quiero hablar con una persona' DICHO en la llamada y el modelo lo ignora: callback cliente_lo_pide y la llamada cierra como escalada", async () => {
    const { llamada, fallos } = await correr({
      id: "VQA-pide-humano-hablado",
      titulo: "pide humano de viva voz",
      rasgos: ["pide hablar con humano"],
      turnos: [
        { kind: "voz", cliente: "No quiero hablar con una máquina, comuníqueme con una persona por favor", agente: [dice("Con gusto le ayudo yo. ¿Qué le preparamos hoy?")] },
        { kind: "voz", cliente: "¡Que quiero hablar con un humano!", agente: [dice("Entiendo. ¿Qué le gustaría ordenar?")] },
      ],
      esperado: { resultado: "escalado", sinPedido: true, callbacks: ["escalada:cliente_lo_pide"] },
    });
    expect(fallos).toEqual([]);
    expect(llamada.mundo.callbacks.map((c) => c.reason)).toEqual(["escalada:cliente_lo_pide"]);
    // La guardia dijo su texto TAL CUAL antes de que el modelo contestara.
    expect(llamada.textosGuardia).toEqual([TEXTO_PERSONA_VOZ]);
  });

  it("14 variantes habladas ('pásame', 'páseme', 'comuníqueme', 'quiero un humano') se detectan; una frase de pedido normal no", () => {
    for (const t of ["comuníqueme con una persona", "pásame con un humano", "páseme con el gerente", "quiero hablar con alguien", "quiero un humano", "conécteme con un asesor"]) {
      expect(evaluarPersonaVoz(t), t).not.toBeNull();
    }
    for (const t of ["quiero seis tacos de bistec", "hablo desde el centro", "sí, a nombre de Juan Pérez"]) expect(evaluarPersonaVoz(t), t).toBeNull();
  });

  it("14 con un motivo mas especifico en la misma frase se escala con ese motivo", () => {
    expect(evaluarPersonaVoz("tengo una queja del pedido, quiero hablar con el gerente")?.motivo).toBe("queja");
    expect(evaluarPersonaVoz("quiero una persona")?.motivo).toBe(MOTIVO_PERSONA_VOZ);
  });
});
