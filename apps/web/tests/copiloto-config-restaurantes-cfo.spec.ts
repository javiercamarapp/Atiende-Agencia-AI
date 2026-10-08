// CFO-09: «Pregunta a tu CFO» en la config del Copiloto de restaurantes. Cada pregunta del CFO apunta a una herramienta que EXISTE en el catalogo real
// (con argumentos que su esquema acepta, periodo incluido), toda herramienta del catalogo tiene su etiqueta en vivo y su pantalla fuente, y los chips
// no pasan de 5. Ninguna respuesta vive aqui: solo preguntas.
import { describe, expect, it } from "vitest";
import { parseArgs } from "@atiende/agent-core/data-chat";
import { buildRestaurantesDataChatCatalog } from "@atiende/domain-restaurantes";
import { COPILOTO_RESTAURANTES } from "../src/lib/copiloto/config/restaurantes.ts";

const catalog = buildRestaurantesDataChatCatalog({} as never);
const CFO = COPILOTO_RESTAURANTES.categorias.find((c) => c.titulo === "CFO")!;

describe("config del Copiloto de restaurantes: categoría CFO", () => {
  it("existe, con 4 o 5 preguntas, y cada una trae consulta directa a una herramienta cfo_* del catálogo con argumentos válidos y periodo", () => {
    expect(CFO).toBeDefined();
    expect(CFO.preguntas.length).toBeGreaterThanOrEqual(4);
    expect(CFO.preguntas.length).toBeLessThanOrEqual(5);
    for (const q of CFO.preguntas) {
      const d = COPILOTO_RESTAURANTES.directas[q];
      expect(d, q).toBeDefined();
      expect(d!.tool, q).toMatch(/^cfo_/);
      const tool = catalog.tools.find((t) => t.name === d!.tool);
      expect(tool, `${q} -> ${d!.tool}`).toBeDefined();
      expect(parseArgs(tool!.params, d!.args ?? {}).ok, q).toBe(true);
      expect(d!.args?.["periodo"], q).toBeTruthy();
    }
  });

  it("cubre lo más importante, estado de resultados, comparar sucursales, clientes frecuentes y costo del agente", () => {
    const tools = CFO.preguntas.map((q) => COPILOTO_RESTAURANTES.directas[q]!.tool);
    expect(tools).toEqual(["cfo_lo_mas_importante", "cfo_estado_resultados", "cfo_comparar_sucursales", "cfo_clientes", "cfo_agente"]);
  });

  it("1 o 2 chips son del CFO y siguen siendo 5 como máximo", () => {
    const chips = COPILOTO_RESTAURANTES.sugerencias;
    expect(chips.length).toBeLessThanOrEqual(5);
    const delCfo = chips.filter((c) => COPILOTO_RESTAURANTES.directas[c]?.tool.startsWith("cfo_"));
    expect(delCfo.length).toBeGreaterThanOrEqual(1);
    expect(delCfo.length).toBeLessThanOrEqual(2);
  });

  it("toda herramienta del catálogo (incluidas las nueve del CFO) tiene etiqueta en vivo y una pantalla fuente interna", () => {
    for (const t of catalog.tools) {
      expect(COPILOTO_RESTAURANTES.etiquetasHerramienta[t.name], `etiqueta de ${t.name}`).toBeTruthy();
      const ruta = COPILOTO_RESTAURANTES.rutasFuente[t.name];
      expect(ruta, `ruta de ${t.name}`).toMatch(/^\/restaurantes\/:orgSlug\//);
      if (t.name.startsWith("cfo_")) expect(ruta, t.name).toMatch(/^\/restaurantes\/:orgSlug\/cfo(\/|$)/);
    }
    expect(catalog.tools.filter((t) => t.name.startsWith("cfo_"))).toHaveLength(9);
  });

  it("la nota del Copiloto avisa que el CFO no sustituye al contador", () => {
    expect(COPILOTO_RESTAURANTES.textos.nota).toMatch(/no sustituyen a tu contador/);
  });
});
