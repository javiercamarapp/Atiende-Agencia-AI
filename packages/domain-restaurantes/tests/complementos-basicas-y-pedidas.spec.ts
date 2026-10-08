import { describe, expect, it } from "vitest";
import { buildComplementNotes, canonicalRequestedComplement, PM_BASIC_COMPLEMENTS } from "../src/order-quote.ts";
import { matchesProductSearch, tokenizeForProductSearch } from "../src/product-search.ts";
import { AGENT_TOOL_DEFINITIONS, executeAgentToolSafely, mapCreateOrderToolInput } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

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
    const items = (def.parameters as unknown as { properties: { requested_complements: { items: { enum: string[] } } } }).properties.requested_complements.items.enum;
    expect(items).toEqual(expect.arrayContaining(["salsa_guacamolera", "salsa_mexicana", "salsa_pina", "pina", "salsa_habanero_soasado", "crema_ajo", "salsa_habanero"]));
  });

  it("WhatsApp y voz mandan el perfil de básicas; el checkout web conserva las 9", () => {
    const base = { organizationId: "o", phone: "5219990000000" } as const;
    expect(mapCreateOrderToolInput({ ...base, channel: "whatsapp" }, {}, true).basicComplements).toEqual(PM_BASIC_COMPLEMENTS);
    expect(mapCreateOrderToolInput({ ...base, channel: "voz" }, {}, false).basicComplements).toEqual(PM_BASIC_COMPLEMENTS);
    expect(mapCreateOrderToolInput({ ...base, channel: "web", phone: null }, {}, false).basicComplements).toBeUndefined();
  });
});

describe("las básicas de la comanda son del perfil taqueria_pm", () => {
  const crear = (f: ReturnType<typeof buildRestaurantFixture>) =>
    executeAgentToolSafely(f.repo, { organizationId: f.organizationId, phone: "9991234567", channel: "whatsapp" }, "crear_pedido", {
      branch_slug: "fco-montejo",
      customer_name: "Cliente Sintético",
      customer_address: "Calle 50 #200",
      colonia_entrega: "Centro",
      payment_method: "efectivo",
      canal: "domicilio",
      items: [{ product_id: f.products.tacosPastor, requested_quantity: 3, tortilla: "maiz" }],
    });
  const notas = async (f: ReturnType<typeof buildRestaurantFixture>, o: { orderId: string | null }) => String((await f.repo.findOrderById(f.organizationId, o.orderId ?? ""))?.notes ?? "");

  it("sin configuración o con perfil genérico imprime las 9 incluidas, no «Básicas»", async () => {
    const f = buildRestaurantFixture();
    const sinConfig = await crear(f);
    expect(await notas(f, sinConfig)).toMatch(/Complementos incluidos:/);
    expect(await notas(f, sinConfig)).not.toMatch(/Básicas:/);
    const g = buildRestaurantFixture();
    await g.repo.upsertWhatsAppAgentConfig(g.organizationId, null, { perfil: "generico", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null });
    const generico = await crear(g);
    expect(await notas(g, generico)).toMatch(/Complementos incluidos:/);
    expect(await notas(g, generico)).not.toMatch(/Básicas:/);
  });

  it("con perfil taqueria_pm la comanda lleva «Básicas»", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null });
    // CR12: con perfil PM el domicilio exige zonas de reparto cargadas (o pin); la sucursal del fixture recibe una zona.
    const zona = await f.repo.createKnownZone(f.organizationId, { name: "Centro", lat: 20.97, lng: -89.62 });
    await f.repo.replaceBranchDeliveryZones(f.organizationId, f.propertyId, [zona.id]);
    const pm = await crear(f);
    expect(await notas(f, pm)).toMatch(/Básicas:/);
  });
});

describe("jerga de salsas y de platillos de T7", () => {
  it.each([
    ["xnipec", "salsa_mexicana"],
    ["cebolla con tomate y limón", "salsa_mexicana"],
    ["sauceada", "salsa_habanero_soasado"],
    ["suasada", "salsa_habanero_soasado"],
    ["habanero", "salsa_habanero"],
    ["Piña", "pina"],
    ["salsa de piña", "salsa_pina"],
    ["crema de ajo", "crema_ajo"],
    ["salsa_guacamolera", "salsa_guacamolera"],
  ])("«%s» es %s", (dicho, canonico) => {
    expect(canonicalRequestedComplement(dicho)).toBe(canonico);
  });

  it("lo desconocido se descarta", () => {
    expect(canonicalRequestedComplement("salsa secreta")).toBeNull();
    expect(canonicalRequestedComplement(42)).toBeNull();
  });

  it("el mapeo de crear_pedido normaliza la jerga y RECHAZA lo desconocido (R3 reglas-09: antes se descartaba en silencio)", () => {
    const ctx = { organizationId: "o", phone: "5219990000000", channel: "whatsapp" as const };
    const out = mapCreateOrderToolInput(ctx, { requested_complements: ["xnipec", "sauceada"] }, true);
    expect(out.requestedComplements).toEqual(["salsa_mexicana", "salsa_habanero_soasado"]);
    expect(() => mapCreateOrderToolInput(ctx, { requested_complements: ["xnipec", "nada que ver"] }, true)).toThrow(/nada que ver/);
  });

  const charros = { name: "Frijoles Charros Normal (1/2 orden)", description: null, categoryName: "Frijoles Charros", searchKeywords: [] };
  const charrosCompleta = { name: "Frijoles Charros Normal", description: null, categoryName: "Frijoles Charros", searchKeywords: [] };
  const nachos = { name: "Nachos de Pastor", description: null, categoryName: "Nachos", searchKeywords: [] };

  it("«medios charros» encuentra la media orden y no la completa", () => {
    const tokens = tokenizeForProductSearch("medios charros");
    expect(matchesProductSearch(tokens, charros)).toBe(true);
    expect(matchesProductSearch(tokens, charrosCompleta)).toBe(false);
  });

  it("«nachos grandes» encuentra la orden completa (grande no es parte del nombre)", () => {
    const tokens = tokenizeForProductSearch("unos nachos grandes de pastor");
    expect(tokens).not.toContain("grande");
    expect(matchesProductSearch(tokens, nachos)).toBe(true);
  });

  it("«grande» fuera de estos platillos no se pierde", () => {
    expect(tokenizeForProductSearch("coca grande")).toContain("grande");
  });
});
