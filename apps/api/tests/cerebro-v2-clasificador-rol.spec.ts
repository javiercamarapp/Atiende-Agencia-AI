// Cerebro v2: los clasificadores del suelto («¿aparte?» y alergia semántica) usan su PROPIO rol del gateway, `restaurantes:whatsapp_clasificador`, mapeado
// en la tabla central actividad -> modelo (#750) a `clasificacion_whatsapp`: Gemini 3.5 Flash-Lite (el modelo con que el suelto midió sus clasificadores)
// -> Luna, ambos baratos y con endpoint ZDR; el rol tiene escalera de retención cero (las llamadas van con zdrEstricto) y es un rol de producción detenible.
import { describe, expect, it } from "vitest";
import { ACTIVIDADES_LLM, actividadDeRol, MODELOS_CON_ZDR_VERIFICADO, RESTAURANTES_WHATSAPP_CLASIFICADOR_ROLE } from "../src/production/llm-models.ts";
import { ALL_PRODUCTION_ROLES, buildCerebroV2ZdrLadders } from "../src/production/llm-gateway.ts";
import { TEST_ENV } from "./fixtures.ts";

describe("rol de los clasificadores del cerebro v2", () => {
  it("es de producción y su actividad es clasificacion_whatsapp: Flash-Lite 3.5 -> Luna, todos con ZDR", () => {
    expect(RESTAURANTES_WHATSAPP_CLASIFICADOR_ROLE).toBe("restaurantes:whatsapp_clasificador");
    expect(ALL_PRODUCTION_ROLES).toContain(RESTAURANTES_WHATSAPP_CLASIFICADOR_ROLE);
    expect(actividadDeRol(RESTAURANTES_WHATSAPP_CLASIFICADOR_ROLE)).toBe("clasificacion_whatsapp");
    const ruta = ACTIVIDADES_LLM.clasificacion_whatsapp.route.models.map((m) => m.model);
    expect(ruta).toEqual(["google/gemini-3.5-flash-lite", "openai/gpt-6-luna"]);
    for (const m of ruta) expect(MODELOS_CON_ZDR_VERIFICADO.has(m)).toBe(true);
  });

  it("tiene escalera de retención cero con llave de OpenRouter", () => {
    const env = { ...TEST_ENV, llmProviders: { ...TEST_ENV.llmProviders, openrouter: { apiKey: "x", countryOfResidence: null, modelsJson: null, zdr: true, sharedBreaker: null } } };
    const zdr = buildCerebroV2ZdrLadders(env);
    expect(zdr.get(RESTAURANTES_WHATSAPP_CLASIFICADOR_ROLE)?.ladder.length).toBe(2);
  });
});
