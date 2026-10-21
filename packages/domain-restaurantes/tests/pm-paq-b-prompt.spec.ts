// Paquete B: el prompt REAL de WhatsApp de PM (buildPmSystemPrompt) lleva las reglas de ubicacion y cobertura, despues de las reglas duras y el flujo; la voz (con tope de caracteres) no.
// Higiene del modulo: sin telefonos ni zonas reales (salen de la configuracion y de las herramientas). Sin LLM.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { PM_PAQUETE_B_REGLAS, PM_PAQUETE_B_REGLAS_VOZ, bloquePaqueteB } from "../src/whatsapp/prompt-pm-paquete-b.ts";

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
  const prompt = buildPmSystemPrompt(ctx);
  it("el prompt de WhatsApp trae el bloque, despues del flujo de toma de pedido", () => {
    expect(prompt).toContain(PM_PAQUETE_B_REGLAS);
    expect(prompt.indexOf(PM_PAQUETE_B_REGLAS)).toBeGreaterThan(prompt.indexOf("# FLUJO DE TOMA DE PEDIDO"));
  });
  it("el bloque aparece una sola vez", () => {
    expect(prompt.split("# UBICACIÓN Y COBERTURA (paquete B").length).toBe(2);
  });
  it("el comportamiento de voz no lo trae (tiene tope de 8000 caracteres)", () => {
    const voz = buildPmSystemPrompt({ ...ctx, canal: "voz" });
    expect(voz).not.toContain(PM_PAQUETE_B_REGLAS);
    expect(voz.length).toBeLessThanOrEqual(8000);
  });
  it("bloquePaqueteB elige por canal", () => {
    expect(bloquePaqueteB("whatsapp")).toBe(PM_PAQUETE_B_REGLAS);
    expect(bloquePaqueteB("voz")).toBe(PM_PAQUETE_B_REGLAS_VOZ);
  });
  it("no trae datos reales: ni telefonos ni nombres de colonias o sucursales", () => {
    for (const t of [PM_PAQUETE_B_REGLAS, PM_PAQUETE_B_REGLAS_VOZ]) {
      expect(t).not.toMatch(/\d{3}[\s-]?\d{3}[\s-]?\d{4}/);
      expect(t).not.toMatch(/Cholul|Temozón|Altabrisa|Country|Ceiba|Dzitiá|Santa Fe|Montejo|García Lavín|Pensiones/i);
    }
  });
});
