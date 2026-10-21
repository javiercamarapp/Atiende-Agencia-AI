// Paquete B: el bloque de reglas va al prompt real de WhatsApp de PM SOLO con RESTAURANTES_GEOCERCAS=1; apagada, el prompt es identico al de siempre. Sin LLM.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { PM_PAQUETE_B_REGLAS } from "../src/whatsapp/prompt-pm-paquete-b.ts";
import { construirPromptPaqueteA } from "../src/whatsapp/prompt-pm-paquete-a.ts";
import { PM_PAQUETE_C_PROMPT } from "../src/whatsapp/prompt-pm-paquete-c.ts";

const ctx = {
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: [{ propertyId: "p0", slug: "sucursal-a", name: "Sucursal A", address: null }],
  entryBranch: null,
  customer: { isNew: true } as const,
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
};

describe("PM paquete B enlazado al prompt real", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("apagada (por omision): el prompt NO lo trae", () => {
    const apagado = buildPmSystemPrompt(ctx);
    expect(apagado).not.toContain("paquete B");
    expect(apagado).not.toContain(PM_PAQUETE_B_REGLAS);
  });
  it("apagada: el prompt COMPLETO es byte a byte el que produce main (fixture generada desde origin/main, con los paquetes A y C ya fusionados)", () => {
    const deMain = readFileSync(fileURLToPath(new URL("./fixtures/prompt-pm-whatsapp-main.txt", import.meta.url)), "utf8");
    expect(buildPmSystemPrompt(ctx)).toBe(deMain);
  });
  it("encendida: el prompt es el de siempre MAS el bloque, despues del flujo y antes de la escalacion", () => {
    const apagado = buildPmSystemPrompt(ctx);
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    const encendido = buildPmSystemPrompt(ctx);
    expect(encendido.replace(`${PM_PAQUETE_B_REGLAS}\n\n`, "")).toBe(apagado);
    expect(encendido.indexOf(PM_PAQUETE_B_REGLAS)).toBeGreaterThan(encendido.indexOf("# FLUJO DE TOMA DE PEDIDO"));
  });
  it("encendida: conviven A, B y C en el mismo prompt de WhatsApp", () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    const p = buildPmSystemPrompt(ctx);
    expect(p).toContain(construirPromptPaqueteA({ salsasPersonalizadas: false }));
    expect(p).toContain(PM_PAQUETE_B_REGLAS);
    expect(p).toContain(PM_PAQUETE_C_PROMPT);
  });
  it("la voz nunca lo trae (tope de 8000 caracteres)", () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    const voz = buildPmSystemPrompt({ ...ctx, canal: "voz" });
    expect(voz).not.toContain(PM_PAQUETE_B_REGLAS);
    expect(voz.length).toBeLessThanOrEqual(8000);
  });
  it("el modulo no trae datos reales: ni telefonos ni colonias o sucursales", () => {
    expect(PM_PAQUETE_B_REGLAS).not.toMatch(/\d{3}[\s-]?\d{3}[\s-]?\d{4}/);
    expect(PM_PAQUETE_B_REGLAS).not.toMatch(/Cholul|Temozón|Altabrisa|Country|Ceiba|Dzitiá|Santa Fe|Montejo|García Lavín|Pensiones/i);
  });
});
