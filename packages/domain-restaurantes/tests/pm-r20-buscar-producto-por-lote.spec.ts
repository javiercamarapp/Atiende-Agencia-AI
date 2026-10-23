// PM ronda 20: buscar_producto acepta `consultas_adicionales` (otros productos del mismo pedido) para ahorrar una vuelta al modelo por producto.
// Deterministas, sin LLM: mundo PM en memoria. Sin el parametro nuevo la forma del resultado NO cambia (lista de productos).
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_DEFINITIONS, MAX_CONSULTAS_ADICIONALES_BUSCAR_PRODUCTO, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
interface Hallado { id: string; name: string; price: number; pack_size: number | null }
interface Lote { resultados: Array<{ query: string; productos: Hallado[] }> }
const llamar = async (input: Record<string, unknown>) => {
  const w = await mundo;
  return invokeAgentTool(w.repo, { organizationId: w.organizationId, channel: "whatsapp", phone: "9991234567" }, "buscar_producto", { branch_slug: "garcia-lavin", ...input });
};

describe("PM-R20 buscar_producto por lote", () => {
  it("sin consultas_adicionales el resultado es la lista de siempre (compatibilidad)", async () => {
    const r = await llamar({ query: "alitas" });
    expect(Array.isArray(r.result)).toBe(true);
    expect((r.result as Hallado[]).length).toBeGreaterThan(0);
  });

  it("con consultas_adicionales: un resultado por consulta, en orden, IDENTICO a buscarlas por separado", async () => {
    const consultas = ["alitas", "pastor", "coca"];
    const sueltas = await Promise.all(consultas.map(async (q) => (await llamar({ query: q })).result as Hallado[]));
    const lote = (await llamar({ query: consultas[0], consultas_adicionales: consultas.slice(1) })).result as Lote;
    expect(lote.resultados.map((x) => x.query)).toEqual(consultas);
    expect(lote.resultados.map((x) => x.productos)).toEqual(sueltas);
  });

  it("entradas basura se ignoran y el tope es de 5 extras; sin extras validos la forma no cambia", async () => {
    const vacio = await llamar({ query: "alitas", consultas_adicionales: ["", "  ", 7, null] });
    expect(Array.isArray(vacio.result)).toBe(true);
    const muchas = (await llamar({ query: "alitas", consultas_adicionales: Array.from({ length: 9 }, () => "coca") })).result as Lote;
    expect(muchas.resultados).toHaveLength(1 + MAX_CONSULTAS_ADICIONALES_BUSCAR_PRODUCTO);
    const noLista = await llamar({ query: "alitas", consultas_adicionales: "coca" });
    expect(Array.isArray(noLista.result)).toBe(true);
  });

  it("es solo lectura y sigue exigiendo sucursal valida", async () => {
    const r = await llamar({ query: "alitas", consultas_adicionales: ["coca"] });
    expect(r.orderId).toBeNull();
    await expect(llamar({ query: "alitas", consultas_adicionales: ["coca"], branch_slug: "no-existe" })).rejects.toThrow();
  });

  it("esquema aditivo: query y branch_slug siguen siendo los unicos requeridos y el parametro nuevo es opcional, sin telefono", () => {
    const def = AGENT_TOOL_DEFINITIONS.find((d) => d.name === "buscar_producto")!;
    const params = def.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
    expect(params.required).toEqual(["query", "branch_slug"]);
    expect(Object.keys(params.properties)).toContain("consultas_adicionales");
    expect(Object.keys(params.properties).some((k) => /tel|phone|celular/i.test(k))).toBe(false);
    expect(def.channels).toEqual(["whatsapp", "voz"]);
  });
});
