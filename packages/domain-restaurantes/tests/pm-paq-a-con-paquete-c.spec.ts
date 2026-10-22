// PAQUETE A + C en el mismo prompt de WhatsApp: ambos presentes una sola vez, ninguno en la voz compacta, sin reglas duplicadas.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { PM_PAQUETE_C_PROMPT } from "../src/whatsapp/prompt-pm-paquete-c.ts";
import { PROMPT_PM_PAQUETE_A, construirPromptPaqueteA } from "../src/whatsapp/prompt-pm-paquete-a.ts";

const base = {
  businessName: "Los Taquitos de PM", agentName: "Lupita", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, saludo: "Buenas tardes", branches: [],
  entryBranch: null, customer: { isNew: true } as never, fechaHoraLocal: "21 de octubre de 2026, 14:10", diaSemana: "miércoles",
};
const cuenta = (texto: string, parte: string) => texto.split(parte).length - 1;

describe("prompt de WhatsApp con los paquetes A y C", () => {
  const p = buildPmSystemPrompt(base);
  it("incluye A y C, cada uno una sola vez", () => {
    expect(cuenta(p, PROMPT_PM_PAQUETE_A)).toBe(1);
    expect(cuenta(p, PM_PAQUETE_C_PROMPT)).toBe(1);
  });
  it("A (unidades/variantes) va después de C (datos) y antes de los ejemplos", () => {
    const iA = p.indexOf(PROMPT_PM_PAQUETE_A);
    const iC = p.indexOf(PM_PAQUETE_C_PROMPT);
    expect(iC).toBeGreaterThan(-1);
    expect(iA).toBeGreaterThan(iC);
    expect(iA).toBeLessThan(p.indexOf("# CONTEXTO DEL CLIENTE"));
  });
  it("«nunca reembolsos» aparece en ambos de forma consistente: nunca se ofrece reembolso", () => {
    expect(PROMPT_PM_PAQUETE_A).toMatch(/NUNCA reembolsos/);
    expect(PM_PAQUETE_C_PROMPT).toMatch(/reembols/i);
    // toda mención de reembolsos en C es una prohibición («No ofrezca … reembolsos», «PM nunca reembolsa»)
    for (const m of PM_PAQUETE_C_PROMPT.matchAll(/.{0,50}reembols\w*/gi)) expect(m[0], m[0]).toMatch(/\b(?:no|nunca|ni)\b/i);
  });
  it("sin salsas personalizadas A lleva sus salsas; con personalizadas se omiten y C sigue", () => {
    const pers = buildPmSystemPrompt({ ...base, salsasTexto: "roja y verde" });
    expect(pers).toContain(construirPromptPaqueteA({ salsasPersonalizadas: true }));
    expect(pers).toContain(PM_PAQUETE_C_PROMPT);
    expect(pers).not.toContain(PROMPT_PM_PAQUETE_A);
  });
  it("A y C no repiten ningún párrafo completo entre sí", () => {
    const partes = (t: string) => t.split("\n").map((l) => l.trim()).filter((l) => l.length > 60);
    const enC = new Set(partes(PM_PAQUETE_C_PROMPT));
    expect(partes(PROMPT_PM_PAQUETE_A).filter((l) => enC.has(l))).toEqual([]);
  });
});
