// Agente real de Los Taquitos de PM en WhatsApp: perfil cargado por organizacion/sucursal con fallback seguro
// al agente generico, prompt en USTED alineado con el registro unico de tools.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import { AGENT_TOOL_DEFINITIONS } from "../../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../../src/in-memory-repository.ts";
import { FALLBACK_CONFIG, PM_CONFIG_POR_OMISION, createLlmWhatsAppTurnHandler, resolveAgentConfig } from "../../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../../src/whatsapp/perfil-pm.ts";
import type { BranchSummary, CustomerLookupResult } from "../../src/types.ts";

const NEW_CUSTOMER: CustomerLookupResult = { isNew: true };
const BRANCHES: BranchSummary[] = [
  { propertyId: "p1", slug: "t2", name: "Francisco de Montejo", address: "Calle 1 #100" } as BranchSummary,
  { propertyId: "p2", slug: "t8", name: "Victory Altabrisa", address: null } as BranchSummary,
];

function promptPm(over: Partial<Parameters<typeof buildPmSystemPrompt>[0]> = {}) {
  return buildPmSystemPrompt({
    businessName: "Los Taquitos de PM",
    agentName: "Lupita",
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "Buenas tardes",
    branches: BRANCHES,
    entryBranch: { name: "Francisco de Montejo", slug: "t2" },
    customer: NEW_CUSTOMER,
    fechaHoraLocal: "30 de septiembre de 2026, 14:10",
    diaSemana: "miércoles",
    ...over,
  });
}

describe("prompt de PM", () => {
  it("instruye usar la ubicacion compartida (buscar_sucursal_cercana) y mandar la doble salsa en doble_salsas", () => {
    const p = promptPm();
    expect(p).toContain("[Ubicación compartida por WhatsApp]");
    expect(p).toMatch(/buscar_sucursal_cercana sin pedirle la colonia/);
    expect(p).toMatch(/nunca las repita ni las trate como dirección de entrega/);
    expect(p).toMatch(/DOBLE porción de una salsa, es un extra cobrado: mándelo en doble_salsas/);
  });

  it("no contradice las 9 salsas incluidas: habanero y crema de ajo no son 'solo si las pide'", () => {
    const p = promptPm();
    expect(p).not.toMatch(/habanero y la crema de ajo solo si/);
    expect(p).toMatch(/Todas van incluidas por omisión/);
  });

  it("saluda con el nombre de la sucursal y sigue el orden del cuestionario", () => {
    const p = promptPm();
    expect(p).toContain("Buenas tardes, gracias por comunicarse a Los Taquitos de PM, sucursal Francisco de Montejo.");
    const orden = ["¿Para recoger o a domicilio?", "2. Nombre.", "3. Teléfono", "4. Platillos.", "5. Cambios.", "6. Pago:", "7. Sucursal.", "8. Hora."];
    const posiciones = orden.map((t) => p.indexOf(t));
    expect(posiciones.every((x) => x >= 0)).toBe(true);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
  });

  it("sin sucursal de entrada saluda sin inventar una", () => {
    expect(promptPm({ entryBranch: null })).toContain('"Buenas tardes, gracias por comunicarse a Los Taquitos de PM."');
  });

  it("contiene las reglas del dueno: minimo $200, sin envio, sin alcohol a domicilio, promos solo recoger, no modificar platillos, 9 salsas", () => {
    const p = promptPm();
    expect(p).toMatch(/pedido mínimo de \$200/);
    expect(p).toMatch(/No hay costo de envío/);
    expect(p).toMatch(/Nada de alcohol a domicilio/);
    expect(p).toMatch(/Promociones solo para recoger/);
    expect(p).toMatch(/Los platillos no se modifican/);
    expect(p).toMatch(/las 9 salsas/);
    for (const salsa of ["roja", "verde", "mexicana", "guacamolera", "limones", "crema de ajo", "cebolla con cilantro", "piña", "chile habanero"]) expect(p).toContain(salsa);
    for (const m of ["queja", "modificacion_platillo", "transferencia", "tiempos_entrega"]) expect(p).toContain(m);
    expect(p).toMatch(/mucha piña, mucho frijol/);
  });

  it("tiempos: usa el texto configurado, nunca el 'si llueve' del agente generico", () => {
    expect(promptPm({ deliveryTimeText: "de 30 a 40 minutos" })).toContain("de 30 a 40 minutos");
    expect(promptPm()).not.toMatch(/llueve/i);
  });

  it("habla de usted: sin formas de tuteo en las instrucciones al modelo ni en los ejemplos", () => {
    const sinNegativos = promptPm().replace(/no use "oye", "dime", "¿qué onda\?", "mande"/, "");
    expect(sinNegativos).not.toMatch(/\b(tú|tienes|quieres|puedes|necesitas|dime|dame|cuéntame|pásame|mándame)\b/i);
  });

  it("alinea las herramientas con el registro unico: nombra solo tools del registro, ninguna del prompt del experto", () => {
    const p = promptPm();
    const registro = AGENT_TOOL_DEFINITIONS.map((t) => t.name);
    for (const nombre of ["buscar_cliente", "buscar_sucursal_cercana", "buscar_producto", "cotizar_pedido", "confirmar_resumen", "crear_pedido", "escalar_a_humano"]) {
      expect(registro).toContain(nombre);
      expect(p).toContain(nombre);
    }
    for (const viejo of ["buscar_ultimo_pedido", "asignar_sucursal", "consultar_menu", "crear_comanda", "escalar("]) expect(p).not.toContain(viejo);
    // Todo identificador con forma de tool que aparezca en el prompt existe en el registro.
    const mencionados = new Set(p.match(/\b(?:buscar|cotizar|confirmar|crear|escalar|registrar|consultar)_[a-z_]+\b/g) ?? []);
    const permitidos = new Set([...registro, "modificacion_platillo", "tiempos_entrega", "pedido_grande", "zona_no_reconocida", "producto_agotado", "falla_sistema", "no_entiende", "cancelacion_modificacion", "reposicion_descuento", "alergia_salud", "zona_ambigua", "cliente_lo_pide"]);
    for (const m of mencionados) expect(permitidos.has(m)).toBe(true);
  });

  it("no inyecta la direccion guardada del cliente en el prompt", () => {
    const customer: CustomerLookupResult = {
      isNew: false,
      customerId: "c1",
      name: "Luis",
      orderCount: 3,
      tier: "regular",
      addresses: [{ address: "Calle 7 número 210 por el parque", isDefault: true }],
      frequentItems: [{ name: "Taco Al Pastor (individual)", count: 4 }],
      lastOrderItems: [{ name: "Taco Al Pastor (individual)", quantity: 8 }],
    } as unknown as CustomerLookupResult;
    const p = promptPm({ customer });
    expect(p).not.toContain("Calle 7 número 210");
    expect(p).toContain("8x Taco Al Pastor (individual)");
    expect(p).toMatch(/nunca la lea completa/);
  });
});

describe("resolveAgentConfig", () => {
  const org = randomUUID();
  const sucursal = randomUUID();

  it("sin fila (o base sin migrar) cae al agente generico de siempre", async () => {
    const repo = new InMemoryRestaurantesRepository();
    expect(await resolveAgentConfig(repo, org, null)).toBe(FALLBACK_CONFIG);
  });

  it("la fila de la organizacion activa el perfil PM con sus valores por omision", async () => {
    const repo = new InMemoryRestaurantesRepository();
    await repo.upsertWhatsAppAgentConfig(org, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null });
    expect(await resolveAgentConfig(repo, org, null)).toMatchObject({ perfil: "taqueria_pm", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" });
  });

  it("la fila de la sucursal manda sobre la de la organizacion; otra organizacion no la ve", async () => {
    const repo = new InMemoryRestaurantesRepository();
    repo.seedOrganization({ id: org, slug: "pm", name: "PM" });
    repo.seedBranch({ propertyId: sucursal, organizationId: org, name: "T8", slug: "t8", status: "active", phone: null, address: null, lat: null, lng: null });
    await repo.upsertWhatsAppAgentConfig(org, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: null, toneStyle: null, deliveryTimeText: "de 40 a 50 minutos" });
    await repo.upsertWhatsAppAgentConfig(org, sucursal, { perfil: "taqueria_pm", agentName: "Mari", businessName: null, toneStyle: null, deliveryTimeText: "de 50 a 60 minutos" });
    expect(await resolveAgentConfig(repo, org, sucursal)).toMatchObject({ agentName: "Mari", deliveryTimeText: "de 50 a 60 minutos" });
    expect(await resolveAgentConfig(repo, org, null)).toMatchObject({ agentName: "Lupita" });
    expect(await resolveAgentConfig(repo, randomUUID(), sucursal)).toBe(FALLBACK_CONFIG);
  });

  it("rechaza una sucursal de otra organizacion (cross-tenant)", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const otraOrg = randomUUID();
    repo.seedOrganization({ id: org, slug: "pm", name: "PM" });
    repo.seedOrganization({ id: otraOrg, slug: "otra", name: "Otra" });
    repo.seedBranch({ propertyId: sucursal, organizationId: otraOrg, name: "X", slug: "x", status: "active", phone: null, address: null, lat: null, lng: null });
    await expect(repo.upsertWhatsAppAgentConfig(org, sucursal, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null })).rejects.toThrow(/no pertenece/);
  });
});

describe("turno con perfil PM", () => {
  async function turno(conPerfil: boolean) {
    const repo = new InMemoryRestaurantesRepository();
    const organizationId = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "pm", name: "PM" });
    if (conPerfil) await repo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: null, toneStyle: null, deliveryTimeText: null });
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    const vistos: string[] = [];
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: (req) => {
          vistos.push(req.system ?? "");
          return { text: "Con gusto.", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    await handler.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }], customer: NEW_CUSTOMER });
    return vistos[0]!;
  }

  it("con fila de perfil, el modelo recibe el prompt de PM (usted, 9 salsas)", async () => {
    const sistema = await turno(true);
    expect(sistema).toContain("Usted es Lupita de Los Taquitos de PM");
    expect(sistema).not.toContain("Eres el asistente de WhatsApp");
  });

  it("sin fila, el modelo recibe el prompt generico de siempre", async () => {
    const sistema = await turno(false);
    expect(sistema).toContain("Eres el asistente de WhatsApp de este restaurante");
  });
});
