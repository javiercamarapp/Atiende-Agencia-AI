// PM R24 (T7-026 en la nube, 2 de 6 repeticiones): el cliente escribe «mi cel es 999...» (distinto al del chat) y el agente ESCALABA («por seguridad el pedido se registra con el numero
// de esta conversacion») y dejaba el pedido sin crear. Un numero dictado no es una escalacion: el pedido sigue con el del chat y el otro va como telefono_alterno.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";

const prompt = buildPmSystemPrompt({
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }],
  entryBranch: null,
  customer: { isNew: true },
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
});

describe("R24: un número distinto al del chat no se escala", () => {
  it("el prompt manda seguir el pedido y guardar el otro número como telefono_alterno, sin escalar", () => {
    expect(prompt).toMatch(/Si el cliente dicta OTRO número/);
    expect(prompt).toMatch(/telefono_alterno/);
    expect(prompt).toMatch(/NO escale ni se niegue por eso/);
  });
});
