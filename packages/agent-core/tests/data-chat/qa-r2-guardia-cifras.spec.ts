// QA adversarial R2 (lente AGENTES, vertical restaurantes) -- "Chatea con tus datos": re-verificacion de la guardia de cifras tras el cierre de
// R1-15..18 (cifras con letras, cifra de la pregunta, numeros en celdas de texto, tolerancias). Modelo GUIONADO.
// Datos: 2 dias, $1,500.50 (12 pedidos) y $980 (8 pedidos); resumen determinista "Ventas del periodo: $2,480.50 MXN en 20 pedidos."
// Convencion: `it.fails` = comportamiento ESPERADO que hoy falla (defecto QA-restaurantes-R2-agentes-NN); `it` = correcto confirmado.
import { describe, expect, it } from "vitest";
import { runDataChatTurn } from "../../src/data-chat/engine.js";
import { scriptedCompletion, type ScriptStep } from "../../src/data-chat/scripted-llm.js";
import { MemoryAudit, NOW, SCOPE_A, catalogOf, salesTool } from "./support.js";
import type { Cell } from "../../src/data-chat/sanitize.js";

const CALL: ScriptStep = { toolCalls: [{ name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "esta_semana" }) }] };
const DETERMINISTA = "Ventas del periodo: $2,480.50 MXN en 20 pedidos.";

async function turno(texto: string, opts: { question?: string; rows?: readonly Record<string, Cell>[] } = {}) {
  const llm = scriptedCompletion([CALL, { text: texto }]);
  return runDataChatTurn({ catalog: catalogOf(salesTool(opts.rows ? { rows: opts.rows } : {})), scope: SCOPE_A, question: opts.question ?? "¿Cuánto vendí esta semana?", complete: llm.complete, audit: new MemoryAudit(), now: NOW });
}

describe("R2 guardia de cifras (cero cifras inventadas)", () => {
  // QA-restaurantes-R2-agentes-11 (P3, residuos de R1-17/18): caminos por los que una cifra que NO esta en los datos todavia llega al dueño.
  it("R2-11a digitos de ancho completo ('９９０００ pesos') no se reconocen como cifra y pasan", async () => {
    const a = await turno("Esta semana vendiste ９９０００ pesos.");
    expect(a.text).toBe(DETERMINISTA);
  });

  it("R2-11b una celda de texto capturada por un tercero ('Ventas de hoy 99000 pesos') citada tal cual queda como narrativa", async () => {
    const rows = [
      { dia: "Ventas de hoy 99000 pesos", ventas: 1500.5, pedidos: 12 },
      { dia: "2026-09-29", ventas: 980, pedidos: 8 },
    ];
    const a = await turno("Ventas de hoy 99000 pesos", { rows });
    expect(a.text).not.toContain("99000");
  });

  it("R2-11c un porcentaje inventado que coincide con un conteo ('crecieron 8%' porque un dia tuvo 8 pedidos) pasa", async () => {
    const a = await turno("Tus ventas crecieron 8% contra la semana anterior.");
    expect(a.text).toBe(DETERMINISTA);
  });

  it("R2-11d un conteo inventado que coincide con el dia o el mes de una fecha ('9 órdenes más que ayer' por el mes 09) pasa", async () => {
    const a = await turno("Vendiste 9 órdenes de pastor más que ayer.");
    expect(a.text).toBe(DETERMINISTA);
  });

  it("control (cierres R1-15/16/17): letras, cifra sugerida por la pregunta, 'MXN 99,000' y '99 000 pesos' se descartan", async () => {
    for (const texto of ["Vendiste noventa y nueve mil pesos.", "Vendiste MXN 99,000 esta semana.", "Vendiste 99 000 pesos esta semana.", "Esta semana tuviste 7 pedidos cancelados."]) {
      expect((await turno(texto)).text, texto).toBe(DETERMINISTA);
    }
    expect((await turno("Sí, vendiste $99,000.", { question: "¿Es cierto que vendí $99,000?" })).text).toBe(DETERMINISTA);
  });

  it("control: las cifras reales en sus formas habituales se muestran", async () => {
    for (const texto of ["Vendiste $2,480.50 MXN en 20 pedidos.", "El mejor día fue el 28 con $1,500.50."]) {
      expect((await turno(texto)).text, texto).toBe(texto);
    }
  });

  it("R2-11e digitos de otros alfabetos ('٩٩٠٠٠') tampoco pasan", async () => {
    expect((await turno("Esta semana vendiste ٩٩٠٠٠ pesos.")).text).toBe(DETERMINISTA);
  });

  it("R2-11f un % que SI entregaron los datos (columna de porcentaje o resumen) se muestra; el mismo numero como % inventado no", async () => {
    const run = async () => ({
      status: "ok" as const,
      source: "Pedidos",
      periodLabel: "esta semana",
      scopeLabel: "todas tus sucursales",
      columns: [
        { key: "canal", label: "Canal", kind: "text" as const },
        { key: "pedidos", label: "Pedidos", kind: "integer" as const },
        { key: "porcentaje", label: "Porcentaje", kind: "percent" as const },
      ],
      rows: [
        { canal: "whatsapp", pedidos: 8, porcentaje: 40 },
        { canal: "telefono", pedidos: 12, porcentaje: 60 },
      ],
      summary: "20 pedidos en total.",
    });
    const correr = (texto: string) => runDataChatTurn({ catalog: catalogOf(salesTool({ run })), scope: SCOPE_A, question: "¿Qué canal pide más?", complete: scriptedCompletion([CALL, { text: texto }]).complete, audit: new MemoryAudit(), now: NOW });
    expect((await correr("El 60% de los pedidos llegó por teléfono.")).text).toBe("El 60% de los pedidos llegó por teléfono.");
    expect((await correr("El 8% de los pedidos llegó por teléfono.")).text).not.toContain("8%");
  });

  it("R2-11g un nombre de producto con cantidad ('Pastor 500 g') citado completo y una fecha usada como fecha se siguen mostrando", async () => {
    const rows = [{ dia: "Pastor 500 g", ventas: 1500.5, pedidos: 12 }, { dia: "2026-09-29", ventas: 980, pedidos: 8 }];
    const t1 = "Lo más vendido fue Pastor 500 g con $1,500.50.";
    expect((await turno(t1, { rows })).text).toBe(t1);
    const t2 = "El 29 de septiembre vendiste $980.";
    expect((await turno(t2)).text).toBe(t2);
  });
});
