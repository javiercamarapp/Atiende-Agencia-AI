// Casos B.1 del original (extraccion-atiende-restaurantes.md §B.1) que hoy no tenian prueba con nombre en main:
// X07, X21, X24, X27, X29, X30, X31, X33, X36, X46-X54. Se escriben con el guion de LLM simulado y la maquina de voz.
// it.fails = defecto o brecha vigente en main que cierra el lote nombrado (R1 = rescate-orig-restaurantes-1,
// C = voz); al entrar ese PR se quita `.fails`.
import { describe, expect, it, vi } from "vitest";
import { evaluarLlamada } from "../../src/voz/simulador/graders-voz.ts";
import { correrGuion } from "../../src/voz/simulador/correr-guion.ts";
import { GUIONES_ES_MX } from "../../src/voz/simulador/guiones-es-mx.ts";
import { CallStateMachine } from "../../src/voz/llamada/maquina.ts";
import { OrderFlowViolationError } from "../../src/agent-tools/order-flow.ts";
import { invokeAgentTool } from "../../src/agent-tools/registry.ts";
import { lookupCustomer } from "../../src/customers.ts";
import { runDemoWidgetTurn, DemoWidgetValidationError } from "../../src/demo/widget.ts";
import { requiresAdultConfirmation } from "../../src/product-search.ts";
import { createOrder, quoteOrder, searchProducts } from "../../src/orders.ts";
import { construirPayloadComanda } from "../../src/softrestaurant/outbox-service.ts";
import { MapaProductoCodigo } from "../../src/softrestaurant/catalog-map.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import { GeminiLiveProvider } from "../../src/index.ts";
import { FALLBACK_CONFIG, PM_CONFIG_POR_OMISION, buildSystemPrompt } from "../../src/whatsapp/llm-turn-handler.ts";
import { pmCustomerContextBlock } from "../../src/whatsapp/perfil-pm.ts";
import type { WhatsAppTurnHandler } from "../../src/whatsapp/turn-handler.ts";
import type { CustomerLookupResult } from "../../src/types.ts";
import { NEW_CUSTOMER, scriptedHandler } from "../pm/harness.ts";
import { item, pedido, pmFixture } from "./fixture.ts";

const PHONE = "+5219990000000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctx = (f: ReturnType<typeof pmFixture>, turn: string) => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: PHONE, flow: { key: `wa:${PHONE}`, turn } });
const itemsTool = (f: ReturnType<typeof pmFixture>) => [{ product_id: f.p.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
const codigoDe = (e: unknown) => (e as OrderFlowViolationError).code;

describe("X07 -- la maquina impide pagar/crear antes de cotizar y confirmar", () => {
  it("X07: crear_pedido sin cotizacion previa se rechaza (sin_cotizacion) y no crea pedido ni cliente", async () => {
    const f = pmFixture();
    const err = await invokeAgentTool(f.repo, ctx(f, "1"), "crear_pedido", { branch_slug: "t1-montejo", customer_name: "Marcela", canal: "recoger", items: itemsTool(f), payment_method: "efectivo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderFlowViolationError);
    expect(codigoDe(err)).toBe("sin_cotizacion");
    expect(await f.repo.findCustomerByPhone(f.organizationId, "9990000000")).toBeNull();
  });

  it("X07: cotizar y crear en el MISMO turno (sin que el cliente conteste) se rechaza; confirmar tambien", async () => {
    const f = pmFixture();
    await invokeAgentTool(f.repo, ctx(f, "1"), "cotizar_pedido", { branch_slug: "t1-montejo", canal: "recoger", items: itemsTool(f) });
    const crear = await invokeAgentTool(f.repo, ctx(f, "1"), "crear_pedido", { branch_slug: "t1-montejo", customer_name: "Marcela", canal: "recoger", items: itemsTool(f), payment_method: "efectivo" }).catch((e: unknown) => e);
    expect(codigoDe(crear)).toBe("sin_confirmacion");
    const confirmar = await invokeAgentTool(f.repo, ctx(f, "1"), "confirmar_resumen", {}).catch((e: unknown) => e);
    expect(codigoDe(confirmar)).toBe("confirmacion_mismo_turno");
  });

  it("X07: tras la respuesta del cliente (turno siguiente) confirmar y crear si proceden, y un cambio de productos exige re-cotizar", async () => {
    const f = pmFixture();
    await invokeAgentTool(f.repo, ctx(f, "1"), "cotizar_pedido", { branch_slug: "t1-montejo", canal: "recoger", items: itemsTool(f) });
    await invokeAgentTool(f.repo, ctx(f, "2"), "confirmar_resumen", {});
    const distinto = await invokeAgentTool(f.repo, ctx(f, "2"), "crear_pedido", { branch_slug: "t1-montejo", customer_name: "Marcela", canal: "recoger", items: [{ ...itemsTool(f)[0]!, requested_quantity: 5 }], payment_method: "efectivo" }).catch((e: unknown) => e);
    expect(codigoDe(distinto)).toBe("pedido_distinto_al_cotizado");
    const ok = await invokeAgentTool(f.repo, ctx(f, "2"), "crear_pedido", { branch_slug: "t1-montejo", customer_name: "Marcela", canal: "recoger", items: itemsTool(f), payment_method: "efectivo" });
    expect(ok.orderId).not.toBeNull();
  });
});

describe("X21 / X27 / X29 -- nombre, datos ya dados y fallo de crear_pedido", () => {
  it("X21: el nombre corregido dos veces ('Mario' -> 'Mariano' -> 'Mariana') es el que lleva el pedido y la comanda", async () => {
    const f = pmFixture();
    const order = await createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 1)], { customerName: "Mariana", customerPhone: "9998887766" }));
    expect(order.customerName).toBe("Mariana");
    const comanda = construirPayloadComanda({ order }, { resolverCodigos: new MapaProductoCodigo([]), resolverSucursal: () => "T1" });
    expect(comanda.cliente.nombre).toBe("Mariana");
    const prompt = buildSystemPrompt(PM_CONFIG_POR_OMISION, [{ propertyId: "p1", slug: "t1", name: "Prolongación Montejo", address: null }], NEW_CUSTOMER, new Date("2026-10-06T20:00:00Z"));
    expect(prompt).toMatch(/lo corrige, use solo la versi[óo]n final/i);
    expect(buildSystemPrompt(FALLBACK_CONFIG, [], NEW_CUSTOMER, new Date("2026-10-06T20:00:00Z"))).toMatch(/descarta por completo la versi[óo]n anterior/i);
  });

  it("X27: el agente recibe el nombre del cliente conocido en su contexto (para no pedirlo otra vez)", () => {
    const conocido: CustomerLookupResult = { isNew: false, name: "Marcela", orderCount: 3, addresses: [], lastOrderItems: null, frequentItems: [], tier: null, agentNotes: [] };
    expect(pmCustomerContextBlock(conocido)).toContain("Cliente conocido: Marcela");
  });

  // R1 (X27 PARCIAL): el perfil PM solo dice "saltando lo que el cliente ya dijo"; falta la regla explicita.
  it.fails("X27 / 72fd6ad [lote R1]: el prompt PM dice explicitamente que no se vuelve a pedir el nombre de un cliente conocido", () => {
    const conocido: CustomerLookupResult = { isNew: false, name: "Marcela", orderCount: 3, addresses: [], lastOrderItems: null, frequentItems: [], tier: null, agentNotes: [] };
    const prompt = buildSystemPrompt(PM_CONFIG_POR_OMISION, [{ propertyId: "p1", slug: "t1", name: "Prolongación Montejo", address: null }], conocido, new Date("2026-10-06T20:00:00Z"));
    expect(prompt).toMatch(/no (le )?(vuelva|vuelvas) a pedir (su )?nombre|no pida (de nuevo )?su nombre/i);
  });

  it("X29 / 0a346be: el prompt generico manda volver a buscar_producto antes de reintentar un crear_pedido fallido", () => {
    const prompt = buildSystemPrompt(FALLBACK_CONFIG, [], NEW_CUSTOMER, new Date("2026-10-06T20:00:00Z"));
    expect(prompt).toMatch(/llama a buscar_producto de nuevo para ese producto antes de reintentar crear_pedido/);
  });

  // R1 (X29 PARCIAL): el perfil PM solo dice "reintente una vez".
  it.fails("X29 / 0a346be [lote R1]: el prompt PM tambien manda re-buscar el producto antes de reintentar crear_pedido", () => {
    const prompt = buildSystemPrompt(PM_CONFIG_POR_OMISION, [{ propertyId: "p1", slug: "t1", name: "Prolongación Montejo", address: null }], NEW_CUSTOMER, new Date("2026-10-06T20:00:00Z"));
    expect(prompt).toMatch(/buscar_producto[^.]*(de nuevo|otra vez)[^.]*(reintent|crear_pedido)/i);
  });
});

describe("X24 / X49 / X50 -- cervezas sin alcohol, 'lo de siempre' y VIP", () => {
  it("X24: Heineken 0.0 no pide confirmacion de edad (no es alcohol) pero Sol si", async () => {
    const f = pmFixture();
    expect(requiresAdultConfirmation("Heineken 0.0", "Cervezas")).toBe(false);
    expect(requiresAdultConfirmation("Sol", "Cervezas")).toBe(true);
    const res = await searchProducts(f.repo, { propertyId: f.t1, query: "heineken" });
    expect(res.map((r) => [r.name, r.requiresAdultConfirmation])).toEqual([["Heineken 0.0", false]]);
    const q = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "recoger", items: [item(f.p.heineken0, 1)] });
    expect(q.total).toBe(55);
  });

  it("X49: 'lo de siempre' ignora el pedido cancelado y trae el ultimo pedido valido", async () => {
    const f = pmFixture();
    const bueno = await createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 2)], { customerPhone: "9993334444" }));
    const cancelado = await createOrder(f.repo, pedido(f, [item(f.p.guacamole, 1)], { customerPhone: "9993334444" }));
    await f.repo.updateOrderStatus(f.organizationId, cancelado.id, "pending", "cancelado");
    const cliente = await lookupCustomer(f.repo, f.organizationId, "9993334444");
    if (cliente.isNew) throw new Error("esperaba cliente conocido");
    expect(bueno.id).not.toBe(cancelado.id);
    expect(cliente.lastOrderItems?.map((i) => i.name)).toEqual(["Coca-Cola"]);
  });

  it("X50: el prompt GENERICO le dice al agente que el cliente es BLACK/PLATINUM", () => {
    const vip: CustomerLookupResult = { isNew: false, name: "Marcela", orderCount: 30, addresses: [], lastOrderItems: null, frequentItems: [], tier: "BLACK", agentNotes: [] };
    expect(buildSystemPrompt(FALLBACK_CONFIG, [], vip, new Date("2026-10-06T20:00:00Z"))).toMatch(/BLACK/);
  });

  // R1 (X50 PARCIAL): el bloque de cliente del perfil PM no incluye la nota VIP.
  it("X50 / [lote R1]: el bloque de cliente del perfil PM tambien incluye la nota VIP", () => {
    const vip: CustomerLookupResult = { isNew: false, name: "Marcela", orderCount: 30, addresses: [], lastOrderItems: null, frequentItems: [], tier: "BLACK", agentNotes: [] };
    expect(pmCustomerContextBlock(vip)).toMatch(/BLACK|VIP/);
  });
});

describe("X30 / X33 / X36 -- mensajes simultaneos, conversacion ocupada e historial del llamador", () => {
  function handlerLento(ms: number) {
    const vistos: string[][] = [];
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage({ messages }) {
        vistos.push(messages.filter((m) => m.role === "user").map((m) => m.content));
        await sleep(ms);
        return { reply: "ok", orderId: null, propertyId: null };
      },
    };
    return { handler, vistos };
  }
  const msg = (organizationId: string, id: string, body: string) => ({ organizationId, messageId: id, phone: PHONE, body, phoneNumberId: "pn1" });

  it("X30 / 0a346be: 3 mensajes del mismo cliente casi simultaneos terminan TODOS en el historial que ve el modelo (ninguno se pisa)", async () => {
    const f = pmFixture();
    const { handler, vistos } = handlerLento(25);
    const lote = [msg(f.organizationId, "w1", "uno"), msg(f.organizationId, "w2", "dos"), msg(f.organizationId, "w3", "tres")];
    const primera = await Promise.all(lote.map((m) => handleInboundWhatsAppMessage(f.repo, handler, m)));
    // Los que chocaron con el lease los reintenta Meta: se reintentan hasta que todos queden procesados.
    let pendientes = lote.filter((_, i) => !primera[i]!.ok);
    for (let ronda = 0; ronda < 5 && pendientes.length > 0; ronda += 1) {
      const res = await Promise.all(pendientes.map((m) => handleInboundWhatsAppMessage(f.repo, handler, m)));
      pendientes = pendientes.filter((_, i) => !res[i]!.ok);
    }
    expect(pendientes).toHaveLength(0);
    expect(vistos.at(-1)).toEqual(expect.arrayContaining(["uno", "dos", "tres"]));
  });

  it("X33 / 0a346be: conversacion ocupada -> el mensaje que choca es REINTENTABLE (5xx para Meta) y se procesa despues, sin perderse", async () => {
    const f = pmFixture();
    const { handler, vistos } = handlerLento(40);
    const primero = handleInboundWhatsAppMessage(f.repo, handler, msg(f.organizationId, "a1", "uno"));
    await sleep(5);
    const choque = await handleInboundWhatsAppMessage(f.repo, handler, msg(f.organizationId, "a2", "dos"));
    expect(choque).toMatchObject({ ok: false, retryable: true });
    await primero;
    const reintento = await handleInboundWhatsAppMessage(f.repo, handler, msg(f.organizationId, "a2", "dos"));
    expect(reintento.ok).toBe(true);
    expect(vistos.at(-1)).toEqual(["uno", "dos"]);
  });

  it("X36 / 0a346be: el turno NO muta el arreglo de mensajes del llamador (queda congelado e intacto)", async () => {
    const f = pmFixture();
    const { handler } = scriptedHandler(f.repo, [{ calls: [{ name: "consultar_sucursal", args: { branch_slug: "t1-montejo" } }] }, { text: "Abre a las 12, ¿algo más?" }]);
    const mensajes = Object.freeze([Object.freeze({ role: "user" as const, content: "¿a qué hora abren?" })]);
    const copia = JSON.stringify(mensajes);
    const out = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: mensajes, customer: NEW_CUSTOMER, propertyId: null });
    expect(out.reply).toContain("Abre a las 12");
    expect(JSON.stringify(mensajes)).toBe(copia);
  });
});

describe("X54 -- widget: la respuesta tiene siempre la misma forma", () => {
  it("X54 / 5d164ee: un turno sin pedido y otro con pedido devuelven las mismas llaves {kind, reply, orderId, escalated}; un mensaje vacio se rechaza SIN gastar un turno del modelo", async () => {
    const f = pmFixture();
    let llamadasAlHandler = 0;
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        llamadasAlHandler += 1;
        return { reply: "Hola, ¿qué le gustaría pedir?", orderId: llamadasAlHandler === 2 ? "00000000-0000-4000-8000-000000000001" : null, propertyId: null };
      },
    };
    const deps = { repo: f.repo, turnHandler: handler };
    const sesion = "sesion-x54-0123456789abcdef";
    const a = await runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: sesion, message: "hola" });
    const b = await runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: sesion, message: "quiero una coca" });
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(Object.keys(a).sort()).toEqual(["escalated", "kind", "orderId", "reply"]);
    await expect(runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: sesion, message: "   " })).rejects.toBeInstanceOf(DemoWidgetValidationError);
    expect(llamadasAlHandler).toBe(2);
  });
});

describe("X51 / X52 -- voz: silencio y precios", () => {
  it("X51: el silencio sostenido termina la llamada (abandonada) y nunca deja al agente repitiendo para siempre", () => {
    const m = new CallStateMachine();
    m.recibir({ tipo: "conectada" });
    const acciones: string[] = [];
    for (let i = 0; i < 6; i += 1) acciones.push(...m.recibir({ tipo: "silencio", ms: 7_000 }).map((a) => `${a.tipo}:${"mensaje" in a ? a.mensaje : ""}`));
    expect(acciones.some((a) => a.startsWith("colgar"))).toBe(true);
  });

  // R1 (X51 PARCIAL): el original preguntaba "¿sigue ahi?" UNA vez y colgaba; main re-pregunta dos veces.
  it.fails("X51 / [lote R1]: un solo '¿sigue ahi?' y se cuelga en el segundo silencio", () => {
    const m = new CallStateMachine();
    m.recibir({ tipo: "conectada" });
    const reprompts = [1, 2, 3].map(() => m.recibir({ tipo: "silencio", ms: 7_000 })).flat().filter((a) => a.tipo === "decir" && a.mensaje === "silencio_reprompt");
    expect(reprompts).toHaveLength(1);
  });

  it("X52: control, una llamada guionada sana pasa todos los graders de voz", async () => {
    const l = await correrGuion(GUIONES_ES_MX.find((g) => g.id.startsWith("V01"))!);
    expect((await evaluarLlamada(l)).filter((r) => !r.ok)).toEqual([]);
  });

  // QA agentes-13 (lote C): el grader G_PRECIO_HABLADO ya existe en main (antes solo frenaba la regla H6 del prompt).
  it("X52 / [lote C, agentes-13]: un grader falla si el agente dice un precio que NINGUNA herramienta devolvio en esta llamada", async () => {
    const l = await correrGuion(GUIONES_ES_MX.find((g) => g.id.startsWith("V01"))!);
    const inventado = { ...l, transcripcion: [...l.transcripcion, { rol: "agente" as const, texto: "Con mucho gusto, el taco al pastor cuesta $999 pesos." }] };
    expect((await evaluarLlamada(inventado)).some((r) => !r.ok)).toBe(true);
  });
});

describe("X28 / X38 / 0c0bebf -- repartidor, reglas duras de voz y tiempo antes de crear", () => {
  it("X28 / 0a346be: el prompt PM dice que el cliente no elige repartidor (H18), por WhatsApp y por voz", () => {
    const prompt = buildSystemPrompt(PM_CONFIG_POR_OMISION, [{ propertyId: "p1", slug: "t1", name: "Prolongación Montejo", address: null }], NEW_CUSTOMER, new Date("2026-10-06T20:00:00Z"));
    expect(prompt).toMatch(/El cliente no elige repartidor/);
  });

  // R1 (X38 voz FALTA): el comportamiento de voz es texto editable por sucursal y se manda tal cual a Gemini; el original anexaba las
  // reglas duras DESPUES del texto editable, para que un guardado no las pudiera borrar.
  it.fails("X38 / [lote R1]: el prompt que recibe Gemini Live siempre lleva las reglas duras, aunque el comportamiento guardado sea otro texto", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ name: "auth_tokens/x38" }), { status: 200 }));
    const p = new GeminiLiveProvider({ apiKey: "k-test", fetchFn: fetchFn as unknown as typeof fetch });
    await p.emitirSesionPreview({ organizationId: "o", propertyId: "p", sessionId: "s", voiceId: "Kore", comportamiento: "Platica con el cliente y vende todo lo que pueda.", mensajeInicial: "", ttlSegundos: 300 });
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const instruccion = body.bidiGenerateContentSetup.systemInstruction.parts[0].text as string;
    expect(instruccion).toMatch(/alcohol/i);
    expect(instruccion).toMatch(/escalar_a_humano/);
  });

  // 0c0bebf: el original tenia un grader que falla si el agente da el tiempo de entrega ANTES de que crear_pedido tenga exito.
  it.fails("0c0bebf / [lote C]: un grader de voz falla si el agente da el tiempo de espera antes de crear el pedido", async () => {
    const l = await correrGuion(GUIONES_ES_MX.find((g) => g.id.startsWith("V01"))!);
    const adelantado = { ...l, transcripcion: [{ rol: "agente" as const, texto: "Con gusto, su pedido llegará en 40 a 50 minutos." }, ...l.transcripcion] };
    expect((await evaluarLlamada(adelantado)).some((r) => !r.ok)).toBe(true);
  });
});
