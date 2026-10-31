// NU-3 (solo WhatsApp: la regla compacta de voz no cabe en el tope de 8000 caracteres de branch_voice_config; alla la terminal ya se menciona al pagar).
// NU-3 (decision de Javier, 21-oct): con pago con tarjeta el agente SI avisa que llevan terminal, a domicilio y al recoger. Con la maquina de cierre OFF no hay resumen
// canonico del servidor: lo arma el modelo, asi que la regla vive en el prompt. Con efectivo no se menciona terminal como cobro.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../src/types.ts";

const SUCURSALES: BranchSummary[] = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const prompt = (canal?: "voz"): string =>
  buildPmSystemPrompt({
    businessName: PM_CONFIG_POR_OMISION.businessName,
    agentName: "el asistente virtual",
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "Buenas tardes",
    branches: SUCURSALES,
    entryBranch: null,
    customer: { isNew: true },
    fechaHoraLocal: "lunes 14:00",
    diaSemana: "lunes",
    ...(canal ? { canal } : {}),
  });

describe("NU-3: el prompt exige avisar que llevan terminal al pagar con tarjeta", () => {
  it("la regla de pago de WhatsApp pide avisar la terminal con tarjeta, a domicilio y al recoger, y no con efectivo", () => {
    const p = prompt();
    expect(p).toMatch(/avise SIEMPRE[^.]*llevan terminal[^.]*a domicilio[^.]*al recoger/);
    expect(p).toMatch(/con efectivo no mencione terminal/i);
  });

  it("el prompt de voz no trae la frase nueva del resumen de recoger", () => {
    expect(prompt("voz")).not.toContain("Tendremos terminal");
  });
});
