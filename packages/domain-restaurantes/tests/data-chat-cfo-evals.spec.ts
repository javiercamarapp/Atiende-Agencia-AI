// CFO-09 · evals de «Pregunta a tu CFO»: los casos de scripts/eval-copiloto/casos/restaurantes-cfo.ts corren con el MOTOR REAL (`runDataChatTurn`),
// un modelo guionado que pide exactamente la herramienta esperada y el servicio del CFO en memoria (dataset SINTETICO). Afirman: herramienta y
// argumentos, estado del turno, cifras presentes (las del servicio), cero cifras inventadas y la honestidad de cada caso. Reloj: miercoles 12:00 de Merida.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractNumbers, runDataChatTurn, scriptedCompletion, type DataChatAuditEntry, type DataChatAuditSink, type DataChatScope } from "@atiende/agent-core/data-chat";
import { casosCfo, type CasoCfo } from "../../../scripts/eval-copiloto/casos/restaurantes-cfo.ts";
import { resolverCifra } from "../../../scripts/eval-copiloto/fuente.ts";
import { buildRestaurantesDataChatCatalog, buildRestaurantesDataChatTools } from "../src/data-chat/index.ts";
import { CfoFakeReader, GERENTE_T1_SCOPE, IDS, MIERCOLES_MERIDA, OWNER_CFO_SCOPE } from "./data-chat/support-cfo.ts";
import { generarDatasetSintetico } from "./fixtures/cfo-pm-sintetico.ts";

const D = generarDatasetSintetico({ hasta: "2026-09-30", diasRango: 120 });
const COBERTURA = IDS.map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-30", zona: "America/Merida", corte: "01:00:00" }));
const BASE = { ventasDiarias: D.ventasDiarias, cortesias: D.cortesias, ventasHora: D.ventasHora, productos: D.productos, agenteDiario: D.agenteDiario, comandasPos: D.comandasPos, clientesResumen: D.clientes, agotados: D.agotados, cobertura: COBERTURA };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MIERCOLES_MERIDA);
});
afterEach(() => vi.useRealTimers());

function lectorDe(c: CasoCfo): CfoFakeReader {
  const mundo = c.mundo ?? "completo";
  return new CfoFakeReader({
    dataset: { ...BASE, ...(mundo === "completo" ? { srResumen: D.srResumen } : {}) },
    ...(mundo === "sin_migrar" ? { repo: { migraciones: { m081: false, m082: false, m083: false, m084: false } } } : {}),
  });
}
const alcanceDe = (c: CasoCfo): DataChatScope => (c.quien === "admin_acotado" ? GERENTE_T1_SCOPE : OWNER_CFO_SCOPE);

describe("evals de «Pregunta a tu CFO»", () => {
  it("son 8 casos, ids únicos, todos sobre herramientas cfo_* del catálogo real", () => {
    expect(casosCfo).toHaveLength(8);
    expect(new Set(casosCfo.map((c) => c.id)).size).toBe(8);
    const nombres = new Set(buildRestaurantesDataChatTools(new CfoFakeReader()).map((t) => t.name));
    for (const c of casosCfo) for (const l of c.llama ?? []) expect(nombres.has(l.tool) && l.tool.startsWith("cfo_"), `${c.id}: ${l.tool}`).toBe(true);
  });

  it.each(casosCfo.map((c) => [c.id, c.q, c] as const))("%s · %s", async (_id, _q, c) => {
    const reader = lectorDe(c);
    const catalog = buildRestaurantesDataChatCatalog(reader);
    const llamadas = c.llama ?? [];
    // Referencia: lo que devuelve la herramienta con esos argumentos (el valor esperado NUNCA se escribe a mano).
    const refReader = lectorDe(c);
    const tools = buildRestaurantesDataChatTools(refReader);
    const ctx = { scope: alcanceDe(c), now: new Date(), signal: new AbortController().signal, maxRows: 50 };
    const referencia = await Promise.all(llamadas.map((l) => tools.find((t) => t.name === l.tool)!.run(ctx, l.args)));

    const auditoria: DataChatAuditEntry[] = [];
    const audit: DataChatAuditSink = { record: async (e) => void auditoria.push(e) };
    const texto = referencia[0]?.summary ?? referencia[0]?.message ?? "";
    const llm = scriptedCompletion([{ toolCalls: llamadas.map((l) => ({ name: l.tool, argumentsJson: JSON.stringify(l.args) })) }, { text: texto }]);
    const a = await runDataChatTurn({ catalog, scope: alcanceDe(c), question: c.q, complete: llm.complete, audit, now: new Date() });

    // Herramienta y argumentos
    const usadas = auditoria.filter((e) => e.tool).map((e) => ({ tool: e.tool, params: e.params }));
    expect(usadas.map((u) => u.tool), c.id).toEqual(llamadas.map((l) => l.tool));
    for (const [i, l] of llamadas.entries()) expect(usadas[i]!.params, c.id).toMatchObject(l.args);

    // Estado
    const esperado = c.status ?? "ok";
    expect(a.status, `${c.id}: ${a.text}`).toBe(esperado);

    // Cifras presentes y cero inventadas
    const todo = `${a.text} ${JSON.stringify(a.blocks)}`;
    for (const spec of c.cifras ?? []) {
      for (const cifra of resolverCifra(spec, referencia, c.id)) {
        const presente = extractNumbers(todo).some((n) => Math.abs(n - cifra.valor) < 0.011) || todo.includes(String(cifra.valor));
        expect(presente, `${c.id}: falta la cifra ${cifra.etiqueta}=${cifra.valor}`).toBe(true);
      }
    }
    for (const p of c.prohibidas ?? []) expect(todo, c.id).not.toContain(p);

    // Honestidad del caso (lo dice la respuesta o el mensaje de la herramienta)
    const dicho = `${a.text} ${referencia.map((r) => `${r.message ?? ""} ${r.summary ?? ""}`).join(" ")}`;
    for (const re of c.debeDecir ?? []) expect(dicho, `${c.id}: ${re}`).toMatch(re);

    // Una respuesta del CFO siempre cita su fuente y que no sustituye al contador (salvo las aclaraciones sin consulta)
    if (a.sources.length > 0) for (const s of a.sources) expect(s.source, c.id).toMatch(/no sustituye a tu contador/);
  });

  it("un modelo que inventa una cifra sobre el CFO no la publica: se muestra el resumen del servicio", async () => {
    const c = casosCfo[0]!;
    const reader = lectorDe(c);
    const llm = scriptedCompletion([{ toolCalls: [{ name: "cfo_resumen", argumentsJson: JSON.stringify({ periodo: "ayer", sucursal: "Altabrisa" }) }] }, { text: "Altabrisa vendió $999,999.00 MXN ayer." }]);
    const a = await runDataChatTurn({ catalog: buildRestaurantesDataChatCatalog(reader), scope: OWNER_CFO_SCOPE, question: c.q, complete: llm.complete, now: new Date() });
    expect(JSON.stringify(a)).not.toContain("999,999");
    expect(a.text).toMatch(/Altabrisa|\$/);
  });
});

