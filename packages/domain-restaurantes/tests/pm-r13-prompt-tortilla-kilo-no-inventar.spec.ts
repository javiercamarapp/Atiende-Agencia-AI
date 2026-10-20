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

describe("PM R13 Q6: el bot repite lo que el menú dice de la tortilla del kilo y no inventa cómo viaja", () => {
  it("permite decir lo que el menú dice: «el kilo incluye tortillas»", () => {
    expect(prompt).toContain("«Incluye salsa roja, salsa verde, limones y tortillas»");
    expect(prompt).toContain("«el kilo incluye tortillas»");
  });

  it("prohíbe describir cómo viajan las tortillas: ni aparte, ni empacadas, ni para que no se remojen", () => {
    expect(prompt).toMatch(/NO describa cómo viajan las tortillas \(ni aparte, ni empacadas, ni «para que no se remojen»\)/);
  });

  it("manda responder «la sucursal le confirma cómo se entrega la tortilla» cuando pregunten", () => {
    expect(prompt).toContain("la sucursal le confirma cómo se entrega la tortilla");
  });
});
