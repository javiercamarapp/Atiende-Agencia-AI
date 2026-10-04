import { describe, expect, it } from "vitest";
import { buildComplementNotes, PM_BASIC_COMPLEMENTS } from "../src/order-quote.ts";
import { AGENT_TOOL_DEFINITIONS, mapCreateOrderToolInput } from "../src/agent-tools/registry.ts";

describe("comanda con perfil de básicas (PM)", () => {
  it("sin pedidas imprime solo las 4 básicas", () => {
    expect(buildComplementNotes(undefined, [], [], PM_BASIC_COMPLEMENTS)).toBe("Básicas: salsa roja, salsa verde, cebolla con cilantro, limones.");
  });

  it("separa lo pedido de las básicas y lo marca sin costo", () => {
    const notes = buildComplementNotes(undefined, ["salsa_guacamolera", "pina", "salsa_habanero_soasado"], [], PM_BASIC_COMPLEMENTS);
    expect(notes).toContain("Básicas: salsa roja, salsa verde, cebolla con cilantro, limones.");
    expect(notes).toContain("Pedidas (sin costo): salsa guacamolera, piña picada, salsa habanero soasada.");
  });

  it("respeta omit_default_complements sobre las básicas y lo pedido gana a una omisión contradictoria", () => {
    expect(buildComplementNotes(undefined, [], ["salsa_verde", "limones"], PM_BASIC_COMPLEMENTS)).toBe("Básicas: salsa roja, cebolla con cilantro.");
    expect(buildComplementNotes(undefined, ["crema_ajo"], ["salsa_verde"], PM_BASIC_COMPLEMENTS)).toContain("Pedidas (sin costo): crema de ajo.");
  });

  it("sin nada que enviar lo dice, y un valor desconocido del modelo nunca llega a la comanda", () => {
    expect(buildComplementNotes(undefined, [], ["salsa_roja", "salsa_verde", "cebolla", "limones"], PM_BASIC_COMPLEMENTS)).toBe("No enviar complementos de cortesía.");
    const notes = buildComplementNotes(undefined, ["__proto__", "salsa_secreta"] as never, [], PM_BASIC_COMPLEMENTS);
    expect(notes).not.toMatch(/undefined|salsa_secreta|__proto__|Pedidas/);
  });

  it("sin perfil conserva el comportamiento histórico (las 9 incluidas)", () => {
    expect(buildComplementNotes(undefined, [], [])).toMatch(/^Complementos incluidos: .*crema de ajo.*habanero/);
  });
});

describe("crear_pedido: complementos pedidos", () => {
  it("la herramienta acepta la lista cerrada de complementos pedidos", () => {
    const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === "crear_pedido")!;
    const items = (def.parameters as { properties: { requested_complements: { items: { enum: string[] } } } }).properties.requested_complements.items.enum;
    expect(items).toEqual(expect.arrayContaining(["salsa_guacamolera", "salsa_mexicana", "salsa_pina", "pina", "salsa_habanero_soasado", "crema_ajo", "salsa_habanero"]));
  });

  it("WhatsApp y voz mandan el perfil de básicas; el checkout web conserva las 9", () => {
    const base = { organizationId: "o", phone: "5219990000000" } as const;
    expect(mapCreateOrderToolInput({ ...base, channel: "whatsapp" }, {}, true).basicComplements).toEqual(PM_BASIC_COMPLEMENTS);
    expect(mapCreateOrderToolInput({ ...base, channel: "voz" }, {}, false).basicComplements).toEqual(PM_BASIC_COMPLEMENTS);
    expect(mapCreateOrderToolInput({ ...base, channel: "web", phone: null }, {}, false).basicComplements).toBeUndefined();
  });
});
