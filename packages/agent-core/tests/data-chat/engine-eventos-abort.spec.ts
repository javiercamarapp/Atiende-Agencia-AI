// Transporte en vivo del motor: `onEvento` (pasos de herramienta) y `signal` (abort). Motor real con el guion de
// pruebas (`scriptedCompletion`): ni red ni gasto.
import { describe, expect, it } from "vitest";
import { DataChatAbortedError, isDataChatAbortedError, runDataChatTurn, type DataChatPasoEvento } from "../../src/data-chat/engine.js";
import { scriptedCompletion, type ScriptStep } from "../../src/data-chat/scripted-llm.js";
import { MemoryAudit, NOW, SCOPE_A, catalogOf, salesTool } from "./support.js";

const CALL: ScriptStep = { toolCalls: [{ name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "esta_semana" }) }] };

function base(steps: ScriptStep[]) {
  const llm = scriptedCompletion(steps);
  const audit = new MemoryAudit();
  return { llm, audit, common: { catalog: catalogOf(salesTool()), scope: SCOPE_A, question: "¿Cuánto vendí esta semana?", complete: llm.complete, audit, now: NOW } };
}

describe("runDataChatTurn — onEvento", () => {
  it("emite paso inicio y paso fin por herramienta, en orden, con solo el nombre del catalogo", async () => {
    const t = base([CALL, { text: "Vendiste $2,480.50 MXN en 20 pedidos." }]);
    const eventos: DataChatPasoEvento[] = [];
    const a = await runDataChatTurn({ ...t.common, onEvento: (e) => eventos.push(e) });
    expect(a.status).toBe("ok");
    expect(eventos).toEqual([
      { t: "paso", fase: "inicio", herramienta: "ventas_por_dia" },
      { t: "paso", fase: "fin", herramienta: "ventas_por_dia" },
    ]);
  });

  it("el paso inicio llega ANTES de que la herramienta termine y el fin DESPUES", async () => {
    const orden: string[] = [];
    const llm = scriptedCompletion([CALL, { text: "Vendiste $2,480.50 MXN en 20 pedidos." }]);
    const tool = salesTool({
      run: async () => {
        orden.push("herramienta");
        return { status: "empty", source: "Pedidos", scopeLabel: "", columns: [], rows: [] };
      },
    });
    await runDataChatTurn({ catalog: catalogOf(tool), scope: SCOPE_A, question: "x", complete: llm.complete, now: NOW, onEvento: (e) => orden.push(`${e.fase}`) });
    expect(orden).toEqual(["inicio", "herramienta", "fin"]);
  });

  it("una herramienta que falla igual cierra su paso (fin) y el turno responde sin lanzar", async () => {
    const llm = scriptedCompletion([CALL, { text: "" }]);
    const eventos: DataChatPasoEvento[] = [];
    const a = await runDataChatTurn({
      catalog: catalogOf(salesTool({ run: async () => { throw new Error("boom"); } })),
      scope: SCOPE_A,
      question: "x",
      complete: llm.complete,
      now: NOW,
      onEvento: (e) => eventos.push(e),
    });
    expect(a.status).toBe("unavailable");
    expect(eventos.map((e) => e.fase)).toEqual(["inicio", "fin"]);
  });

  it("sin herramienta en el catalogo no hay pasos; el modo directo tambien emite el paso", async () => {
    const llm = scriptedCompletion([{ toolCalls: [{ name: "no_existe", argumentsJson: "{}" }] }, { text: "No tengo esa consulta." }]);
    const eventos: DataChatPasoEvento[] = [];
    await runDataChatTurn({ catalog: catalogOf(salesTool()), scope: SCOPE_A, question: "x", complete: llm.complete, now: NOW, onEvento: (e) => eventos.push(e) });
    expect(eventos).toEqual([]);

    const directo: DataChatPasoEvento[] = [];
    const a = await runDataChatTurn({ catalog: catalogOf(salesTool()), scope: SCOPE_A, question: "", directTool: "ventas_por_dia", complete: llm.complete, now: NOW, onEvento: (e) => directo.push(e) });
    expect(a.status).toBe("ok");
    expect(directo.map((e) => e.fase)).toEqual(["inicio", "fin"]);
  });

  it("un callback que lanza no tumba el turno ni cambia la respuesta (se reporta por onError)", async () => {
    const t = base([CALL, { text: "Vendiste $2,480.50 MXN en 20 pedidos." }]);
    const donde: string[] = [];
    const a = await runDataChatTurn({ ...t.common, onEvento: () => { throw new Error("cliente caido"); }, onError: (w) => donde.push(w) });
    expect(a.status).toBe("ok");
    expect(a.toolsUsed).toEqual(["ventas_por_dia"]);
    expect(donde).toContain("on_evento");
  });
});

describe("runDataChatTurn — abort", () => {
  it("una senal ya abortada lanza DataChatAbortedError sin llamar al modelo ni a la herramienta ni a la bitacora", async () => {
    const t = base([CALL, { text: "x" }]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(runDataChatTurn({ ...t.common, signal: ctrl.signal })).rejects.toBeInstanceOf(DataChatAbortedError);
    expect(t.llm.requests).toHaveLength(0);
    expect(t.audit.entries).toHaveLength(0);
  });

  it("abortar mientras el modelo piensa rinde el turno de inmediato (no espera al modelo)", async () => {
    const ctrl = new AbortController();
    let liberar: () => void = () => {};
    const colgado = new Promise<never>((_, rej) => { liberar = () => rej(new Error("tarde")); });
    const eventos: DataChatPasoEvento[] = [];
    const p = runDataChatTurn({ catalog: catalogOf(salesTool()), scope: SCOPE_A, question: "x", now: NOW, signal: ctrl.signal, complete: () => colgado, onEvento: (e) => eventos.push(e) });
    setTimeout(() => ctrl.abort(), 5);
    const err = await p.catch((e: unknown) => e);
    expect(isDataChatAbortedError(err)).toBe(true);
    expect(eventos).toEqual([]);
    liberar(); // la promesa colgada se resuelve despues y no genera rechazo sin manejar
  });

  it("abortar durante una herramienta lanza DataChatAbortedError y no genera mas pasos ni segunda ronda", async () => {
    const ctrl = new AbortController();
    const llm = scriptedCompletion([CALL, { text: "no debe llegar" }]);
    const eventos: DataChatPasoEvento[] = [];
    const lenta = salesTool({ run: () => new Promise(() => {}) });
    const p = runDataChatTurn({ catalog: catalogOf(lenta), scope: SCOPE_A, question: "x", complete: llm.complete, now: NOW, signal: ctrl.signal, onEvento: (e) => { eventos.push(e); if (e.fase === "inicio") setTimeout(() => ctrl.abort(), 5); } });
    await expect(p).rejects.toBeInstanceOf(DataChatAbortedError);
    expect(eventos).toEqual([{ t: "paso", fase: "inicio", herramienta: "ventas_por_dia" }]);
    expect(llm.requests).toHaveLength(1);
  });

  it("sin senal ni callback el comportamiento es el de siempre", async () => {
    const t = base([CALL, { text: "Vendiste $2,480.50 MXN en 20 pedidos." }]);
    const a = await runDataChatTurn(t.common);
    expect(a.status).toBe("ok");
  });
});
