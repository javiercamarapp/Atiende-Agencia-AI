// QA-PM-R8, lote L3 (guardas de servidor y datos obligatorios). Pruebas deterministas, sin LLM real ni base real, con reloj fijo y sin TZ:
//   A41  falso exito: «Su pedido ... ya quedó registrado» sin pedido (la frase larga se escapaba de la guarda; el estado `creando` contaba como pedido).
//   A38  pedido sin nombre confirmado (relleno «Cliente», vacío, marcado HTML/SQL).
//   T7-002  coordenada mal formada (lng=-614100 leída como -61.41 → «2,922 km»): se rechaza sin nombrar sucursal ni escalar.
//   G5/T7-026/T7-049..051  el domicilio lo atiende OTRA sucursal que la del chat: el servidor da nombre y teléfono.
//   T7-014  casa descrita con referencias visuales y sin pin: se pide el pin una vez antes de registrar.
//   T7-035/T7-002  «salsa de ajo» es la crema de ajo (alias) y no se sustituye por otra salsa.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { assignBranch, UBICACION_IMPLAUSIBLE_KM } from "../src/branch-assignment.ts";
import { OrderValidationError } from "../src/errors.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { canonicalRequestedComplement } from "../src/order-quote.ts";
import { NOMBRE_NO_UTILIZABLE_MENSAJE, nombreDeClienteUtilizable, validateCreateOrderPayload } from "../src/orders.ts";
import { afirmaPedidoRegistrado, quitarAfirmacionDePedidoRegistrado, requierePinAntesDeCrear } from "../src/whatsapp/guards.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { seedConfirmedOrderFlow } from "./support/order-flow-seed.ts";

// ── A41: guarda de falso exito ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("A41 afirmaPedidoRegistrado: el pedido descrito en la frase no la esconde", () => {
  it.each([
    "Su pedido ya quedó registrado.",
    "Su pedido de 2 tacos al pastor por $84 en García Lavín quedó registrado.",
    "Su pedido de 2 tacos al pastor ($84) para recoger en García Lavín (Victory Platz) en unos 40 minutos ya quedó registrado.",
    "Gracias, su orden de 2 tacos de pastor ($84) para recoger en García Lavín (Victory Platz) fue registrada.",
    "Carlos, su pedido de 4 tacos al pastor de maíz, para recoger en García Lavín, ya fue confirmado.",
  ])("afirma: %s", (frase) => {
    expect(afirmaPedidoRegistrado(frase)).toBe(true);
  });

  // Corpus NEGATIVO: frases que NO afirman un pedido registrado y no deben activar la guarda.
  it.each([
    "Su pedido de 2 tacos al pastor por $84 en García Lavín quedará registrado cuando me confirme.",
    "¿Su pedido de 2 tacos al pastor ($84) ya quedó registrado?",
    "Para que su pedido de 2 tacos al pastor en García Lavín quede registrado, necesito su nombre.",
    "Si confirma, su pedido de 2 tacos al pastor por $84 queda registrado de inmediato.",
    "Su pedido de 2 tacos al pastor por $84 todavía no está registrado.",
    "Su dirección quedó registrada. Su pedido de 2 tacos sigue por confirmar.",
    "Su pedido incluye 2 tacos al pastor; la dirección de entrega quedó registrada como Calle 32 #345.",
    "El total de su pedido de 2 tacos al pastor en García Lavín es de $84.",
    "Su nombre quedó registrado, Carlos. ¿Confirmo el pedido de 2 tacos al pastor?",
    "Una vez que confirme, su pedido de 2 tacos de pastor quedará anotado.",
    "Su pedido de 2 tacos al pastor por $84 en García Lavín quedaría registrado al confirmar.",
    "Su pedido de 2 tacos al pastor por $84 podría quedar registrado en unos minutos.",
    "Su pedido de 2 tacos al pastor por $84 va a quedar registrado al confirmar.",
    "Su pedido de 2 tacos al pastor en García Lavín no pudo ser registrado.",
    "Su pedido de 2 tacos al pastor en García Lavín tampoco quedó registrado.",
    "Su pedido de 3 tacos tiene el precio confirmado de $126.",
    "Su pedido de 3 tacos lleva el envío confirmado a Calle 60 por $35.",
    "Su pedido de 3 tacos al pastor con la cortesía tomada de la promoción suma $84.",
    "Su pedido de 3 tacos tiene el cambio anotado para $200.",
  ])("no afirma: %s", (frase) => {
    expect(afirmaPedidoRegistrado(frase)).toBe(false);
  });

  it("la frase larga se quita cuando no hay pedido y lo demás se conserva", () => {
    const r = quitarAfirmacionDePedidoRegistrado("Su pedido de 2 tacos al pastor ($84) para recoger en García Lavín ya quedó registrado. ¿Algo más?");
    expect(r).toBe("¿Algo más?");
  });
});

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PHONE = "+5219990001111";
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };

async function turnoConFlujo(respuesta: string, estado: "creando" | "creado-con-id" | "creado-sin-id") {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script: () => texto(respuesta) })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] });
  const snap = await f.repo.readOrderFlow(f.organizationId, `wa:${PHONE}`);
  const ctx = snap!.context!;
  const siguiente =
    estado === "creando" ? { state: "creando" as const, context: { ...ctx, claimedAtMs: Date.now() } } : estado === "creado-con-id" ? { state: "creado" as const, context: { ...ctx, orderId: "00000000-0000-4000-8000-000000000001" } } : { state: "creado" as const, context: ctx };
  await f.repo.writeOrderFlow(f.organizationId, `wa:${PHONE}`, snap!.version, siguiente, 3600);
  return handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: "sí, correcto" }], customer: { isNew: true as const }, propertyId: null });
}

describe("A41 el turno solo dice «registrado» con un pedido con id", () => {
  const FRASE = "Su pedido de 2 tacos al pastor ($84) para recoger en García Lavín ya quedó registrado.";
  it("reclamo en vuelo (`creando`) SIN pedido: la afirmación se quita", async () => {
    const t = await turnoConFlujo(FRASE, "creando");
    expect(t.reply).not.toMatch(/qued[oó] registrado/);
    expect(t.orderId).toBeNull();
  });
  it("estado `creado` SIN orderId (retenido): la afirmación se quita", async () => {
    const t = await turnoConFlujo(FRASE, "creado-sin-id");
    expect(t.reply).not.toMatch(/qued[oó] registrado/);
  });
  it("estado `creado` CON orderId: el camino feliz conserva la frase", async () => {
    const t = await turnoConFlujo(FRASE, "creado-con-id");
    expect(t.reply).toContain("ya quedó registrado");
  });
});

// ── A38: nombre obligatorio ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("A38 nombreDeClienteUtilizable (contrato de entrada)", () => {
  it.each([0, "", "   ", null, undefined, false, true, [], {}, ["Carlos"], { n: "Carlos" }, Number.NaN, 42])("rechaza el valor no-nombre %j", (v) => {
    expect(nombreDeClienteUtilizable(v)).toBe(false);
  });
  it.each(["Cliente", "cliente", "CLIENTE.", "Cliente WhatsApp", "Sin nombre", "N/A", "anónimo", "Desconocido", "1234", "?!", "---", "Cliente 2", "Cliente frecuente", "El cliente", "Cliente de WhatsApp", "Contacto de WhatsApp", "Nombre del cliente", "No especificó", "Sin especificar", "Señor", "Amigo", "<script>alert(1)</script>", "Robert'); DROP TABLE pedidos;--", "' OR '1'='1", "x'; DELETE FROM clientes; --", "{{nombre}}", "`rm -rf`", "$(whoami)"])("rechaza el relleno o el código %j", (v) => {
    expect(nombreDeClienteUtilizable(v)).toBe(false);
  });
  // Negativos: nombres reales que NO deben rechazarse.
  it.each(["Carlos Prueba", "Ana", "María José", "José Luis Pérez-García", "O'Brien", "Zoë", "Dr. Ramírez", "Cliente Pérez", "Li", "X", "Juan Carlos (oficina)", "María [oficina]", "Juan -- oficina", "María; recoge Juan", "Ana = esposa de Luis", "Cliente Pérez", "Luis (el de la select)"])("acepta el nombre real %j", (v) => {
    expect(nombreDeClienteUtilizable(v)).toBe(true);
  });

  const base = { organizationId: randomUUID(), branchSlug: "fco-montejo", customerPhone: "+5219990001111", items: [{ productName: "Coca-Cola", quantity: 1 }], paymentMethod: "efectivo" as const, canal: "recoger" as const };
  it("un pedido de WhatsApp o voz con nombre de relleno se rechaza con un mensaje accionable (sin escalar)", () => {
    for (const source of ["whatsapp", "voice"] as const) {
      expect(() => validateCreateOrderPayload({ ...base, source, customerName: "Cliente", ...(source === "voice" ? { customerPhone: "9991234567" } : {}) })).toThrow(NOMBRE_NO_UTILIZABLE_MENSAJE);
    }
    expect(NOMBRE_NO_UTILIZABLE_MENSAJE).toMatch(/No es motivo para escalar/);
  });
  it("el mismo nombre en una captura manual (admin) o web no cambia: la regla es de los agentes", () => {
    expect(() => validateCreateOrderPayload({ ...base, source: "admin", customerName: "Cliente" })).not.toThrow();
    expect(() => validateCreateOrderPayload({ ...base, source: "web", customerName: "Cliente" })).not.toThrow();
  });
  it("un nombre real pasa en WhatsApp", () => {
    expect(() => validateCreateOrderPayload({ ...base, source: "whatsapp", customerName: "Carlos Prueba" })).not.toThrow();
  });
  it("crear_pedido por el registro rechaza «Cliente» y no crea el pedido", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
    const entrada = { branch_slug: "fco-montejo", customer_name: "Cliente", canal: "recoger", payment_method: "efectivo", items: [{ product_id: f.products.cocaCola, requested_quantity: 1 }] };
    await expect(invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: PHONE }, "crear_pedido", entrada)).rejects.toThrow(OrderValidationError);
    await expect(invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: PHONE }, "crear_pedido", entrada)).rejects.toThrow(/nombre del cliente/);
  });
});

// ── T7-002 / G5 / T7-026 / T7-049..051: sucursal ────────────────────────────────────────────────────────────────────────────────────────
function mundoDosSucursales() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  const garcia = randomUUID();
  const montejo = randomUUID();
  repo.seedBranch({ propertyId: garcia, organizationId, name: "García Lavín (Victory Platz)", slug: "garcia-lavin", status: "active", phone: "999 518 2637", address: null, lat: 21.0211, lng: -89.6141 });
  repo.seedBranch({ propertyId: montejo, organizationId, name: "Prolongación Montejo", slug: "prol-montejo", status: "active", phone: "999 944 0342", address: null, lat: 21.0282, lng: -89.6098 });
  repo.seedBranchPolicy(garcia, { aceptaDomicilio: true });
  repo.seedBranchPolicy(montejo, { aceptaDomicilio: true });
  return { repo, organizationId, garcia, montejo };
}
const ctxWa = (organizationId: string, extra: Record<string, unknown> = {}) => ({ organizationId, channel: "whatsapp" as const, phone: "9991234567", ...extra });

describe("T7-002 coordenada absurda: sigue siendo fuera_de_zona pero sin sucursal ni distancia que escalar", () => {
  const pm = { perfil: "taqueria_pm" as const, agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] };
  it("assignBranch marca el pin con lng=-61.41 (mal formado) como ubicacionImplausible", async () => {
    const m = mundoDosSucursales();
    const r = await assignBranch(m.repo, { organizationId: m.organizationId, lat: 21.0211, lng: -61.41, radioMaximoKm: 8 });
    expect(r).toMatchObject({ estado: "fuera_de_zona", ubicacionImplausible: true });
  });
  it("por la herramienta: no nombra sucursal ni distancia y manda a pedir la ubicacion de nuevo sin escalar", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, pm);
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { lat: 21.0211, lng: -61.41 })).result as Record<string, unknown>;
    expect(r).toMatchObject({ encontrada: false, estado: "fuera_de_zona", ubicacion_sospechosa: true });
    expect(Object.keys(r).sort()).toEqual(["encontrada", "estado", "mensaje", "reparto", "ubicacion_sospechosa"]); // sin branch_slug_mas_cercana, distancia_km ni max_km
    const mensaje = String(r.mensaje);
    expect(mensaje).not.toMatch(/\d{3,} ?km|García Lavín|Montejo/);
    expect(mensaje).toMatch(/NO escale/);
    expect(mensaje).toMatch(/comparta de nuevo/);
  });
  it("el limite: a 998 km sigue siendo un fuera_de_zona normal (con sucursal y distancia) y a 1002 km es implausible", async () => {
    const m = mundoDosSucursales();
    const grados = (km: number) => km / 111.19; // un grado de latitud ~ 111.19 km
    const lejos = async (km: number) => assignBranch(m.repo, { organizationId: m.organizationId, lat: 21.0211 + grados(km), lng: -89.6141, radioMaximoKm: 8 });
    const cerca = await lejos(UBICACION_IMPLAUSIBLE_KM - 2);
    expect(cerca.estado).toBe("fuera_de_zona");
    expect("ubicacionImplausible" in cerca).toBe(false);
    expect(await lejos(UBICACION_IMPLAUSIBLE_KM + 2)).toMatchObject({ estado: "fuera_de_zona", ubicacionImplausible: true });
  });
  it("ciudades reales (Valladolid 151 km, Campeche 161, Cancún 286) son fuera_de_zona normal, no pin mal formado", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    for (const km of [151, 161, 286]) {
      const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { lat: 21.0211 + km / 111.19, lng: -89.6141 })).result as Record<string, unknown>;
      expect(r, String(km)).toMatchObject({ estado: "fuera_de_zona", branch_slug_mas_cercana: expect.any(String) });
      expect(r.ubicacion_sospechosa).toBeUndefined();
    }
  });
  it("el mensaje de ubicacion implausible es neutro (sirve por voz): no habla de botones ni del chat", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { lat: 21.0211, lng: -61.41 })).result as Record<string, unknown>;
    expect(String(r.mensaje)).not.toMatch(/bot[oó]n|chat|WhatsApp/i);
  });
  it("un fuera_de_zona normal (20 km) conserva sucursal mas cercana y distancia", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, pm);
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { lat: 21.0211 + 20 / 111.19, lng: -89.6141 })).result as Record<string, unknown>;
    expect(r).toMatchObject({ estado: "fuera_de_zona", branch_slug_mas_cercana: "prol-montejo" });
    expect(typeof r.distancia_km).toBe("number");
    expect(r.ubicacion_sospechosa).toBeUndefined();
  });
  it("sin radio de reparto (organización sin tope) no se recorta: se conserva el comportamiento anterior", async () => {
    const m = mundoDosSucursales();
    const r = await assignBranch(m.repo, { organizationId: m.organizationId, lat: 21.0211, lng: -61.41, radioMaximoKm: null });
    expect(r.estado).toBe("asignada");
  });
  it("un pin real cerca de una sucursal sigue asignándose igual", async () => {
    const m = mundoDosSucursales();
    const r = await assignBranch(m.repo, { organizationId: m.organizationId, lat: 21.0212, lng: -89.6140, radioMaximoKm: 8 });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin" });
  });
});

type ResultadoSucursal = { estado: string; branch_slug: string; atiende_otra_sucursal?: { aviso: string; telefono?: string } };

describe("G5/T7-026/T7-049..051 el domicilio lo atiende otra sucursal que la del chat", () => {
  const pm = { perfil: "taqueria_pm" as const, agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] };
  it("con el chat de García Lavín y un pin de Montejo, el resultado trae nombre, teléfono y la instrucción de no decir «sí entregamos»", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, pm);
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId, { entryPropertyId: m.garcia }), "buscar_sucursal_cercana", { lat: 21.0283, lng: -89.6097 })).result as unknown as ResultadoSucursal;
    expect(r.estado).toBe("asignada");
    expect(r.branch_slug).toBe("prol-montejo");
    expect(r.atiende_otra_sucursal).toMatchObject({ branch_slug: "prol-montejo", telefono: "999 944 0342", chat_de: "García Lavín (Victory Platz)" });
    expect(r.atiende_otra_sucursal!.aviso).toMatch(/NO conteste «sí, entregamos»/);
    expect(r.atiende_otra_sucursal!.aviso).toMatch(/999 944 0342/);
    expect(r.atiende_otra_sucursal!.aviso).toMatch(/Ofrezca recoger en García Lavín/);
    expect(r.atiende_otra_sucursal!.aviso).toMatch(/insiste de nuevo, escale UNA vez con motivo zona_ambigua/);
  });
  it("sin teléfono cargado, el aviso manda a la lista de datos del negocio (no inventa uno)", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, pm);
    const sinTel = { propertyId: m.montejo, organizationId: m.organizationId, name: "Prolongación Montejo", slug: "prol-montejo", status: "active" as const, phone: null, address: null, lat: 21.0282, lng: -89.6098 };
    m.repo.seedBranch(sinTel);
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId, { entryPropertyId: m.garcia }), "buscar_sucursal_cercana", { lat: 21.0283, lng: -89.6097 })).result as unknown as ResultadoSucursal;
    expect(r.atiende_otra_sucursal!.telefono).toBeUndefined();
    expect(r.atiende_otra_sucursal!.aviso).toMatch(/DATOS DEL NEGOCIO/);
  });
  it("colonia reconocida sin cobertura confirmada (sugerida) cuya referencia es OTRA sucursal: aviso de referencia no confirmada, sin prometer entrega", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, pm);
    const zona = randomUUID();
    const otra = randomUUID();
    m.repo.seedKnownZone({ id: zona, organizationId: m.organizationId, name: "Zona Nueva", lat: 21.0283, lng: -89.6097 });
    m.repo.seedKnownZone({ id: otra, organizationId: m.organizationId, name: "Otra Zona", lat: 21.5, lng: -89.6 });
    m.repo.seedBranchDeliveryZones(m.garcia, [otra]);
    m.repo.seedBranchDeliveryZones(m.montejo, [otra]);
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId, { entryPropertyId: m.garcia }), "buscar_sucursal_cercana", { colonia: "Zona Nueva" })).result as unknown as { estado: string; referencia_otra_sucursal?: { branch_slug: string; aviso: string } };
    expect(r.estado).toBe("sugerida");
    expect(r.referencia_otra_sucursal).toMatchObject({ branch_slug: "prol-montejo" });
    expect(r.referencia_otra_sucursal!.aviso).toMatch(/NO confirmada/);
    expect(r.referencia_otra_sucursal!.aviso).toMatch(/No diga que entregan/);
    // si la referencia es la sucursal del chat, no aparece
    const mismo = (await invokeAgentTool(m.repo, ctxWa(m.organizationId, { entryPropertyId: m.montejo }), "buscar_sucursal_cercana", { colonia: "Zona Nueva" })).result as unknown as { referencia_otra_sucursal?: unknown };
    expect(mismo.referencia_otra_sucursal).toBeUndefined();
  });
  it("si la sucursal asignada ES la del chat, el resultado no cambia (camino feliz)", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, pm);
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId, { entryPropertyId: m.garcia }), "buscar_sucursal_cercana", { lat: 21.0212, lng: -89.614 })).result as unknown as ResultadoSucursal;
    expect(r.branch_slug).toBe("garcia-lavin");
    expect(r.atiende_otra_sucursal).toBeUndefined();
  });
  it("sin sucursal de entrada (número único o voz) tampoco aparece", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, pm);
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { lat: 21.0283, lng: -89.6097 })).result as unknown as ResultadoSucursal;
    expect(r.atiende_otra_sucursal).toBeUndefined();
  });
});

// ── T7-014: pin antes de crear ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("T7-014 requierePinAntesDeCrear: solo una referencia visual SIN direccion verificable", () => {
  const u = (content: string) => ({ role: "user" as const, content });
  const a = (content: string) => ({ role: "assistant" as const, content });
  const CASA = "Estoy en Real Montejo, son 5 casas iguales, es la única con cochera techada. Un kilo de bistec con tortillas de maíz. Pago con tarjeta";
  const exige = (texto: string, direccion?: string) => requierePinAntesDeCrear([u(texto), a("Le cotizo $1,100. ¿Confirma?"), u("sí")], direccion);

  it("solo referencia visual, sin pin y sin que se lo hayan pedido: SÍ", () => {
    expect(exige(CASA)).toBe(true);
  });
  // Corpus POSITIVO: la direccion es solo una referencia visual.
  it.each([
    CASA,
    "Es la casa azul con portón, por el parque",
    "Es la casa naranja de dos pisos, cerca de la tienda",
    "Son 4 casas iguales, la mía es la única con la puerta roja",
    "Es difícil de encontrar, hay que entrar por el terregal",
    "Vivo en una casa verde frente al Oxxo, la única con palmera",
    "Casa blanca con rejas, en el Fracc. Las Américas",
    "Es una casa amarilla, tiene dos autos afuera",
  ])("exige el pin: %s", (t) => expect(exige(t)).toBe(true));
  // Corpus NEGATIVO: domicilios completos (con numero, calle+numero, cruzamientos) aunque mencionen rejas, portón, fachada, cochera, casa de color...
  it.each([
    "Calle 32 #345 x 20 y 22, Privada Los Almendros casa 13, Fracc. Xaman Tan. 4 tacos de pastor, efectivo",
    "Calle 60 #345 x 45 y 47, Centro, casa verde con portón negro",
    "Calle 21 #100 x 10 y 12, casa azul, tiene rejas blancas",
    "Calle 8 número 220 entre 15 y 17, la fachada es amarilla",
    "Av. Itzaes 500, cochera para 2 autos",
    "Calle 33 s/n x 20 y 22, Col. Garcia Gineres, zaguán café",
    "Calle 20 #98 por 15, si no me encuentran me marcan",
    "Privada Las Rejas #5, Fracc. Los Pinos",
    "Col. Portón del Sol, calle 12 número 40",
    "Calle 45 x 30 y 32 Altabrisa, es la casa naranja",
    "Calle 10 #55 entre calle 5 y calle 7, casa gris con cochera",
    "Carretera Mérida-Progreso km 12, casa roja con portón",
    "Calle 19 numero 301, la única con cochera techada",
    "Son 5 casas iguales en Calle 5 #100, Real Montejo",
    "Cruzamientos Calle 14 y 16, casa blanca",
    "C. 62 #480 x 55 y 57, casa rosa",
    "Calle 25 # 78, difícil de encontrar, llámeme",
    "Quiero 2 órdenes de frijol con tostadas y un francés suizo, es para mi casa",
    "Vivo en la casa 7 de la privada, pago con tarjeta",
    "Nos vemos en una casa de tacos famosa? no, mejor quiero 3 kilos de pastor",
    "Hola, buenas noches",
    "Mi pedido: 1 kg de bistec, tortilla de maíz",
    "Es en Dzitya, calle 20 #15, portón verde",
    "Av. Colón 485 x 21 y 23, fachada con azulejos",
    "Calle 7 #212 x 18 y 20 Mexico Norte, rejas negras",
    "Calle 30 # 410 x 41 y 43, no me encuentran siempre, es la casa verde",
    "Calle 56 A #301 x 33 y 35 Fracc. Floresta, casa blanca con portón",
    "Calle 16 número 120, casa amarilla esquina con rejas",
  ])("NO exige el pin con direccion completa: %s", (t) => expect(exige(t)).toBe(false));
  it("la direccion verificable del propio pedido (customer_address) tambien cuenta", () => {
    expect(exige("Es la casa azul con portón", "Calle 60 #345 x 45 y 47, Centro")).toBe(false);
    expect(exige("Es la casa azul con portón", "frente al parque")).toBe(true);
  });
  it("nunca se pide dos veces: si el asistente ya pidio la ubicacion en cualquier momento (antes o despues de la referencia), no se exige", () => {
    expect(requierePinAntesDeCrear([u("Quiero 1 kilo de bistec"), a("¿Me comparte su ubicación de WhatsApp?"), u("no tengo cómo, pero es la casa azul con portón"), a("Le cotizo."), u("sí")])).toBe(false);
    expect(requierePinAntesDeCrear([u(CASA), a("¿Me comparte su ubicación de WhatsApp para que el repartidor llegue directo?"), u("sí")])).toBe(false);
    expect(requierePinAntesDeCrear([u(CASA), a("Le mando el enlace; ¿puede mandarme el pin?"), u("ok")])).toBe(false);
  });
  it("si el cliente dice que no puede compartirlo, no se exige", () => {
    expect(requierePinAntesDeCrear([u(CASA), a("Le cotizo $1,100."), u("no puedo compartir la ubicación"), u("sí")])).toBe(false);
    expect(requierePinAntesDeCrear([u(CASA), u("sin pin por favor")])).toBe(false);
    expect(requierePinAntesDeCrear([u(CASA), a("Le cotizo."), u("no tengo cómo compartirla, es la casa azul con portón")])).toBe(false);
  });
  it.each([undefined, null, [], "texto", 0, false, {}, [null], [{ role: "user" }], [{ role: "user", content: 5 }]])("contrato de entrada %j: no truena y no exige", (v) => {
    expect(requierePinAntesDeCrear(v as never)).toBe(false);
  });

  const entrada = (f: ReturnType<typeof buildRestaurantFixture>, direccion = "frente al parque, Real Montejo") => ({
    branch_slug: "fco-montejo",
    customer_name: "Carlos Prueba",
    customer_address: direccion,
    canal: "domicilio",
    payment_method: "tarjeta",
    items: [{ product_id: f.products.cocaCola, requested_quantity: 1 }],
  });
  it("crear_pedido por el registro: PM + domicilio + solo referencia visual + sin pin → rechaza con el mensaje del pin", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
    const ctx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: PHONE, conversacionReciente: [u(CASA), a("Le cotizo $45."), u("sí")] };
    await expect(invokeAgentTool(f.repo, ctx, "crear_pedido", entrada(f))).rejects.toThrow(/solo con referencias visuales/);
    // con direccion completa en el pedido, ya no se rechaza por el pin
    const msg = await invokeAgentTool(f.repo, ctx, "crear_pedido", entrada(f, "Calle 5 #100, Real Montejo")).then(() => "", (e: Error) => e.message);
    expect(msg).not.toMatch(/referencias visuales/);
  });
  it("con el pin compartido, con enlace de Maps, para recoger o con perfil genérico NO se rechaza por el pin", async () => {
    const f = buildRestaurantFixture();
    const conv = [u(CASA), a("Le cotizo $45."), u("sí")];
    const motivo = async (cfg: boolean, extra: Record<string, unknown>, input: Record<string, unknown>) => {
      if (cfg) await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
      return invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp" as const, phone: PHONE, conversacionReciente: conv, ...extra }, "crear_pedido", input).then(
        () => "",
        (e: Error) => e.message,
      );
    };
    expect(await motivo(false, {}, entrada(f))).not.toMatch(/referencias visuales/); // perfil genérico
    expect(await motivo(true, { sharedLocation: { lat: 21.0186, lng: -89.6708 } }, entrada(f))).not.toMatch(/referencias visuales/);
    expect(await motivo(true, {}, { ...entrada(f), maps_url: "https://maps.google.com/?q=21.0186,-89.6708" })).not.toMatch(/referencias visuales/);
    expect(await motivo(true, {}, { ...entrada(f), canal: "recoger" })).not.toMatch(/referencias visuales/);
  });
});

// ── T7-035: alias de salsas ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("T7-035 alias de complementos", () => {
  it.each([
    ["salsa de ajo", "crema_ajo"],
    ["Salsa de Ajo", "crema_ajo"],
    ["salsa_de_ajo", "crema_ajo"],
    ["ajo", "crema_ajo"],
    ["crema de ajo", "crema_ajo"],
    ["habanera", "salsa_habanero"],
    ["salsa habanera", "salsa_habanero"],
    ["salsa de piña", "salsa_pina"],
    ["piña", "pina"],
    ["guacamolera", "salsa_guacamolera"],
  ])("%s → %s", (entrada, esperado) => {
    expect(canonicalRequestedComplement(entrada)).toBe(esperado);
  });
  // Negativos: no se inventan salsas ni se confunde «ajo» dentro de otra frase.
  it.each(["ajonjolí", "salsa de ajonjolí", "queso", "", "   ", 0, null, undefined, false, [], {}])("no reconoce %j", (v) => {
    expect(canonicalRequestedComplement(v)).toBeNull();
  });
});
