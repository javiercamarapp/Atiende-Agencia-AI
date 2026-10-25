// R11 Arquitectura A: contexto precargado + llamadas en lote. Pruebas deterministas (modelo simulado, sin LLM real, sin red) contra el handler real.
//
// Dos cosas distintas, y no se confunden:
//  1. LO QUE EL SERVIDOR GARANTIZA (se prueba aqui de verdad): con la bandera apagada el turno es identico al de antes; encendida, el servidor hace las lecturas, las entrega
//     como llamadas ya hechas, no filtra la direccion, no precarga lo que no debe y conserva las guardas (idempotencia, pin, resumen mostrado).
//  2. LO QUE EL MODELO REAL HARA con esas instrucciones: NO se puede probar sin LLM real. El «modelo obediente» de abajo ejecuta el contrato del prompt (usa lo precargado, junta
//     las herramientas independientes) para MEDIR cuantas vueltas ahorra el servidor SI el modelo obedece. Las cifras de la tabla son ese techo, no una medicion de produccion.
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import { MARCA_DATOS_YA_CONSULTADOS } from "../../src/whatsapp/datos-ya-consultados.ts";
import { MARCA_CONTEXTO_PRECARGADO, consultasDeProductoDelMensaje, contextoPrecargadoDeEntorno, resultadoClientePrecargado } from "../../src/whatsapp/contexto-precargado.ts";
import type { ObservabilidadTurno } from "../../src/whatsapp/observabilidad-turno.ts";
import { normalizePhone } from "../../src/phone.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import type { CustomerLookupResult } from "../../src/types.ts";

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamadas = (...calls: Array<readonly [string, string, object]>): LlmCompletionResult => ({
  text: "",
  toolCalls: calls.map(([id, name, args]) => ({ id, name, argumentsJson: JSON.stringify(args) })),
  model: "fake",
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
});
const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;
const PHONE = "+5219990005555";
const NUEVO: CustomerLookupResult = { isNew: true };
const CONOCIDO: CustomerLookupResult = {
  isNew: false,
  name: "Luis Canul",
  orderCount: 3,
  addresses: [{ address: "Calle 5 #20 por 10 y 12, Col. Centro, Mérida", label: "casa", isDefault: true }],
  lastOrderItems: null,
  frequentItems: [],
  tier: null,
  agentNotes: [],
  pedidoReciente: null,
};

// ─── puras ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("bandera de entorno WHATSAPP_CONTEXTO_PRECARGADO", () => {
  it("apagada por omision; solo 1 / true / si / on la encienden", () => {
    expect(contextoPrecargadoDeEntorno({})).toBe(false);
    expect(contextoPrecargadoDeEntorno({ WHATSAPP_CONTEXTO_PRECARGADO: "" })).toBe(false);
    expect(contextoPrecargadoDeEntorno({ WHATSAPP_CONTEXTO_PRECARGADO: "0" })).toBe(false);
    expect(contextoPrecargadoDeEntorno({ WHATSAPP_CONTEXTO_PRECARGADO: "false" })).toBe(false);
    expect(contextoPrecargadoDeEntorno({ WHATSAPP_CONTEXTO_PRECARGADO: "talvez" })).toBe(false);
    for (const v of ["1", "true", "TRUE", " si ", "on"]) expect(contextoPrecargadoDeEntorno({ WHATSAPP_CONTEXTO_PRECARGADO: v })).toBe(true);
  });
});

describe("consultasDeProductoDelMensaje", () => {
  it("saludos, «si», ubicacion, notas de voz, toques de boton y mensajes largos no consultan nada", () => {
    for (const m of ["hola", "Hola, buenas tardes", "si", "sí, gracias", "ok", "[Ubicación compartida por WhatsApp] lat=21.0 lng=-89.6", "[Nota de voz transcrita] dos tacos", "", "x".repeat(400), "1234"]) {
      expect(consultasDeProductoDelMensaje(m).entera, m).toBeNull();
    }
  });
  it("le quita el relleno de conversacion y de canal al mensaje", () => {
    expect(consultasDeProductoDelMensaje("quiero una coca para recoger").entera).toBe("una coca");
    expect(consultasDeProductoDelMensaje("¿cuánto cuesta el kilo de pastor?").entera).toBe("el kilo de pastor");
  });
  it("parte por comas / «y» / «mas» solo cuando hay varios productos", () => {
    expect(consultasDeProductoDelMensaje("quiero coca, sol y tacos de bistec").partes).toEqual(["coca", "sol", "tacos de bistec"]);
    expect(consultasDeProductoDelMensaje("una coca").partes).toEqual([]);
  });
  it("tope de consultas por turno", () => {
    expect(consultasDeProductoDelMensaje("coca, sol, tacos, flan, agua, nachos, tortas").partes.length).toBeLessThanOrEqual(4);
  });
});

describe("resultadoClientePrecargado", () => {
  it("cliente conocido: sin direccion (solo si tiene o no), con el estado de cocina; nunca la direccion guardada", () => {
    const r = resultadoClientePrecargado(CONOCIDO)!;
    expect(r).toMatchObject({ isNew: false, name: "Luis Canul", orderCount: 3, tiene_direccion_guardada: true, pedidoReciente: null });
    expect(JSON.stringify(r)).not.toContain("Calle 5");
    expect(JSON.stringify(r)).not.toContain("Centro");
    expect(JSON.stringify(r)).not.toContain("addresses");
  });
  it("cliente nuevo (lo cubre R10) y cliente sin dato del estado de cocina (la herramienta agrega un aviso): no se precarga", () => {
    expect(resultadoClientePrecargado(NUEVO)).toBeNull();
    const { pedidoReciente: _omitido, ...sinDato } = CONOCIDO as Extract<CustomerLookupResult, { isNew: false }>;
    expect(resultadoClientePrecargado(sinDato as CustomerLookupResult)).toBeNull();
  });
});

// ─── handler real, modelo obediente ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Deseo {
  /** Lo que el cliente quiere buscar y un trozo del resultado que prueba que ya lo tiene. */
  readonly productos: readonly { readonly query: string; readonly nombre: string }[];
  readonly cotizar: boolean;
}

/** Modelo simulado que cumple el contrato del prompt. SIN la marca del bloque: como hoy (paso 3: buscar_cliente siempre salvo «datos ya consultados»; un buscar_producto por
 *  respuesta; luego cotizar; luego texto). CON la marca: usa lo precargado y junta las herramientas independientes en una respuesta. */
function modeloObediente(deseo: Deseo, f: ReturnType<typeof buildRestaurantFixture>) {
  return (req: LlmCompletionRequest): LlmCompletionResult => {
    const conMarca = req.system.includes(MARCA_CONTEXTO_PRECARGADO);
    const ultimoUser = req.messages.findLastIndex((m) => m.role === "user");
    const delTurno = req.messages.slice(ultimoUser + 1);
    const llamadasHechas = delTurno.flatMap((m) => (m.role === "assistant" && m.toolCalls ? m.toolCalls.map((c) => c.name) : []));
    const resultados = delTurno.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    if (!llamadasHechas.includes("buscar_cliente") && !req.system.includes(MARCA_DATOS_YA_CONSULTADOS)) return llamadas(["bc", "buscar_cliente", {}]);
    const pendientes = deseo.productos.filter((p) => !resultados.includes(p.nombre));
    if (pendientes.length > 0) {
      const buscar = pendientes.map((p, i) => [`b${i}-${req.messages.length}`, "buscar_producto", { query: p.query, branch_slug: "fco-montejo" }] as const);
      return conMarca ? llamadas(...buscar) : llamadas(buscar[0]!);
    }
    if (deseo.cotizar && !llamadasHechas.includes("cotizar_pedido")) {
      return llamadas(["q", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }] }]);
    }
    return texto(deseo.cotizar ? "Su pedido: 1 Coca-Cola, total $45.00 para recoger. ¿Lo confirma?" : "Con gusto, ¿qué le gustaría pedir?");
  };
}

function armar(opciones: { precargado: boolean; deseo: Deseo; observabilidad?: ObservabilidadTurno }) {
  const f = buildRestaurantFixture();
  const peticiones: LlmCompletionRequest[] = [];
  const modelo = modeloObediente(opciones.deseo, f);
  const provider = new FakeLlmProvider({ id: "sim", script: (req) => { peticiones.push({ ...req, messages: [...req.messages] }); return modelo(req); } });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", ...(opciones.precargado ? { contextoPrecargado: true } : {}), ...(opciones.observabilidad ? { observabilidad: opciones.observabilidad } : {}) });
  const preparar = () => f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM as never);
  const turno = async (mensaje: string, customer: CustomerLookupResult, propertyId: string | null = f.propertyId) => {
    await preparar();
    const antes = peticiones.length;
    const r = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: mensaje }], customer, propertyId });
    return { ...r, vueltas: peticiones.length - antes, primera: peticiones[antes]!, ultima: peticiones[peticiones.length - 1]! };
  };
  return { f, handler, turno, peticiones, gateway };
}

const COCA: Deseo = { productos: [{ query: "coca", nombre: "Coca-Cola" }], cotizar: true };
const TRES: Deseo = { productos: [{ query: "coca", nombre: "Coca-Cola" }, { query: "sol", nombre: "Sol" }, { query: "tacos de bistec", nombre: "Tacos de Bistec" }], cotizar: false };
const SALUDO: Deseo = { productos: [], cotizar: false };

describe("bandera apagada: el turno es identico al de antes", () => {
  it("el prompt y los mensajes que recibe el modelo no cambian (ni bloque ni intercambio precargado) y no se emite campo nuevo de observabilidad", async () => {
    const eventos: unknown[] = [];
    const t = armar({ precargado: false, deseo: COCA, observabilidad: { emitir: (e) => eventos.push(e) } });
    const r = await t.turno("quiero una coca para recoger", CONOCIDO);
    expect(r.primera.system).not.toContain(MARCA_CONTEXTO_PRECARGADO);
    expect(r.primera.messages.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(r.primera.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(JSON.stringify(eventos)).not.toContain("precargado");
    expect(r.vueltas).toBe(4); // buscar_cliente, buscar_producto, cotizar, texto: el flujo de siempre
  });
});

describe("bandera encendida: el servidor hace las lecturas y se las entrega al modelo", () => {
  it("cliente conocido + producto nombrado: el modelo recibe buscar_cliente (sin direccion) y buscar_producto ya hechos al final del historial", async () => {
    const t = armar({ precargado: true, deseo: COCA });
    const r = await t.turno("quiero una coca para recoger", CONOCIDO);
    expect(r.primera.system).toContain(MARCA_CONTEXTO_PRECARGADO);
    const asistente = r.primera.messages.find((m) => m.role === "assistant");
    expect(asistente && asistente.role === "assistant" ? asistente.toolCalls?.map((c) => c.name) : null).toEqual(["buscar_cliente", "buscar_producto"]);
    const tools = r.primera.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(tools).toHaveLength(2);
    expect(tools[1]).toContain("Coca-Cola");
    // La direccion guardada sigue detras de la herramienta: no aparece en ninguna parte de lo que ve el modelo.
    expect(JSON.stringify(r.primera)).not.toContain("Calle 5 #20");
    // Orden del historial: mensaje del cliente, luego el intercambio precargado (nunca antes: el modelo lee lo mas reciente).
    expect(r.primera.messages[0]).toMatchObject({ role: "user" });
    expect(r.primera.messages.at(-1)).toMatchObject({ role: "tool" });
  });

  it("sin sucursal de entrada no se precarga producto (la sucursal la decide buscar_sucursal_cercana); el cliente conocido si", async () => {
    const t = armar({ precargado: true, deseo: COCA });
    const r = await t.turno("quiero una coca para recoger", CONOCIDO, null);
    const asistente = r.primera.messages.find((m) => m.role === "assistant");
    expect(asistente && asistente.role === "assistant" ? asistente.toolCalls?.map((c) => c.name) : null).toEqual(["buscar_cliente"]);
  });

  it("un mensaje que no nombra producto (saludo) no hace busquedas; una busqueda sin resultados tampoco se entrega", async () => {
    const t = armar({ precargado: true, deseo: SALUDO });
    const r = await t.turno("hola buenas tardes", CONOCIDO);
    const asistente = r.primera.messages.find((m) => m.role === "assistant");
    expect(asistente && asistente.role === "assistant" ? asistente.toolCalls?.map((c) => c.name) : null).toEqual(["buscar_cliente"]);
    const t2 = armar({ precargado: true, deseo: SALUDO });
    const r2 = await t2.turno("quiero una hamburguesa de dinosaurio", CONOCIDO);
    const a2 = r2.primera.messages.find((m) => m.role === "assistant");
    expect(a2 && a2.role === "assistant" ? a2.toolCalls?.map((c) => c.name) : null).toEqual(["buscar_cliente"]);
  });

  it("perfil generico y vista previa del panel: no se precarga nada y el prompt no cambia", async () => {
    const generico = armar({ precargado: true, deseo: COCA });
    await generico.f.repo.upsertWhatsAppAgentConfig(generico.f.organizationId, null, { ...PM, perfil: "generico" } as never);
    const peticionesAntes = generico.peticiones.length;
    await generico.handler.handleInboundMessage({ organizationId: generico.f.organizationId, phone: PHONE, messages: [{ role: "user", content: "quiero una coca" }], customer: CONOCIDO, propertyId: generico.f.propertyId });
    expect(generico.peticiones[peticionesAntes]!.system).not.toContain(MARCA_CONTEXTO_PRECARGADO);
    expect(generico.peticiones[peticionesAntes]!.messages.filter((m) => m.role === "tool")).toHaveLength(0);

    const vista = armar({ precargado: true, deseo: COCA });
    await vista.f.repo.upsertWhatsAppAgentConfig(vista.f.organizationId, null, PM as never);
    const n = vista.peticiones.length;
    await vista.handler.handleInboundMessage({ organizationId: vista.f.organizationId, phone: PHONE, messages: [{ role: "user", content: "quiero una coca" }], customer: CONOCIDO, propertyId: vista.f.propertyId, modo: "preview" });
    expect(vista.peticiones[n]!.system).not.toContain(MARCA_CONTEXTO_PRECARGADO);
    expect(vista.peticiones[n]!.messages.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("observabilidad: el evento del turno dice que se precargo; las lecturas del servidor salen como vuelta 0", async () => {
    const eventos: Array<Record<string, unknown>> = [];
    const t = armar({ precargado: true, deseo: COCA, observabilidad: { emitir: (e) => eventos.push(e as unknown as Record<string, unknown>) } });
    await t.turno("quiero una coca para recoger", CONOCIDO);
    const turno = eventos.find((e) => e.evento === "whatsapp_turno")!;
    expect(turno.precargado).toEqual({ cliente: true, productos: 1 });
    const previas = eventos.filter((e) => e.evento === "whatsapp_tool" && e.vuelta === 0).map((e) => e.tool);
    expect(previas).toEqual(["buscar_cliente", "buscar_producto"]);
  });

  it("cliente nuevo: lo sigue cubriendo el bloque de R10 (no se duplica con un intercambio de buscar_cliente)", async () => {
    const t = armar({ precargado: true, deseo: SALUDO });
    const r = await t.turno("hola", NUEVO);
    expect(r.primera.system).toContain(MARCA_DATOS_YA_CONSULTADOS);
    expect(r.primera.messages.filter((m) => m.role === "tool")).toHaveLength(0);
  });
});

// ─── guardas intactas ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("guardas existentes con la bandera encendida", () => {
  function webhook(precargado: boolean) {
    const f = buildRestaurantFixture();
    let cola: LlmCompletionResult[] = [];
    const peticiones: LlmCompletionRequest[] = [];
    const provider = new FakeLlmProvider({ id: "sim", script: (req) => { peticiones.push(req); return cola.shift() ?? texto("Con gusto."); } });
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    gateway.registerLadder("default", [provider]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", ...(precargado ? { contextoPrecargado: true } : {}) });
    let n = 0;
    const turno = async (body: string, respuestas: LlmCompletionResult[]) => {
      cola = [...respuestas];
      const antes = peticiones.length;
      n += 1;
      const outcome = await handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: `wamid.P${n}`, phone: PHONE, body, phoneNumberId: "pn-precarga" });
      return { outcome, vueltas: peticiones.length - antes, ultima: peticiones[peticiones.length - 1]! };
    };
    const pedidos = async () => {
      const c = await f.repo.findCustomerByPhone(f.organizationId, normalizePhone(PHONE));
      return c ? await f.repo.listEligibleOrderHistory(c.id) : [];
    };
    return { f, turno, pedidos };
  }

  for (const precargado of [false, true]) {
    it(`idempotencia de crear_pedido y resumen mostrado: el lote [confirmar_resumen, crear_pedido] + un crear_pedido repetido dejan UN pedido (bandera ${precargado ? "encendida" : "apagada"})`, async () => {
      const t = webhook(precargado);
      await t.f.repo.upsertWhatsAppAgentConfig(t.f.organizationId, null, PM as never);
      const items = [{ product_id: t.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
      const cotizar = llamadas(["q", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items }]);
      const resumen = texto("Su pedido: 1 Coca-Cola, total $45.00 para recoger. ¿Lo confirma?");
      await t.turno("quiero una coca para recoger", [cotizar, resumen]);
      const crear = (id: string) => [id, "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Luis Canul", payment_method: "efectivo", items }] as const;
      const r = await t.turno("si", [llamadas(["k", "confirmar_resumen", {}], crear("c1")), llamadas(crear("c2")), texto("Su pedido ya quedó registrado.")]);
      expect(r.outcome.orderId).not.toBeNull();
      expect(await t.pedidos()).toHaveLength(1);
    });
  }

  it("crear_pedido ANTES de confirmar_resumen sigue rechazado con la bandera encendida (el lote no se salta la dependencia)", async () => {
    const t = webhook(true);
    await t.f.repo.upsertWhatsAppAgentConfig(t.f.organizationId, null, PM as never);
    const items = [{ product_id: t.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
    await t.turno("quiero una coca para recoger", [llamadas(["q", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items }]), texto("Su pedido: 1 Coca-Cola, total $45.00 para recoger. ¿Lo confirma?")]);
    const crear = ["c1", "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Luis Canul", payment_method: "efectivo", items }] as const;
    const r = await t.turno("si", [llamadas(crear, ["k", "confirmar_resumen", {}]), llamadas(crear), texto("Listo.")]);
    const resultados = r.ultima.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(resultados[0]).toContain('"error"');
  });
});

// ─── medicion ANTES / DESPUES ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("vueltas del modelo por tipo de turno, bandera apagada vs encendida (modelo obediente)", () => {
  const casos: Array<{ nombre: string; mensaje: string; customer: CustomerLookupResult; deseo: Deseo; antes: number; despues: number }> = [
    { nombre: "saludo, cliente nuevo", mensaje: "hola", customer: NUEVO, deseo: SALUDO, antes: 1, despues: 1 },
    { nombre: "saludo, cliente conocido", mensaje: "hola", customer: CONOCIDO, deseo: SALUDO, antes: 2, despues: 1 },
    { nombre: "una coca para recoger (conocido)", mensaje: "quiero una coca para recoger", customer: CONOCIDO, deseo: COCA, antes: 4, despues: 2 },
    { nombre: "tres productos (coca, sol y tacos de bistec)", mensaje: "quiero coca, sol y tacos de bistec", customer: CONOCIDO, deseo: TRES, antes: 5, despues: 1 },
  ];
  const tabla: string[] = [];
  for (const c of casos) {
    it(`${c.nombre}: ${c.antes} -> ${c.despues} vueltas`, async () => {
      const antes = await armar({ precargado: false, deseo: c.deseo }).turno(c.mensaje, c.customer);
      const despues = await armar({ precargado: true, deseo: c.deseo }).turno(c.mensaje, c.customer);
      tabla.push(`| ${c.nombre} | ${antes.vueltas} | ${despues.vueltas} |`);
      expect(antes.vueltas).toBe(c.antes);
      expect(despues.vueltas).toBe(c.despues);
      expect(despues.vueltas).toBeLessThanOrEqual(antes.vueltas);
    });
  }

  it("el «si» (resumen vigente): secuencial 3 vueltas sin bandera; en lote 2 con bandera (el servidor acepta el lote en ambos casos; lo que cambia es la instruccion al modelo)", async () => {
    const sec = (conMarca: boolean) => {
      const f = buildRestaurantFixture();
      const peticiones: LlmCompletionRequest[] = [];
      let cola: LlmCompletionResult[] = [];
      const provider = new FakeLlmProvider({ id: "sim", script: (req) => { peticiones.push(req); return cola.shift() ?? texto("Con gusto."); } });
      const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
      gateway.registerLadder("default", [provider]);
      gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
      const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", ...(conMarca ? { contextoPrecargado: true } : {}) });
      return { f, peticiones, handler, poner: (c: LlmCompletionResult[]) => { cola = c; } };
    };
    for (const conMarca of [false, true]) {
      const t = sec(conMarca);
      await t.f.repo.upsertWhatsAppAgentConfig(t.f.organizationId, null, PM as never);
      const items = [{ product_id: t.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
      t.poner([llamadas(["q", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items }]), texto("Su pedido: 1 Coca-Cola, total $45.00 para recoger. ¿Lo confirma?")]);
      await handleInboundWhatsAppMessage(t.f.repo, t.handler, { organizationId: t.f.organizationId, messageId: "wamid.S1", phone: PHONE, body: "quiero una coca para recoger", phoneNumberId: "pn-s" });
      const crear = ["c", "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Luis Canul", payment_method: "efectivo", items }] as const;
      // El modelo obediente: con la marca junta; sin ella, una herramienta por respuesta.
      t.poner(conMarca ? [llamadas(["k", "confirmar_resumen", {}], crear), texto("Su pedido ya quedó registrado.")] : [llamadas(["k", "confirmar_resumen", {}]), llamadas(crear), texto("Su pedido ya quedó registrado.")]);
      const antes = t.peticiones.length;
      const r = await handleInboundWhatsAppMessage(t.f.repo, t.handler, { organizationId: t.f.organizationId, messageId: "wamid.S2", phone: PHONE, body: "si", phoneNumberId: "pn-s" });
      const vueltas = t.peticiones.length - antes;
      expect(r.orderId).not.toBeNull();
      expect(vueltas).toBe(conMarca ? 2 : 3);
      if (conMarca) expect(t.peticiones[antes]!.system).toContain(MARCA_CONTEXTO_PRECARGADO);
      tabla.push(`| el «si» (confirmar_resumen + crear_pedido), bandera ${conMarca ? "encendida" : "apagada"} | ${conMarca ? "-" : vueltas} | ${conMarca ? vueltas : "-"} |`);
    }
  });

  it("tabla (se imprime al correr con --reporter=verbose)", () => {
    console.info(["| Turno | Vueltas sin bandera | Vueltas con bandera |", "|---|---|---|", ...tabla].join("\n"));
    expect(tabla.length).toBeGreaterThan(0);
  });
});
