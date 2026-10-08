// CHAT-06: cada chip y pregunta de tarjeta del Copiloto de las SEIS verticales tiene una consulta DIRECTA que (a) apunta a una
// herramienta que EXISTE en el catalogo real de su vertical y (b) tiene argumentos que el esquema real de esa herramienta ACEPTA.
// Si un catalogo renombra una herramienta o cambia sus parametros, este test falla en vez de dejar un chip roto en silencio.
import { describe, expect, it } from "vitest";
import { parseArgs, type DataChatCatalog } from "@atiende/agent-core/data-chat";
import { buildCitasDataChatCatalog } from "@atiende/domain-citas";
import { buildDespachosDataChatCatalog } from "@atiende/domain-despachos";
import { buildHotelesDataChatCatalog } from "@atiende/domain-hoteles";
import { buildLicitacionesDataChatCatalog } from "@atiende/domain-licitaciones";
import { buildRentasDataChatCatalog } from "@atiende/domain-rentas";
import { buildRestaurantesDataChatCatalog } from "@atiende/domain-restaurantes";
import { COPILOTO_CITAS } from "../src/lib/copiloto/config/citas.ts";
import { COPILOTO_DESPACHOS } from "../src/lib/copiloto/config/despachos.ts";
import { COPILOTO_HOTELES } from "../src/lib/copiloto/config/hoteles.ts";
import { COPILOTO_LICITACIONES } from "../src/lib/copiloto/config/licitaciones.ts";
import { COPILOTO_RENTAS } from "../src/lib/copiloto/config/rentas.ts";
import { COPILOTO_RESTAURANTES, COPILOTO_RESTAURANTES_SIN_CFO } from "../src/lib/copiloto/config/restaurantes.ts";
import type { CopilotoConfigVertical } from "../src/lib/copiloto/config/tipos.ts";

const stub = {} as never;
const CASOS: readonly [string, CopilotoConfigVertical, DataChatCatalog][] = [
  ["restaurantes", COPILOTO_RESTAURANTES, buildRestaurantesDataChatCatalog(stub, { verticalRole: "owner" })],
  ["restaurantes (sin cfo.ver)", COPILOTO_RESTAURANTES_SIN_CFO, buildRestaurantesDataChatCatalog(stub, { verticalRole: "staff" })],
  ["hoteles", COPILOTO_HOTELES, buildHotelesDataChatCatalog(stub)],
  ["rentas", COPILOTO_RENTAS, buildRentasDataChatCatalog(stub)],
  ["citas", COPILOTO_CITAS, buildCitasDataChatCatalog(stub)],
  ["despachos", COPILOTO_DESPACHOS, buildDespachosDataChatCatalog(stub)],
  ["licitaciones", COPILOTO_LICITACIONES, buildLicitacionesDataChatCatalog(stub)],
];

describe.each(CASOS)("chips directos de %s", (_vertical, config, catalog) => {
  const preguntas = [...new Set([...config.sugerencias, ...config.categorias.flatMap((c) => c.preguntas)])];

  it("TODO chip y pregunta de tarjeta tiene consulta directa (nada queda pasando por el modelo por omision)", () => {
    expect(preguntas.filter((q) => !config.directas[q])).toEqual([]);
  });

  it("toda entrada del mapa corresponde a un chip o pregunta real (sin entradas huerfanas)", () => {
    expect(Object.keys(config.directas).filter((q) => !preguntas.includes(q))).toEqual([]);
  });

  it("cada consulta directa apunta a una herramienta del catalogo REAL con argumentos que su esquema acepta", () => {
    for (const [pregunta, directa] of Object.entries(config.directas)) {
      const tool = catalog.tools.find((t) => t.name === directa.tool);
      expect(tool, `${pregunta} -> ${directa.tool} no existe en el catalogo`).toBeDefined();
      const parsed = parseArgs(tool!.params, directa.args ?? {});
      expect(parsed.ok, `${pregunta} -> ${directa.tool}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
    }
  });

  it("las herramientas con periodo OBLIGATORIO de la pregunta lo traen resuelto (si el chip dice 'este mes', el argumento tambien)", () => {
    for (const [pregunta, directa] of Object.entries(config.directas)) {
      const tool = catalog.tools.find((t) => t.name === directa.tool)!;
      if (tool.params["periodo"] && /este mes/i.test(pregunta)) expect(directa.args?.["periodo"], pregunta).toBe("este_mes");
      if (tool.params["periodo"] && /últimos 30 días/i.test(pregunta)) expect(directa.args?.["periodo"], pregunta).toBe("ultimos_30_dias");
      if (tool.params["periodo"] && /últimos 7 días/i.test(pregunta)) expect(directa.args?.["periodo"], pregunta).toBe("ultimos_7_dias");
      if (tool.params["periodo"] && /mes pasado/i.test(pregunta)) expect(directa.args?.["periodo"], pregunta).toBe("mes_pasado");
    }
  });
});
