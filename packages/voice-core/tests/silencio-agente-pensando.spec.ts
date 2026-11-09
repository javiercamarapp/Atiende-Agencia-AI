// E2E r3 (7-nov-2026): el reloj de silencio del cliente seguia corriendo mientras el AGENTE preparaba su respuesta (LLM + herramientas, 7-13 s tras el «sí»).
// La maquina decia «silencio_reprompt» encima del trabajo del agente y, con los asentimientos ignorados («sí, gracias» mientras piensa no reinicia el contador),
// a la tercera colgaba con «silencio_despedida» justo cuando el agente terminaba de leer el resumen: el pedido nunca se creaba. Regla: mientras el agente debe
// una respuesta (desde que el cliente dijo algo hasta que el agente termina o es interrumpido) el silencio NO es del cliente. Tope: con 20 s sin nada, vale de nuevo.
import { describe, expect, it } from "vitest";
import { CallStateMachine } from "../src/llamada/maquina.ts";

const REGLAS = { herramientaObjetivo: "crear_pedido", resultadoObjetivo: "pedido_creado", herramientaEscalar: "escalar_a_humano" } as const;
const nueva = () => {
  const m = new CallStateMachine(REGLAS);
  m.recibir({ tipo: "conectada" });
  m.recibir({ tipo: "agente_termina" });
  return m;
};

describe("silencio: no cuenta mientras el agente prepara su respuesta", () => {
  it("el cliente habla y el agente tarda 8-12 s (herramientas): ni reprompt ni despedida", () => {
    const m = nueva();
    m.recibir({ tipo: "usuario_dijo", inteligible: true });
    for (const ms of [7_000, 8_000, 9_000, 12_000]) expect(m.recibir({ tipo: "silencio", ms })).toEqual([]);
    expect(m.estadoActual).not.toBe("cerrada");
  });

  it("cuando el agente termina, el silencio del cliente vuelve a contar", () => {
    const m = nueva();
    m.recibir({ tipo: "usuario_dijo", inteligible: true });
    m.recibir({ tipo: "agente_termina" });
    expect(m.recibir({ tipo: "silencio", ms: 7_000 })).toEqual([{ tipo: "decir", mensaje: "silencio_reprompt" }]);
  });

  it("tope: si el agente no dice nada en 20 s, el silencio vuelve a valer (no se queda colgada para siempre)", () => {
    const m = nueva();
    m.recibir({ tipo: "usuario_dijo", inteligible: true });
    expect(m.recibir({ tipo: "silencio", ms: 20_000 })).toEqual([{ tipo: "decir", mensaje: "silencio_reprompt" }]);
  });

  it("sin respuesta pendiente (el cliente calla tras la pregunta del agente) se conserva el comportamiento: 2 reprompts y despedida", () => {
    const m = nueva();
    expect(m.recibir({ tipo: "silencio", ms: 7_000 })).toEqual([{ tipo: "decir", mensaje: "silencio_reprompt" }]);
    expect(m.recibir({ tipo: "silencio", ms: 7_000 })).toEqual([{ tipo: "decir", mensaje: "silencio_reprompt" }]);
    expect(m.recibir({ tipo: "silencio", ms: 7_000 }).some((a) => a.tipo === "colgar")).toBe(true);
  });
});
