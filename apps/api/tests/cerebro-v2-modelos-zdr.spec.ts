// Cerebro v2 (bandera por organizacion, migracion 190): modelos Luna -> Haiku 5.5 y retencion cero (ZDR) en cada escalon.
import { describe, expect, it } from "vitest";
import { MODELOS_AGENTE, MODELO_ALTERNO_TOPE_ID, MODELO_PRINCIPAL_CEREBRO_V2_ID, MODELO_RESPALDO_CEREBRO_V2_ID, MODELO_VOZ_RAPIDO_CEREBRO_V2_ID, modeloAlternoParaTope } from "@atiende/domain-restaurantes";
import { CEREBRO_V2_ALTERNATIVAS, CEREBRO_V2_ESCALADO_ROUTE, CEREBRO_V2_WHATSAPP_ROUTE, DEFAULT_ROUTE, MODELOS_CON_ZDR_VERIFICADO, routingForModel, rutaZdrCerebroV2 } from "../src/production/llm-models.ts";

describe("cerebro v2: modelos y ZDR", () => {
  it("la escalera v2 del agente es Luna -> Haiku 5.5 y cada escalon sale con provider.zdr=true y proveedores de EE.UU.", () => {
    expect(CEREBRO_V2_WHATSAPP_ROUTE.models.map((m) => m.model)).toEqual([MODELO_PRINCIPAL_CEREBRO_V2_ID, MODELO_RESPALDO_CEREBRO_V2_ID]);
    for (const rung of CEREBRO_V2_WHATSAPP_ROUTE.models) {
      const r = routingForModel(CEREBRO_V2_WHATSAPP_ROUTE, rung.model, false);
      expect(r.zdr).toBe(true);
      expect(r.dataCollection).toBe("deny");
      expect(r.only?.length).toBeGreaterThan(0);
    }
  });

  it("el escalado v2 conserva la ruta vigente sin los escalones sin ZDR y agrega Haiku al final", () => {
    const v2 = rutaZdrCerebroV2(DEFAULT_ROUTE);
    const ids = v2.models.map((m) => m.model);
    expect(ids).not.toContain("google/gemini-2.5-flash-lite");
    expect(ids).not.toContain("meta/muse-spark-1.3");
    expect(ids[0]).toBe("openai/gpt-6-luna");
    expect(ids.at(-1)).toBe(MODELO_RESPALDO_CEREBRO_V2_ID);
    for (const m of ids) {
      expect(MODELOS_CON_ZDR_VERIFICADO.has(m)).toBe(true);
      expect(routingForModel(v2, m, false).zdr).toBe(true);
    }
  });

  it("el escalado v2 es Luna -> Haiku 5.5 con ZDR (sin Terra)", () => {
    expect(CEREBRO_V2_ESCALADO_ROUTE.models.map((m) => m.model)).toEqual([MODELO_PRINCIPAL_CEREBRO_V2_ID, MODELO_RESPALDO_CEREBRO_V2_ID]);
    for (const rung of CEREBRO_V2_ESCALADO_ROUTE.models) expect(routingForModel(CEREBRO_V2_ESCALADO_ROUTE, rung.model, false).zdr).toBe(true);
  });

  it("la lista ZDR del cerebro v2 no mete modelos premium ni fuera de la decision (Sonnet 5.5, Gemini 3.8 Flash)", () => {
    expect(MODELOS_CON_ZDR_VERIFICADO.has("anthropic/claude-sonnet-5.5")).toBe(false);
    expect(MODELOS_CON_ZDR_VERIFICADO.has("google/gemini-3.8-flash")).toBe(false);
    expect(MODELOS_CON_ZDR_VERIFICADO.has(MODELO_RESPALDO_CEREBRO_V2_ID)).toBe(true);
    expect(MODELOS_CON_ZDR_VERIFICADO.has(MODELO_VOZ_RAPIDO_CEREBRO_V2_ID)).toBe(true);
    const conSonnet = rutaZdrCerebroV2({ models: [{ model: "anthropic/claude-sonnet-5.5" }, { model: MODELO_PRINCIPAL_CEREBRO_V2_ID }] });
    expect(conSonnet.models.map((m) => m.model)).toEqual([MODELO_PRINCIPAL_CEREBRO_V2_ID, MODELO_RESPALDO_CEREBRO_V2_ID]);
  });

  it("las alternativas v2 (rapido de voz, Haiku, Luna) tienen ZDR verificado", () => {
    expect(CEREBRO_V2_ALTERNATIVAS.map((m) => m.model)).toContain(MODELO_VOZ_RAPIDO_CEREBRO_V2_ID);
    for (const m of CEREBRO_V2_ALTERNATIVAS) expect(MODELOS_CON_ZDR_VERIFICADO.has(m.model)).toBe(true);
  });

  it("el panel ofrece Haiku 5.5 y Gemini 3.5 Flash-Lite (la lista del panel sale de MODELOS_AGENTE)", () => {
    const ids = MODELOS_AGENTE.map((m) => m.id);
    expect(ids).toContain(MODELO_RESPALDO_CEREBRO_V2_ID);
    expect(ids).toContain(MODELO_VOZ_RAPIDO_CEREBRO_V2_ID);
  });

  it("el alterno por tope del cerebro v2 es Haiku (y Luna si Haiku era el primario); sin bandera no cambia", () => {
    expect(modeloAlternoParaTope(MODELO_PRINCIPAL_CEREBRO_V2_ID, true)).toBe(MODELO_RESPALDO_CEREBRO_V2_ID);
    expect(modeloAlternoParaTope(MODELO_RESPALDO_CEREBRO_V2_ID, true)).toBe(MODELO_PRINCIPAL_CEREBRO_V2_ID);
    // Decision del dueno: el respaldo de Luna es Claude Haiku 5.5. Con la bandera ya lo es; sin ella el alterno es la constante de la plataforma
    // (hoy DeepSeek en este PR; #750 la cambia a Haiku 5.5 para todos). Se compara contra la constante para no fijar aqui un id que #750 retira.
    expect(modeloAlternoParaTope(MODELO_PRINCIPAL_CEREBRO_V2_ID)).toBe(MODELO_ALTERNO_TOPE_ID);
    expect(modeloAlternoParaTope(MODELO_PRINCIPAL_CEREBRO_V2_ID)).not.toBe(MODELO_PRINCIPAL_CEREBRO_V2_ID);
  });
});
