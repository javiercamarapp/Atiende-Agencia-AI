// Agente real de Los Taquitos de PM en WhatsApp: perfil cargado por organizacion/sucursal con fallback seguro
// al agente generico, prompt en USTED alineado con el registro unico de tools.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import { AGENT_TOOL_DEFINITIONS } from "../../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../../src/in-memory-repository.ts";
import { FALLBACK_CONFIG, PM_CONFIG_POR_OMISION, createLlmWhatsAppTurnHandler, resolveAgentConfig, saludoSegunHora } from "../../src/whatsapp/llm-turn-handler.ts";
import { PM_PROMOS_POR_OMISION, buildPmSystemPrompt, saludoPorHora } from "../../src/whatsapp/perfil-pm.ts";
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
    expect(p).toMatch(/Por omisión van solo las básicas \(roja, verde, cebolla con cilantro y limones\)/);
    expect(p).toMatch(/Las demás \(crema de ajo, guacamolera, mexicana \(pico de gallo, también le dicen xnipec[^)]*\), piña picada \([^)]*\) y habanero picado o soasado \(le dicen sauceada\)\) van sin costo, pero solo si el cliente las pide/);
  });

  it("saluda con el nombre de la sucursal y sigue el orden del cuestionario", () => {
    const p = promptPm();
    expect(p).toContain("Buenas tardes. Gracias por escribir a Los Taquitos de PM, sucursal Francisco de Montejo, le atiende Lupita, el asistente virtual. ¿Es para recoger o a domicilio?");
    // Orden del cerebro (PM-C3): la sucursal queda definida ANTES de los platillos y la cotizacion va despues de la hora.
    const orden = ["¿Para recoger o a domicilio?", "2. Nombre.", "3. Teléfono", "4. Sucursal y dirección", "5. Platillos.", "6. Cambios.", "7. Pago:", "8. Hora.", "9. Cotizar:"];
    const posiciones = orden.map((t) => p.indexOf(t));
    expect(posiciones.every((x) => x >= 0)).toBe(true);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
  });

  it("sin sucursal de entrada saluda sin inventar una", () => {
    expect(promptPm({ entryBranch: null })).toContain('"Buenas tardes. Gracias por escribir a Los Taquitos de PM, le atiende Lupita, el asistente virtual. ¿Es para recoger o a domicilio?"');
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
    expect(promptPm()).not.toMatch(/si llueve/i);
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


describe("saludoPorHora (X40: el saludo sigue la hora local de Merida)", () => {
  it.each([
    ["11:59", "buenos días"],
    ["12:00", "buenas tardes"],
    ["18:59", "buenas tardes"],
    ["19:00", "buenas tardes"],
    ["19:59", "buenas tardes"],
    ["20:00", "buenas noches"],
    ["00:30", "buenas noches"],
    ["04:59", "buenas noches"],
    ["05:00", "buenos días"],
    ["lunes 18:30", "buenas tardes"],
  ])("%s -> %s", (hora, esperado) => {
    expect(saludoPorHora(hora)).toBe(esperado);
  });

  it("acepta la hora entera y lanza ante un valor que no es hora (nunca saluda mal en silencio)", () => {
    expect(saludoPorHora(9)).toBe("buenos días");
    expect(() => saludoPorHora(24)).toThrow(RangeError);
    expect(() => saludoPorHora("mediodia")).toThrow(RangeError);
    expect(() => saludoPorHora("25:00")).toThrow(RangeError);
  });

  it("el saludo de WhatsApp (saludoSegunHora) usa la misma regla con la zona del negocio", () => {
    // 2026-10-02 17:30 UTC = 11:30 en Merida (UTC-6): buenos dias; 18:00 UTC = 12:00: tardes; 02:00 UTC del dia 3 = 20:00: noches (VZ17: tardes llega hasta las 19:59).
    expect(saludoSegunHora("America/Merida", new Date("2026-10-02T17:30:00Z"))).toBe("Buenos días");
    expect(saludoSegunHora("America/Merida", new Date("2026-10-02T18:00:00Z"))).toBe("Buenas tardes");
    expect(saludoSegunHora("America/Merida", new Date("2026-10-03T01:00:00Z"))).toBe("Buenas tardes");
    expect(saludoSegunHora("America/Merida", new Date("2026-10-03T02:00:00Z"))).toBe("Buenas noches");
  });

  it("el prompt saluda con la franja que recibe, aunque llegue en minusculas", () => {
    expect(promptPm({ saludo: saludoPorHora("20:10") })).toContain("Buenas noches. Gracias por escribir a Los Taquitos de PM, sucursal Francisco de Montejo, le atiende Lupita, el asistente virtual.");
  });
});

describe("prompt de PM (PM-C3): contenido del cerebro, sin aflojar reglas vigentes", () => {
  const p = promptPm();

  it("tortilla mixta (mitad y mitad) y las tres opciones", () => {
    expect(p).toContain("mixta");
    expect(p).toMatch(/maíz, harina o mixta \(mitad y mitad\)/);
  });

  it("el combo del martes lo aplica cotizar_pedido (CR09): el agente dice lo que devuelve y no lo promete si la cotizacion no lo muestra", () => {
    expect(p).not.toContain("la confirma la sucursal al recoger");
    expect(p).not.toMatch(/no lo prometa ni lo aplique|cotice los nachos a precio de lista/);
    expect(p).toMatch(/H13\. Combo del martes \(nachos de pastor con 2 aguas de cortesía POR CADA orden completa de nachos, solo para recoger: 2 órdenes = 4 aguas\): lo aplica cotizar_pedido; diga lo que devuelve y cuente las aguas por orden\./);
    expect(p).toMatch(/Si el cliente pide el combo y la cotización no lo muestra .* no lo prometa/);
  });

  it("las promociones por omision valen en TODAS las sucursales: lunes 2x1 y martes nachos con 2 aguas, solo recoger (CR07/CR08)", () => {
    expect(PM_PROMOS_POR_OMISION).toBe("lunes 2x1 en tacos al pastor y martes nachos de pastor con 2 aguas de cortesía; solo para recoger, en todas las sucursales");
    expect(PM_PROMOS_POR_OMISION).not.toMatch(/Francisco de Montejo|Pensiones|Galerías/);
  });

  it("ya no afirma 'Precios iguales' ni prohibe dar horarios por sucursal: el horario y el precio los da la herramienta", () => {
    expect(p).not.toContain("Precios iguales");
    expect(p).not.toContain("No dé horarios más finos");
    expect(p).not.toContain("todos los días de 12:00 del día a 1:00 de la madrugada");
    expect(p).toMatch(/el horario y el precio de cada una los da la herramienta/);
  });

  it("lista las 7 sucursales del mapa (T4 solo informativa, T5 de temporada) con su telefono publico", () => {
    for (const nombre of ["Prolongación Montejo", "Francisco de Montejo", "Pensiones", "Galerías", "Playa", "García Lavín", "Victory Altabrisa"]) expect(p).toContain(nombre);
    for (const tel of ["999 944 0342", "999 953 7122", "999 987 5410", "999 941 9612", "969 688 4195", "999 518 2637", "999 518 2857"]) expect(p).toContain(tel);
    expect(p).toMatch(/Galerías \(999 941 9612\): solo informativa/);
    expect(p).toMatch(/Playa, Chicxulub \(969 688 4195\): de temporada/);
  });

  it("H2 conserva la prohibicion de alcohol para recoger y H8 las alergias (sin cambios hasta P17)", () => {
    expect(p).toContain("adquirirlo directamente en la sucursal al recoger");
    expect(p).toMatch(/H8\. No decida usted:.*alergias\. Todo eso se escala/);
    expect(p).toContain("alergia_salud");
  });

  it("H16: el horario sale solo de los datos de la sucursal (consultar_sucursal / rechazo de la cotizacion), nunca de un texto fijo del prompt", () => {
    // Regresion del eval real (12/68): el prompt fijaba "6 pm" para Pensiones y Fco. Montejo y el agente rechazaba pedidos de tarde
    // aunque la herramienta dijera abierto. No debe quedar ninguna franja horaria fija por sucursal.
    expect(p).not.toMatch(/HORARIO PARA TOMAR PEDIDOS/);
    expect(p).not.toMatch(/de 6 pm a (12|1) am|todos los días de 12 pm a 1 am/);
    expect(p).not.toMatch(/lunes a viernes de 6 pm/);
    expect(p).toMatch(/H16\. Horario: lo dicen SOLO los datos de la sucursal/);
    expect(p).toMatch(/consultar_sucursal \(abierto_ahora, cierra_a, horario\)/);
    expect(p).toMatch(/solo si la entrega \(con el tiempo de la sucursal, ver paso 8\) cae antes de esa hora/);
    expect(p).toMatch(/no tome el pedido ni lo deje programado para la apertura/);
    expect(p).toMatch(/Horario: no lo afirme de memoria: lo da consultar_sucursal/);
  });

  it("umbral de pedido grande: 40 piezas o $1,500 se queda, sin rechazar el pedido (lo confirma la sucursal)", () => {
    expect(p).toMatch(/Pedido grande \(más de \$4,000 o más de 5 kg; más de \$2,500 si el número no tiene historial y paga en efectivo/);
    expect(p).toMatch(/no lo rechace; tome todos los datos y escale \(pedido_grande\) para que la sucursal lo confirme/);
  });

  it("hora de recogida con el parametro estructurado hora_recogida, no en notes", () => {
    expect(p).toContain("hora_recogida");
    expect(p).not.toContain("Recoge a las 7:30 pm");
    expect(p).toMatch(/no en notes/);
    expect(p).toMatch(/la hora de recoger va en hora_recogida/);
  });

  it("nunca inventar folio, lluvia, repartidor, precio viejo, presentaciones y alias", () => {
    expect(p).toMatch(/Nunca invente un folio/);
    expect(p).toMatch(/Si el cliente dice que llueve, avísele que con lluvia puede tardar un poco más que lo normal: el tiempo de la sucursal \(paso 8\) más unos 20 minutos/);
    expect(p).toMatch(/no la mencione por su cuenta/);
    expect(p).toMatch(/El cliente no elige repartidor/);
    expect(p).toContain("El precio vigente es de $X");
    expect(p).toMatch(/"una orden de pastor", pregunte cuántos tacos/);
    expect(p).toMatch(/"un agua" sin más es ambiguo/);
    expect(p).toMatch(/Media orden solo de nachos y frijoles charros/);
  });

  it("FAQ con los contactos publicos de eventos, factura y empleo (sin escalar)", () => {
    expect(p).toContain("eventos@lostaquitosdepm.com");
    expect(p).toContain("facturas@lostaquitosdepm.com");
    expect(p).toContain("recursos.humanos@lostaquitosdepm.com");
    expect(p).toMatch(/Dé el contacto sin escalar/);
  });

  it("fase 1: un pedido de otra sucursal no se toma, se da el telefono de la que le toca", () => {
    expect(p).toMatch(/H17\. Pedido de otra sucursal.*NO tome el pedido para esa sucursal/);
  });

  it("el aviso de privacidad lo pone el sistema una sola vez: el prompt no lo repite ni inventa un enlace", () => {
    expect(p).toMatch(/lo antepone el sistema una sola vez/);
    expect(p).not.toMatch(/https?:\/\//);
  });

  it("el flujo es coherente: ninguna referencia a un paso que ya no existe", () => {
    expect(p).toContain("(paso 4)");
    expect(p).not.toContain("(paso 7)");
  });
});

describe("QA-PM-R4: reglas de prompt de WhatsApp que no entran a la voz (limite de 8000 caracteres)", () => {
  it("WhatsApp lleva propina en porcentaje, tiempo unico, no dar 'a partir de las 12' con la sucursal abierta, pedido ya salido, menu con precios y minimo propio", () => {
    const p = promptPm();
    expect(p).toContain("propina_porcentaje");
    expect(p).toMatch(/NO conteste "sí" ni garantice ese plazo/);
    expect(p).toMatch(/NUNCA diga "a partir de las 12 del día"/);
    expect(p).toMatch(/YA SALIÓ a reparto \(o está entregado\), no dé minutos/);
    expect(p).toMatch(/3 o 4 platillos con su precio REAL/);
    expect(p).toMatch(/dígalo usted antes de que el cliente lo deduzca/);
    expect(p).toMatch(/Antes de escalar, cotice con cotizar_pedido/);
    expect(p).toMatch(/no repita el rechazo ni el teléfono de la otra/);
  });
  it("la voz NO recibe esas reglas (tope de 8000 caracteres)", () => {
    const p = promptPm({ canal: "voz" });
    expect(p).not.toContain("propina_porcentaje");
    expect(p).not.toMatch(/3 o 4 platillos con su precio REAL/);
  });
});
