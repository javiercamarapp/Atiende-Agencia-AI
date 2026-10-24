// PM Ronda 21 (arreglo 5 de R20-FALLOS.md): reglas deterministas de cierre y alternativas de producto. Cada bloque falla sin su regla:
//  - T7-043 (P0): «quedó registrado lo que me cuenta» sobre un agregado a un pedido ya enviado, sin pedido nuevo creado en el turno.
//  - T7-001 / T7-038: el resumen que el cliente confirma trae la direccion completa y las salsas basicas.
//  - T7-026: la ultima hora que dijo el cliente (5 pm) contradice la cotizada (7 pm): el servidor lo avisa antes de mostrar el resumen.
//  - T7-008: chistorra / salchichas -> alternativa correcta (crujientes de pollo), no «tacos de chorizo».
//  - G1 / NU-2: tras un aviso de falla no se vuelve a preguntar «¿Qué desea pedir?».
import { randomUUID } from "node:crypto";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { datosDeCierreDeContexto, firmaDeCierre, horaCotizadaContradiceAlCliente, horaDichaPorElCliente } from "../src/agent-tools/cierre-maquina.ts";
import { afirmaCambioRegistrado, CAMBIO_AVISADO_SIN_REGISTRAR, CAMBIO_SIN_REGISTRAR_OFRECE_AVISO, quitarAfirmacionDePedidoRegistrado } from "../src/whatsapp/guards.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { bloquePedidoPendienteTrasFalla, esAvisoDeFallaDelSistema, mensajesPerdidosPorFalla } from "../src/whatsapp/falla-pendiente.ts";
import { PM_COPY } from "../src/whatsapp/perfil-pm.ts";
import { bloqueProductoNoManejado, PM_PRODUCTOS_NO_MANEJADOS, productosNoManejados } from "../src/unidades-pm.ts";
import { seedConfirmedOrderFlow } from "./support/order-flow-seed.ts";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

afterEach(limpiarEntorno);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T7-043 (P0): «quedó registrado» de un agregado
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("afirmaCambioRegistrado", () => {
  it.each([
    "Ya está avisado el equipo, quedó registrado lo que me cuenta.",
    "Ya agregué los 3 tacos de pastor a su pedido.",
    "Se agregaron los tacos a su pedido.",
    "Se agregó la orden de tacos.",
    "Su agregado quedó anotado.",
    "Listo, quedó agregado.",
    "Ya lo registré.",
    "Ya le cambiamos la tortilla a su pedido.",
    "Lo agregamos a su pedido.",
    "Se incluyó la salsa extra.",
  ])("afirma: %s", (t) => expect(afirmaCambioRegistrado(t)).toBe(true));

  it.each([
    "¿Quiere que agregue los 3 tacos?",
    "Si quiere, los agregamos.",
    "Le agrego los tacos en cuanto confirme.",
    "El equipo le confirma si alcanza a incluirlo.",
    "Todavía no queda registrado su cambio.",
    "Su dirección quedó registrada.",
    "Ya avisé a la sucursal de lo que me pidió.",
    "El total es de $168.",
    // Falsos positivos de la R21 en una cotizacion inicial (sin pedido previo): descripcion del platillo, no un cambio registrado.
    "El envío está incluido.",
    "Incluimos salsas básicas.",
    "Le cambiamos la tortilla si gusta.",
    "Le cambiamos la tortilla.",
    "La salsa está incluida.",
    "Las salsas básicas van incluidas.",
  ])("no afirma: %s", (t) => expect(afirmaCambioRegistrado(t)).toBe(false));

  it("con soloAgregado ignora el «quedó registrado» generico", () => {
    expect(afirmaCambioRegistrado("Quedó registrado lo que me cuenta.", { soloAgregado: true })).toBe(false);
    expect(afirmaCambioRegistrado("Ya agregué los tacos.", { soloAgregado: true })).toBe(true);
  });
  it("quita solo la frase falsa y deja un texto honesto", () => {
    expect(quitarAfirmacionDePedidoRegistrado("Ya agregué los tacos. ¿Algo más?", CAMBIO_SIN_REGISTRAR_OFRECE_AVISO, (f) => afirmaCambioRegistrado(f))).toBe("¿Algo más?");
    expect(quitarAfirmacionDePedidoRegistrado("Ya agregué los tacos.", CAMBIO_SIN_REGISTRAR_OFRECE_AVISO, (f) => afirmaCambioRegistrado(f))).toBe(CAMBIO_SIN_REGISTRAR_OFRECE_AVISO);
  });
});

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PHONE = "+5219990001111";
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };

/** Turno de PM con un pedido YA creado en la conversacion (el escenario T7-043 siembra uno) y un LLM que responde `respuesta`. */
async function turnoConPedidoPrevio(respuesta: string, mensaje = "Disculpe, ¿le pudiera agregar 3 tacos de pastor tortilla maíz naturales?") {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script: () => texto(respuesta) })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] });
  const snap = await f.repo.readOrderFlow(f.organizationId, `wa:${PHONE}`);
  await f.repo.writeOrderFlow(f.organizationId, `wa:${PHONE}`, snap!.version, { state: "creado", context: { ...snap!.context!, orderId: "00000000-0000-4000-8000-000000000001" } }, 3600);
  const t = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: mensaje }], customer: { isNew: true as const }, propertyId: null });
  return { t, f };
}

describe("T7-043 (P0): nunca «quedó registrado» de un agregado sin pedido nuevo creado", () => {
  it("con un pedido previo y sin pedido nuevo en el turno, la afirmacion se quita", async () => {
    const { t } = await turnoConPedidoPrevio("Ya está avisado el equipo, quedó registrado lo que me cuenta. En cuanto lo vean le responden.");
    expect(t.reply).not.toMatch(/qued[oó] registrado/i);
    expect(t.reply).toMatch(new RegExp(`${CAMBIO_AVISADO_SIN_REGISTRAR.slice(0, 20)}|${CAMBIO_SIN_REGISTRAR_OFRECE_AVISO.slice(0, 20)}`));
    expect(t.orderId).toBeNull();
  });
  it("«ya agregué los tacos» tampoco pasa", async () => {
    const { t } = await turnoConPedidoPrevio("Listo, ya agregué los 3 tacos a su pedido.");
    expect(t.reply).not.toMatch(/agregu?é/i);
  });
  it("un «quedó registrado» repetido sobre el pedido de un turno ANTERIOR (el cliente solo pregunta por el) no se borra", async () => {
    const { t } = await turnoConPedidoPrevio("Sí, ya quedó registrado y lo están preparando.", "¿Ya quedó mi pedido?");
    expect(t.reply).toContain("Sí, ya quedó registrado y lo están preparando."); // (otro guard puede anexar la pregunta de colonia)
    expect(t.reply).not.toContain(CAMBIO_SIN_REGISTRAR_OFRECE_AVISO);
  });
  it("pero si el cliente pide agregar algo, el «quedó registrado» sigue sin pasar", async () => {
    const { t } = await turnoConPedidoPrevio("Listo, quedó registrado lo que me pide.", "Agrégueme 2 refrescos por favor");
    expect(t.reply).not.toMatch(/qued[oó] registrado/i);
  });
  it("cotizacion inicial sin pedido previo: «el envío está incluido» / «incluimos salsas básicas» no se tocan", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    const resp = "Incluimos salsas básicas y el envío está incluido. Le cambiamos la tortilla si gusta.";
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script: () => texto(resp) })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const t = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: "¿Qué incluye el pedido?" }], customer: { isNew: true as const }, propertyId: null });
    expect(t.reply).toContain(resp);
    expect(t.reply).not.toContain(CAMBIO_SIN_REGISTRAR_OFRECE_AVISO);
  });
  it("una respuesta que no afirma nada se deja tal cual", async () => {
    const { t } = await turnoConPedidoPrevio("Con gusto lo revisamos, ¿algo más?");
    expect(t.reply).toBe("Con gusto lo revisamos, ¿algo más?");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T7-001 / T7-038: el resumen trae direccion completa y salsas basicas
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("el resumen canonico trae la direccion completa y las salsas basicas", () => {
  beforeEach(() => prepararEntorno(true));

  const tacos = (f: ReturnType<typeof setup>["f"]) => [{ product_id: f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" }];

  it("domicilio: la calle y las referencias que dio el cliente salen en «Dirección»", async () => {
    const s = setup();
    await s.quote({ items: tacos(s.f), canal: "domicilio", colonia_entrega: "Centro", customer_address: "Calle 32 #345 x 20 y 22, casa 13, Privada Los Almendros" });
    const c = await s.canonico();
    expect(c).toContain("Dirección: Calle 32 #345 x 20 y 22, casa 13, Privada Los Almendros, colonia Centro");
  });
  it("la direccion se hereda en la re-cotizacion y se limpia de telefonos", async () => {
    const s = setup();
    await s.quote({ items: tacos(s.f), canal: "domicilio", colonia_entrega: "Centro", customer_address: "Calle 32 #345, casa 13 tel 9991234567" });
    expect(await s.canonico()).not.toContain("9991234567");
    await s.quote({ items: tacos(s.f), canal: "domicilio", colonia_entrega: "Centro", payment_method: "tarjeta" });
    expect(await s.canonico()).toContain("Dirección: Calle 32 #345, casa 13");
  });
  it("recoger no lleva direccion", async () => {
    const s = setup();
    await s.quote({ items: tacos(s.f), canal: "recoger", customer_address: "Calle 32 #345" });
    expect(await s.canonico()).not.toContain("Dirección");
  });
  it("las salsas basicas aparecen aunque el cliente no pida extras (menos las que quito)", async () => {
    const s = setup();
    await s.quote({ items: tacos(s.f), canal: "recoger" });
    expect(await s.canonico()).toContain("Salsas básicas incluidas: salsa roja, salsa verde, cebolla con cilantro, limones");
    await s.quote({ items: tacos(s.f), canal: "recoger", omit_default_complements: ["salsa_verde"] });
    const c = await s.canonico();
    expect(c).toContain("Salsas básicas incluidas: salsa roja, cebolla con cilantro, limones");
    expect(c).toContain("Sin: salsa verde");
  });
  it("un pedido de solo bebidas no muestra salsas", async () => {
    const s = setup();
    await s.quote({ canal: "recoger" });
    expect(await s.canonico()).not.toContain("Salsas básicas");
  });
  /** Producto extra del menu con su categoria, para probar que la decision de salsas es por CATEGORIA y no por una lista de nombres. */
  const producto = (s: ReturnType<typeof setup>, categoria: string, nombre: string, precio: number) => {
    const categoryId = randomUUID();
    const id = randomUUID();
    s.f.repo.seedCategory({ id: categoryId, organizationId: s.f.organizationId, name: categoria });
    s.f.repo.seedProduct({ id, organizationId: s.f.organizationId, categoryId, name: nombre, description: null, searchKeywords: [] });
    s.f.repo.seedBranchProduct({ propertyId: s.f.propertyId, productId: id, price: precio, isAvailable: true });
    return [{ product_id: id, product_name: nombre, requested_quantity: 1 }];
  };
  it.each([
    ["Postres", "Flan napolitano"],
    ["Aguas frescas", "Horchata"], // un nombre que ninguna lista de bebidas por nombre reconoceria: manda la categoria
    ["Bebidas", "Kombucha de jamaica"],
    ["Guarniciones extra", "Cebollitas"],
    ["Pollo", "Crujientes de Pechuga de Pollo"],
  ])("renglones sin salsa (%s: %s) NO listan «Salsas básicas incluidas»", async (categoria, nombre) => {
    const s = setup();
    await s.quote({ items: producto(s, categoria, nombre, 80), canal: "recoger" });
    expect(await s.canonico()).not.toContain("Salsas básicas");
  });
  it("un pedido mixto (tacos + postre) si las lista, porque los tacos las llevan", async () => {
    const s = setup();
    await s.quote({ items: [...tacos(s.f), ...producto(s, "Postres", "Flan napolitano", 50)], canal: "recoger" });
    expect(await s.canonico()).toContain("Salsas básicas incluidas");
  });
  it("direccion con numeros largos o separados («Calle 60 #123 x 21») no se sobre-recorta; un telefono si se quita", async () => {
    const s = setup();
    await s.quote({ items: tacos(s.f), canal: "domicilio", colonia_entrega: "Centro", customer_address: "Calle 60 #1234 x 21 y 23, No. 123 21 45, Centro tel 999 123 4567" });
    const c = await s.canonico();
    expect(c).toContain("Calle 60 #1234 x 21 y 23, No. 123 21 45");
    expect(c).not.toContain("4567");
    const s2 = setup();
    await s2.quote({ items: tacos(s2.f), canal: "domicilio", colonia_entrega: "Centro", customer_address: "Calle 60 #123 x 21" });
    expect(await s2.canonico()).toContain("Dirección: Calle 60 #123 x 21, colonia Centro");
  });
  it("las salsas basicas y la direccion NO entran a la firma del cierre ni a la decision de confirmar", async () => {
    const a = setup();
    await a.quote({ items: tacos(a.f), canal: "domicilio", colonia_entrega: "Centro", customer_address: "Calle 60 #123 x 21" });
    const b = setup();
    await b.quote({ items: tacos(b.f), canal: "domicilio", colonia_entrega: "Centro", customer_address: "Otra calle 5", omit_default_complements: ["salsa_verde"] });
    const ca = (await a.snap())!.context!;
    const cb = (await b.snap())!.context!;
    expect(ca.resumenCanonico).not.toEqual(cb.resumenCanonico);
    expect(firmaDeCierre(datosDeCierreDeContexto(ca))).toEqual(firmaDeCierre(datosDeCierreDeContexto(cb)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T7-026: la hora que dijo el cliente se persiste
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("horaDichaPorElCliente", () => {
  const u = (...c: string[]) => c.map((content) => ({ role: "user", content }));
  it("lee la ultima hora exacta", () => {
    expect(horaDichaPorElCliente(u("A las 7", "Voy a tener que cambiar la hora, lo paso a buscar a las 5 pm por favor"))).toEqual({ minuto12: 300, meridiano: "pm" });
    expect(horaDichaPorElCliente(u("mejor a las 6:30"))).toEqual({ minuto12: 390, meridiano: null });
    expect(horaDichaPorElCliente(u("para las 8 de la noche"))).toEqual({ minuto12: 480, meridiano: "pm" });
    expect(horaDichaPorElCliente(u("pasó por él a las 17:00"))).toEqual({ minuto12: 300, meridiano: "pm" });
  });
  it("ignora cantidades, preguntas de horario y plazos", () => {
    expect(horaDichaPorElCliente(u("quiero 5 kg de bistec"))).toBeNull();
    expect(horaDichaPorElCliente(u("5 tacos de pastor"))).toBeNull();
    expect(horaDichaPorElCliente(u("¿abren a las 12?"))).toBeNull();
    expect(horaDichaPorElCliente(u("a las 5 pm", "mejor en 40 minutos"))).toBeNull();
    expect(horaDichaPorElCliente([{ role: "assistant", content: "¿a las 5 pm?" }])).toBeNull();
  });
  it("se ata al pedido vigente: la hora de un pedido anterior (ya registrado) no cuenta para el nuevo", () => {
    const h = [
      { role: "user", content: "lo paso a buscar a las 5 pm" },
      { role: "assistant", content: "Listo, su pedido quedó registrado." },
      { role: "user", content: "quiero otras 2 cocas para recoger" },
    ];
    expect(horaDichaPorElCliente(h)).toBeNull();
    expect(horaDichaPorElCliente([...h, { role: "user", content: "mejor a las 8 pm" }])).toEqual({ minuto12: 480, meridiano: "pm" });
  });
  it("horaCotizadaContradiceAlCliente compara en la zona de la sucursal", () => {
    const siete = Date.parse("2026-10-06T19:00:00-06:00");
    const cinco = Date.parse("2026-10-06T17:00:00-06:00");
    const hist = u("lo paso a buscar a las 5 pm");
    expect(horaCotizadaContradiceAlCliente(siete, "America/Merida", hist)?.dicha).toBe("5:00 pm");
    expect(horaCotizadaContradiceAlCliente(cinco, "America/Merida", hist)).toBeNull();
    expect(horaCotizadaContradiceAlCliente(siete, "America/Merida", u("quiero tacos"))).toBeNull();
  });
});

describe("cotizar_pedido avisa si la hora cotizada no es la que dijo el cliente", () => {
  beforeEach(() => prepararEntorno(true));

  it("el cliente cambio a las 5 pm y el modelo cotizo con las 7 pm", async () => {
    const s = setup();
    s.cliente("A las 7");
    s.asistente("Anotado.");
    s.cliente("Voy a tener que cambiar la hora, lo paso a buscar a las 5 pm por favor");
    const r = (await s.quote({ canal: "recoger", programado_para: "2026-10-06T19:00:00-06:00" })).result as Record<string, unknown>;
    expect(r.hora_distinta_a_la_del_cliente).toBe(true);
    expect(String(r.aviso_hora)).toContain("5:00 pm");
  });
  it("el aviso sale UNA sola vez por turno: la re-cotizacion del mismo turno no lo repite (sin ciclos)", async () => {
    const s = setup();
    s.cliente("Lo paso a buscar a las 5 pm por favor");
    const a = (await s.quote({ canal: "recoger", programado_para: "2026-10-06T19:00:00-06:00" })).result as Record<string, unknown>;
    expect(a.hora_distinta_a_la_del_cliente).toBe(true);
    const b = (await s.quote({ canal: "recoger", programado_para: "2026-10-06T19:00:00-06:00" })).result as Record<string, unknown>;
    expect(b.hora_distinta_a_la_del_cliente).toBeUndefined();
    expect(b.aviso_hora).toBeUndefined();
  });
  it("con la hora correcta no hay aviso y el resumen lleva esa hora", async () => {
    const s = setup();
    s.cliente("Lo paso a buscar a las 5 pm por favor");
    const r = (await s.quote({ canal: "recoger", programado_para: "2026-10-06T17:00:00-06:00" })).result as Record<string, unknown>;
    expect(r.hora_distinta_a_la_del_cliente).toBeUndefined();
    expect(await s.canonico()).toContain("para las 5:00 pm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T7-008: producto que el menu no tiene
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("producto que el menu no tiene -> alternativa correcta", () => {
  it("detecta chistorra, longaniza, salchichas, dedos de queso y papas a la francesa", () => {
    expect(productosNoManejados("¿Manejan chistorra?")).toEqual(["chistorra"]);
    expect(productosNoManejados("1 orden de salchichas rojas para asar")).toEqual(["salchichas"]);
    expect(productosNoManejados("¿Longaniza? Una orden de papas a la francesa y dedos de queso")).toEqual(["longaniza", "dedos de queso", "papas a la francesa"]);
    expect(productosNoManejados("3 tacos de pastor y una coca")).toEqual([]);
  });
  it("el bloque manda ofrecer crujientes de pollo y prohibe el chorizo", () => {
    const b = bloqueProductoNoManejado(["¿Manejan chistorra?"]);
    expect(b).toContain("CRUJIENTES DE POLLO");
    expect(b).toContain("chistorra");
    expect(b).toMatch(/No ofrezca como sustituto tacos de chorizo/);
    expect(b).toMatch(/SIEMPRE verifique con buscar_producto/); // la lista es deuda del perfil PM: el catalogo manda
    expect(PM_PRODUCTOS_NO_MANEJADOS.map((p) => p.nombre)).toEqual(["chistorra", "longaniza", "salchichas", "dedos de queso", "papas a la francesa"]);
    expect(bloqueProductoNoManejado(["3 tacos de pastor"])).toBe("");
  });
  it("llega al prompt del turno de PM", async () => {
    let sistema = "";
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script: (req: LlmCompletionRequest) => { sistema = req.system; return texto("No manejamos chistorra."); } })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: "¿Manejan chistorra?" }], customer: { isNew: true as const }, propertyId: null });
    expect(sistema).toContain("producto que el menú no tiene");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G1 / NU-2: recuperacion tras un aviso de falla
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("recuperacion tras un aviso de falla del sistema", () => {
  const pedido = "Hola, 1 kg de bistec y 1 kg de pastor, mixta, para recoger a las 7 pm";
  const historial = [
    { role: "user", content: pedido },
    { role: "assistant", content: PM_COPY.sinAsistenteAvisoEquipo },
    { role: "user", content: "Sigo aquí, es todo" },
  ];
  it("detecta los avisos de falla", () => {
    expect(esAvisoDeFallaDelSistema(PM_COPY.sinAsistenteAvisoEquipo)).toBe(true);
    expect(esAvisoDeFallaDelSistema("Claro, ¿qué desea pedir?")).toBe(false);
  });
  it("junta los mensajes que la falla dejo sin atender", () => {
    expect(mensajesPerdidosPorFalla(historial).map((m) => m.content)).toEqual([pedido]);
  });
  it("sin falla como ultima respuesta del asistente no hay bloque", () => {
    expect(bloquePedidoPendienteTrasFalla([{ role: "user", content: pedido }])).toBe("");
    expect(bloquePedidoPendienteTrasFalla([...historial, { role: "assistant", content: "Listo, ¿algo más?" }, { role: "user", content: "no" }])).toBe("");
  });
  it("el bloque prohibe volver a preguntar que desea pedir, no abre otro pedido y NO cita texto del cliente", () => {
    const b = bloquePedidoPendienteTrasFalla(historial);
    expect(b).not.toContain(pedido);
    expect(b).toMatch(/no le vuelva a preguntar/i);
    expect(b).toMatch(/no abra otro/i);
  });
  it("llega al prompt del turno siguiente a la falla", async () => {
    let sistema = "";
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script: (req: LlmCompletionRequest) => { sistema = req.system; return texto("Retomo su pedido."); } })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: historial as never, customer: { isNew: true as const }, propertyId: null });
    expect(sistema).toContain("falla previa del sistema");
    expect(sistema).not.toContain(pedido);
  });
});
