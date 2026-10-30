// R22 decision 1 (dueno/chats reales): el agente NUNCA pregunta por la propina (en los chats reales de T7 se pregunto 0 de ~50 veces).
// Solo si el cliente la menciona responde que se da en la terminal (tarjeta) o en efectivo al repartidor. Misma regla en WhatsApp y voz.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION, branchChannelRules } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";

const branches = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const wa = buildPmSystemPrompt({
  businessName: PM_CONFIG_POR_OMISION.businessName, agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes", branches, entryBranch: null, customer: { isNew: true }, fechaHoraLocal: "lunes 14:00", diaSemana: "lunes",
});
const voz = comportamientoVozPm({ businessName: PM_CONFIG_POR_OMISION.businessName, agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches });

describe("R22-1 propina: nunca se pregunta", () => {
  it.each([["whatsapp", wa], ["voz", voz]])("%s: prohibe preguntar propina y dice donde se da si el cliente la menciona", (_c, p) => {
    expect(p).toMatch(/nunca pregunte (por la )?propina/i);
    expect(p).toMatch(/terminal/);
    expect(p).toMatch(/efectivo al repartidor/);
    expect(p).not.toMatch(/pregunte si desea propina/);
    expect(p).not.toMatch(/propina solo con tarjeta/i);
  });
  it("la regla por sucursal del handler tampoco manda preguntar propina con tarjeta", () => {
    const r = branchChannelRules({ name: "García Lavín", slug: "garcia-lavin" });
    expect(r).toMatch(/nunca preguntes por la propina/);
    expect(r).not.toMatch(/pregunta por la propina únicamente/);
  });
});
