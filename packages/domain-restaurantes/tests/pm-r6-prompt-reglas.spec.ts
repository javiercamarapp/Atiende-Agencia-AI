// QA-PM-R6-voz-06/07: reglas de trato (sin genero) y de cantidades enormes presentes en el prompt de voz y en el de WhatsApp.
import { describe, expect, it } from "vitest";
import { PM_REGLA_CANTIDAD_ENORME, PM_REGLA_SIN_GENERO, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { REGLAS_VIVAS_VOZ } from "../src/voz/perfil-voz-pm.ts";

describe("reglas de trato y cantidades enormes", () => {
  it("la voz las lleva en el bloque no borrable", () => {
    expect(REGLAS_VIVAS_VOZ).toContain(PM_REGLA_SIN_GENERO);
    expect(REGLAS_VIVAS_VOZ).toContain(PM_REGLA_CANTIDAD_ENORME);
  });
  it("WhatsApp las lleva en su prompt completo", () => {
    const p = buildPmSystemPrompt({ canal: "whatsapp", businessName: "Los Taquitos de PM", agentName: "Asistente", deliveryTimeText: "60 a 75 minutos", saludo: "Buenas tardes", branches: [], entryBranch: null, customer: { isNew: true } } as never);
    expect(p).toContain(PM_REGLA_SIN_GENERO);
    expect(p).toContain(PM_REGLA_CANTIDAD_ENORME);
  });
  it("las reglas nombran lo prohibido y el camino correcto", () => {
    expect(PM_REGLA_SIN_GENERO).toMatch(/señora/);
    expect(PM_REGLA_CANTIDAD_ENORME).toMatch(/pedido_grande/);
  });
});
