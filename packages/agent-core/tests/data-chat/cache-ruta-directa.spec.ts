// CHAT-06 / MOD-05: ruta directa (chips sin modelo) y cache de resultados de herramientas.
import { describe, expect, it } from "vitest";
import { runDataChatTurn, type RunDataChatTurnOptions } from "../../src/data-chat/engine.js";
import { CACHE_TTL_CLOSED_MS, CACHE_TTL_OPEN_MS, MemoryDataChatCacheStore, buildCacheKey, cacheTtlMs, isClosedPeriod, type DataChatCache } from "../../src/data-chat/cache.js";
import { scriptedCompletion } from "../../src/data-chat/scripted-llm.js";
import type { DataChatToolContext, DataChatUsage } from "../../src/data-chat/types.js";
import { MemoryAudit, NOW, SCOPE_A, catalogOf, salesTool } from "./support.js";

/** NOW = 29-sep-2026 23:30 en Merida (UTC-6): en UTC ya es 30-sep. */
const MIN = 60_000;

function harness() {
  let clock = NOW.getTime();
  const store = new MemoryDataChatCacheStore(() => clock);
  const seen: DataChatToolContext[] = [];
  const tool = salesTool({}, seen);
  const cache: DataChatCache = { store, isCacheable: (t) => t.name === "ventas_por_dia" };
  const llm = scriptedCompletion([{ text: "" }]);
  const audit = new MemoryAudit();
  const usos: DataChatUsage[] = [];
  const errors: string[] = [];
  const run = (over: Partial<RunDataChatTurnOptions> = {}) =>
    runDataChatTurn({
      catalog: catalogOf(tool),
      scope: SCOPE_A,
      question: "",
      directTool: "ventas_por_dia",
      directArgs: { periodo: "ayer" },
      complete: llm.complete,
      cache,
      audit,
      now: new Date(clock),
      onUso: (u) => usos.push(u),
      onError: (w) => errors.push(w),
      ...over,
    });
  return { store, seen, llm, audit, usos, errors, run, advance: (ms: number) => (clock += ms), cache, tool };
}

describe("ruta directa (chips sin modelo)", () => {
  it("un chip ejecuta la herramienta con SUS argumentos y no llama al modelo", async () => {
    const h = harness();
    const a = await h.run({ directArgs: { periodo: "ultimos_7_dias" } });
    expect(a.status).toBe("ok");
    expect(a.blocks).toHaveLength(1);
    expect(h.llm.requests).toHaveLength(0);
    expect(h.seen).toHaveLength(1);
    expect(h.usos[0]).toMatchObject({ route: "directa", llmCalls: 0 });
    expect(h.audit.entries[0]).toMatchObject({ tool: "ventas_por_dia", route: "directa", params: { periodo: "ultimos_7_dias" } });
  });

  it("argumentos invalidos (clave ajena o periodo fuera del catalogo) se rechazan sin ejecutar la herramienta", async () => {
    const h = harness();
    for (const directArgs of [{ organizationId: "org-b" }, { periodo: "el_ano_que_viene" }, { desde: "2026-02-30", hasta: "2026-03-01" }]) {
      const a = await h.run({ directArgs });
      expect(a.status).toBe("clarify");
    }
    expect(h.seen).toHaveLength(0);
    expect(h.llm.requests).toHaveLength(0);
  });
});

describe("cache de herramientas", () => {
  it("la segunda consulta igual sale de la cache: la herramienta corre UNA vez y la ruta es 'cache'", async () => {
    const h = harness();
    const first = await h.run();
    const second = await h.run();
    expect(h.seen).toHaveLength(1);
    expect(h.store.hits).toBe(1);
    expect(second.blocks).toEqual(first.blocks);
    expect(second.sources).toEqual(first.sources);
    expect(h.usos.map((u) => u.route)).toEqual(["directa", "cache"]);
    expect(h.usos[1]!.cacheHits).toBe(1);
    expect(h.audit.entries.map((e) => e.route)).toEqual(["directa", "cache"]);
  });

  it("el motor con modelo tambien lee la cache al ejecutar herramientas", async () => {
    const h = harness();
    await h.run(); // calienta la cache con la ruta directa
    const llm = scriptedCompletion([{ toolCalls: [{ name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "ayer" }) }] }, { text: "" }]);
    const a = await h.run({ question: "¿cuánto vendí ayer?", directTool: undefined, directArgs: undefined, complete: llm.complete });
    expect(a.status).toBe("ok");
    expect(llm.requests.length).toBeGreaterThan(0); // el modelo SI redacta; lo cacheado es el resultado de la herramienta
    expect(h.seen).toHaveLength(1);
    expect(h.usos.at(-1)!.cacheHits).toBe(1);
    expect(h.audit.entries.at(-1)!.route).toBe("cache");
  });

  it("la clave no se comparte entre organizaciones, roles ni alcances de sucursal, pero si entre usuarios con el mismo alcance y rol", async () => {
    const h = harness();
    await h.run();
    await h.run({ scope: { ...SCOPE_A, organizationId: "org-b" } });
    expect(h.seen).toHaveLength(2); // org B no recibe lo de org A
    await h.run({ scope: { ...SCOPE_A, verticalRole: "gerente_sucursal" } });
    expect(h.seen).toHaveLength(3); // otro rol, otra entrada
    await h.run({ scope: { ...SCOPE_A, allowedPropertyIds: ["p1"] } });
    expect(h.seen).toHaveLength(4); // otro alcance de sucursal, otra entrada
    await h.run({ scope: { ...SCOPE_A, userId: "user-2" } });
    expect(h.seen).toHaveLength(4); // otro usuario con el MISMO alcance y rol comparte
    // El orden de las sucursales en la membership no cambia la clave.
    const k = (ids: string[]) => buildCacheKey({ ...SCOPE_A, allowedPropertyIds: ids }, h.tool, { periodo: "ayer" }, NOW);
    expect(k(["p1", "p2"])).toBe(k(["p2", "p1"]));
  });

  it("TTL: periodo cerrado 24 h, periodo que incluye hoy 5 min (a las 23:30 de Merida, cuando en UTC ya es manana)", async () => {
    expect(cacheTtlMs({ periodo: "ayer" }, NOW, "America/Merida")).toBe(CACHE_TTL_CLOSED_MS);
    expect(cacheTtlMs({ periodo: "hoy" }, NOW, "America/Merida")).toBe(CACHE_TTL_OPEN_MS);
    expect(cacheTtlMs({ periodo: "ultimos_7_dias" }, NOW, "America/Merida")).toBe(CACHE_TTL_OPEN_MS);
    expect(cacheTtlMs({}, NOW, "America/Merida")).toBe(CACHE_TTL_OPEN_MS); // estado actual: abierto
    // Fechas exactas: 'hasta' = ayer LOCAL (28-sep) esta cerrado; 'hasta' = hoy LOCAL (29-sep, aunque en UTC ya sea 30) esta abierto.
    expect(isClosedPeriod({ desde: "2026-09-01", hasta: "2026-09-28" }, NOW, "America/Merida")).toBe(true);
    expect(isClosedPeriod({ desde: "2026-09-01", hasta: "2026-09-29" }, NOW, "America/Merida")).toBe(false);
    expect(isClosedPeriod({ desde: "2026-09-01", hasta: "2026-09-29" }, NOW, "UTC")).toBe(true); // en UTC ya es el 30

    const h = harness();
    await h.run({ directArgs: { periodo: "ayer" } });
    await h.run({ directArgs: { periodo: "hoy" } });
    expect(h.seen).toHaveLength(2);
    h.advance(6 * MIN);
    await h.run({ directArgs: { periodo: "ayer" } }); // sigue en cache (24 h)
    expect(h.seen).toHaveLength(2);
    await h.run({ directArgs: { periodo: "hoy" } }); // vencio (5 min): vuelve a consultar
    expect(h.seen).toHaveLength(3);
  });

  it("al pasar la medianoche local la clave cambia (los periodos relativos se resuelven con el dia local)", () => {
    const h = harness();
    const before = buildCacheKey(SCOPE_A, h.tool, { periodo: "hoy" }, NOW); // 29-sep 23:30 Merida
    const after = buildCacheKey(SCOPE_A, h.tool, { periodo: "hoy" }, new Date(NOW.getTime() + 60 * MIN)); // 30-sep 00:30 Merida
    expect(before).not.toBe(after);
    const sameLocalDay = buildCacheKey(SCOPE_A, h.tool, { periodo: "hoy" }, new Date(NOW.getTime() + 10 * MIN));
    expect(sameLocalDay).toBe(before);
  });

  it("jamas guarda herramientas no declaradas, resultados con PII, errores ni resultados recortados", async () => {
    const h = harness();
    await h.run({ cache: { store: h.store, isCacheable: () => false } });
    expect(h.store.size).toBe(0);

    const pii = salesTool({ rows: [{ dia: "2026-09-28", ventas: 10, pedidos: 1 }, { dia: "cliente ana@correo.com", ventas: 5, pedidos: 1 }] });
    await h.run({ catalog: catalogOf(pii) });
    expect(h.store.size).toBe(0);

    const tel = salesTool({ rows: [{ dia: "llamar al 999 123 4567", ventas: 5, pedidos: 1 }] });
    await h.run({ catalog: catalogOf(tel) });
    expect(h.store.size).toBe(0);

    const boom = salesTool({ run: async () => { throw new Error("db caida"); } });
    const a = await h.run({ catalog: catalogOf(boom) });
    expect(a.status).toBe("unavailable");
    expect(h.store.size).toBe(0);

    const many = salesTool({ rows: Array.from({ length: 60 }, (_, i) => ({ dia: `d${i}`, ventas: i, pedidos: 1 })) });
    await h.run({ catalog: catalogOf(many) });
    expect(h.store.size).toBe(0); // 60 > maxRows: recortado, no se guarda
  });

  it("si la cache falla (get o set) el turno responde igual con datos reales", async () => {
    const h = harness();
    const broken: DataChatCache = {
      isCacheable: () => true,
      store: { get: async () => { throw new Error("redis caido"); }, set: async () => { throw new Error("redis caido"); } },
    };
    const a = await h.run({ cache: broken });
    expect(a.status).toBe("ok");
    expect(h.seen).toHaveLength(1);
    expect(h.errors).toEqual(expect.arrayContaining(["cache_get", "cache_set"]));
  });
});
