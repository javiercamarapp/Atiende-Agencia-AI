// PM R13 Q6 (T7-026): ante «¿la tortilla del kilo va aparte?» un modelo contestó «incluida, no se cobra aparte» y otro «va empacada por separado para que no se remojen».
// El menú SÍ dice, en los 30 kilos, «Incluye salsa roja, salsa verde, limones y tortillas.»: eso se puede repetir («el kilo incluye tortillas»); lo que el menú NO dice es cómo
// viajan (aparte, empacadas, para que no se remojen) y eso es un dato inventado (H6). Decisión de Javier (R13, «hazlo según tu recomendación»): el bot dice lo que el menú dice y NO
// describe cómo viajan las tortillas; a esa pregunta responde «la sucursal le confirma cómo se entrega la tortilla». Esta prueba ata que el PROMPT lo diga. Determinista, sin LLM.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../src/types.ts";

const SUCURSALES: BranchSummary[] = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const prompt = buildPmSystemPrompt({
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: SUCURSALES,
  entryBranch: null,
  customer: { isNew: true },
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
});

describe("PM R13 Q6 + decisión Q7: el bot dice que la tortilla va aparte y que el kilo la incluye, sin inventar conteos ni empaque", () => {
  it("permite decir lo que el menú dice: «el kilo incluye tortillas»", () => {
    expect(prompt).toContain("«Incluye salsa roja, salsa verde, limones y tortillas»");
    expect(prompt).toContain("«el kilo incluye tortillas»");
  });

  it("permite decir que las tortillas van aparte de la carne (decisión de PM, todas las sucursales, solo kilos)", () => {
    expect(prompt).toContain("Puede decir que las tortillas van aparte de la carne y que el kilo las incluye");
    expect(prompt).toContain("Las tortillas van aparte de la carne; el kilo las incluye. ¿Las quiere de maíz, de harina o mixtas?");
    expect(prompt).toContain("vale para todas las sucursales y solo para los kilos, nunca para tacos, gringas ni platillos");
  });

  it("sigue prohibiendo conteos y empaque de las tortillas, y que se cobren aparte", () => {
    expect(prompt).toMatch(/NO diga cuántas tortillas son ni cómo se empacan/);
    expect(prompt).toContain("La tortilla no se cobra aparte.");
    expect(prompt).not.toMatch(/NO describa cómo viajan las tortillas/);
  });

  it("manda responder «la sucursal le confirma cómo se entrega la tortilla» cuando pregunten", () => {
    expect(prompt).toContain("la sucursal le confirma cómo se entrega la tortilla");
  });
});
