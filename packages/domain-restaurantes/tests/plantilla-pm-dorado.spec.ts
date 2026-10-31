// Contrato dorado (Fase A de la plantilla): el prompt de PM generado por la plantilla es IDENTICO byte a byte al historico.
// Las huellas (sha256 + longitud) se capturaron del builder original antes de parametrizarlo; si un cambio mueve un byte de PM, esto falla.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import { generarComportamientoVoz, generarPromptWhatsApp } from "../src/plantilla/generador.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_RESTAURANTE_CONFIG } from "../src/plantilla/config-pm.ts";
import { validarConfig } from "../src/plantilla/validar.ts";
import { CASOS_PM, PM_NEGOCIO } from "./plantilla-casos-pm.ts";

const huellas = JSON.parse(readFileSync(new URL("./fixtures/plantilla-pm-huellas.json", import.meta.url), "utf8")) as Record<string, { sha256: string; largo: number }>;
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const SOLO_PERFIL = { soloPerfil: true } as const;

function historico(c: (typeof CASOS_PM)[number]): string {
  if (c.tipo === "voz-sembrado") {
    return comportamientoVozPm({ ...PM_NEGOCIO, branches: c.ctx.branches, salsasTexto: c.ctx.salsasTexto ?? null, promosTexto: c.ctx.promosTexto ?? null });
  }
  return buildPmSystemPrompt(c.ctx);
}
function viaPlantilla(c: (typeof CASOS_PM)[number]): string {
  return c.tipo === "voz-sembrado" ? generarComportamientoVoz(c.config, SOLO_PERFIL) : generarPromptWhatsApp(c.config, c.entrada, SOLO_PERFIL);
}

describe("plantilla: PM generado == PM historico (byte a byte)", () => {
  it("la config de PM es valida como perfil y coincide con PM_CONFIG_POR_OMISION", () => {
    expect(validarConfig(PM_RESTAURANTE_CONFIG, SOLO_PERFIL)).toEqual({ ok: true, errores: [], advertencias: [] });
    expect(PM_RESTAURANTE_CONFIG.marca.nombre).toBe(PM_CONFIG_POR_OMISION.businessName);
    expect(PM_RESTAURANTE_CONFIG.marca.tiempoEntrega).toBe(PM_CONFIG_POR_OMISION.deliveryTimeText);
    expect(PM_RESTAURANTE_CONFIG.negocio.zonaHoraria).toBe(PM_CONFIG_POR_OMISION.timezone);
  });
  it("hay una huella por caso y ninguna sobra", () => {
    expect(Object.keys(huellas).sort()).toEqual(CASOS_PM.map((c) => c.id).sort());
  });
  it.each(CASOS_PM.map((c) => [c.id, c] as const))("%s: camino historico == huella congelada", (id, c) => {
    const t = historico(c);
    expect({ sha256: sha(t), largo: t.length }).toEqual(huellas[id]);
  });
  it.each(CASOS_PM.map((c) => [c.id, c] as const))("%s: generado por la plantilla == huella congelada", (id, c) => {
    const t = viaPlantilla(c);
    expect({ sha256: sha(t), largo: t.length }).toEqual(huellas[id]);
    expect(t).toBe(historico(c));
  });
});
