// PM R13 Q6 (T7-026): ante «¿la tortilla del kilo va aparte?» Luna contestó «incluida, no se cobra aparte» y Gem «va empacada por separado para que no se remojen»:
// dato que no está en el prompt ni en el menú (H6). Decisión de Javier (R13, «hazlo según tu recomendación»): el bot NO describe cómo viaja la tortilla ni si va aparte
// o incluida si el menú no lo dice; si preguntan, «la sucursal le confirma cómo se entrega la tortilla». Asunción a confirmar con PM: no hay una frase oficial
// de PM sobre el empaque de la tortilla del kilo. Esta prueba ata que el PROMPT lo diga. Determinista, sin LLM.
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

describe("PM R13 Q6: el bot no inventa cómo viaja la tortilla del kilo", () => {
  it("prohíbe describir cómo viaja la tortilla o si va aparte o incluida si el menú no lo dice", () => {
    expect(prompt).toMatch(/NO describa cómo viaja la tortilla ni si va aparte o incluida/);
  });

  it("manda decir «la sucursal le confirma cómo se entrega la tortilla» cuando pregunten", () => {
    expect(prompt).toContain("la sucursal le confirma cómo se entrega la tortilla");
  });

  it("prohíbe inventar «empacada aparte para que no se remoje»", () => {
    expect(prompt).toMatch(/nunca invente[^.]*empacada aparte para que no se remoje/i);
  });
});
