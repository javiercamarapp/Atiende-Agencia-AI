import { describe, expect, it } from "vitest";
import { runDataChatTurn } from "../../src/data-chat/engine.js";
import { scriptedCompletion } from "../../src/data-chat/scripted-llm.js";
import type { DataChatToolResult } from "../../src/data-chat/types.js";
import { MemoryAudit, NOW, SALES_COLUMNS, SCOPE_A, catalogOf, salesTool } from "./support.js";

async function responder(resultado: Partial<DataChatToolResult>) {
  const llm = scriptedCompletion([
    { toolCalls: [{ name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "esta_semana" }) }] },
    { text: "Vendiste $2,480.50 MXN." },
  ]);
  const tool = salesTool({
    run: async () => ({
      status: "ok",
      source: "Pedidos",
      scopeLabel: "todas tus sucursales",
      columns: SALES_COLUMNS,
      rows: [
        { dia: "2026-09-28", ventas: 1500.5, pedidos: 12 },
        { dia: "2026-09-29", ventas: 980, pedidos: 8 },
      ],
      ...resultado,
    }),
  });
  return runDataChatTurn({ catalog: catalogOf(tool), scope: SCOPE_A, question: "¿Cuánto vendí esta semana?", complete: llm.complete, audit: new MemoryAudit(), now: NOW });
}

describe("bloques visuales del catalogo (cambio aditivo)", () => {
  it("reenvia el chart donut/kpi y la mini serie de la herramienta al bloque", async () => {
    const a = await responder({
      chart: { kind: "donut", x: "dia", y: "ventas" },
      sparkline: { label: "Tendencia", series: [[1, 2, 3], [3, 2, 1]] },
    });
    expect(a.blocks[0]!.chart).toEqual({ kind: "donut", x: "dia", y: "ventas" });
    expect(a.blocks[0]!.sparkline).toEqual({ label: "Tendencia", series: [[1, 2, 3], [3, 2, 1]] });
  });

  it("sin sparkline el bloque conserva exactamente la forma anterior (sin clave nueva)", async () => {
    const a = await responder({ chart: { kind: "bar", x: "dia", y: "ventas" } });
    expect("sparkline" in a.blocks[0]!).toBe(false);
  });
});
