// «x de y fuentes» por respuesta: el motor reporta en `coverage` las consultas DISTINTAS que corrieron en el turno y cuantas trajeron
// filas. Es lo que sabe porque las ejecuto (nunca una estimacion); sin consultas (fuera de catalogo, aclaracion) no se reporta nada.
import { describe, expect, it } from "vitest";
import { runDataChatTurn } from "../../src/data-chat/engine.js";
import { scriptedCompletion, type ScriptStep } from "../../src/data-chat/scripted-llm.js";
import type { DataChatTool } from "../../src/data-chat/types.js";
import { MemoryAudit, NOW, SCOPE_A, catalogOf, salesTool } from "./support.js";

const conNombre = (t: DataChatTool, name: string): DataChatTool => ({ ...t, name, label: name });
const VENTAS = { name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "esta_semana" }) };
const VACIA = { name: "ventas_vacias", argumentsJson: JSON.stringify({ periodo: "esta_semana" }) };

function correr(steps: ScriptStep[], tools: DataChatTool[]) {
  const llm = scriptedCompletion(steps);
  return runDataChatTurn({ catalog: catalogOf(...tools), scope: SCOPE_A, question: "¿Cuánto vendí esta semana?", complete: llm.complete, audit: new MemoryAudit(), now: NOW });
}

describe("cobertura de fuentes por respuesta", () => {
  it("dos consultas, una con filas y otra vacia: 1 de 2", async () => {
    const a = await correr([{ toolCalls: [VENTAS, VACIA] }, { text: "Vendiste $2,480.50 MXN en 20 pedidos." }], [salesTool(), conNombre(salesTool({ rows: [] }), "ventas_vacias")]);
    expect(a.status).toBe("ok");
    expect(a.coverage).toEqual({ consulted: 2, withData: 1 });
  });

  it("la misma consulta dos veces cuenta como UNA fuente", async () => {
    const otra = { name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "este_mes" }) };
    const a = await correr([{ toolCalls: [VENTAS, otra] }, { text: "Vendiste $2,480.50 MXN en 20 pedidos." }], [salesTool()]);
    expect(a.coverage).toEqual({ consulted: 1, withData: 1 });
  });

  it("sin datos (no_data): 0 de 1", async () => {
    const a = await correr([{ toolCalls: [VACIA] }, { text: "No hubo ventas." }], [conNombre(salesTool({ rows: [] }), "ventas_vacias")]);
    expect(a.status).toBe("no_data");
    expect(a.coverage).toEqual({ consulted: 1, withData: 0 });
  });

  it("sin consultas (fuera de catalogo): sin cobertura", async () => {
    const a = await correr([{ text: "No sé de eso." }, { text: "No sé de eso." }], [salesTool()]);
    expect(a.status).toBe("out_of_catalog");
    expect(a.coverage).toBeUndefined();
  });
});
