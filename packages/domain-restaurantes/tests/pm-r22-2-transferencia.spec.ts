// R22 decision 2 (dueno/chats): la transferencia ya NO escala. Se responde que no se acepta, solo efectivo o tarjeta (se envia terminal), y se sigue con el pedido.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { classifyHighRiskIntent } from "../src/whatsapp/guards.ts";
import { comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import { AGENT_TOOL_DEFINITIONS } from "../src/agent-tools/registry.ts";

const branches = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const base = { businessName: PM_CONFIG_POR_OMISION.businessName, agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches };
const wa = buildPmSystemPrompt({ ...base, saludo: "Buenas tardes", entryBranch: null, customer: { isNew: true }, fechaHoraLocal: "lunes 14:00", diaSemana: "lunes" });
const voz = comportamientoVozPm(base);

describe("R22-2 transferencia: no se acepta y no escala", () => {
  it.each([["whatsapp", wa], ["voz", voz]])("%s: dice que no se acepta, solo efectivo o tarjeta, y no la lista entre los motivos de escalacion", (_c, p) => {
    expect(p).toMatch(/Transferencia: (NO se acepta|no se acepta)/);
    expect(p).toMatch(/efectivo o (con )?tarjeta/);
    expect(p).not.toMatch(/Transferencia: escale/);
    expect(p).not.toMatch(/Transferencia solo con autorización del gerente/);
    const motivos = /con estos motivos: ([^\n]+)\./.exec(p) ?? /Motivos: ([^\n]+?)\. /.exec(p);
    expect(motivos?.[1]?.split(", ").map((m) => m.split(" ")[0])).not.toContain("transferencia");
  });
  it("H8 (no decida usted) ya no incluye el pago por transferencia", () => {
    expect(wa).not.toMatch(/H8\.[^\n]*transferencia/);
    expect(voz).not.toMatch(/H8\.[^\n]*transferencia/);
  });
  it("el clasificador determinista de alto riesgo ya no intercepta la transferencia (no hay aviso fijo ni escalacion)", () => {
    for (const frase of ["pago por transferencia", "¿aceptan transferencia?", "quiero pagar por transferencia", "les hago un spei"]) expect(classifyHighRiskIntent(frase)).toBeNull();
  });
  it("la herramienta escalar_a_humano ya no promociona el motivo transferencia en su descripcion", () => {
    const t = AGENT_TOOL_DEFINITIONS.find((d) => d.name === "escalar_a_humano")!;
    expect(JSON.stringify(t)).not.toMatch(/quiere pagar por transferencia/);
  });
});
