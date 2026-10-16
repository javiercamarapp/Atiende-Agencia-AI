// Escenarios K/KH del agente de PM. Estructura y ausencia de datos personales (repo publico) + cada escenario `determinista`
// atado a una comprobacion REAL contra el servidor (registro de herramientas, motor de pedidos, busqueda, entrada de Meta, prompt).
// Lo que depende de algo que main aun no tiene queda como `it.todo` citando de que depende; nunca se finge que pasa.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cargarEscenariosK, escenariosKActivos, escenariosKPendientesDeConstruccion } from "../src/evals/agente-pm/escenarios-k.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { createOrder, searchProducts } from "../src/orders.ts";
import { invokeAgentTool, mapCreateOrderToolInput, MENSAJE_LLEGADA_REGISTRADA, MENSAJE_PEDIDO_TELEFONICO_REGISTRADO } from "../src/agent-tools/registry.ts";
import { PM_BASIC_COMPLEMENTS, canonicalRequestedComplement } from "../src/order-quote.ts";
import { extractMetaInboundMessages, STICKER_MARKER } from "../src/whatsapp/channel-config.ts";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { formatLocationMessage, latestDeliveryPin, parseMapsLink, parseUbicacionEntregaNota } from "../src/whatsapp/location.ts";
import { PM_MARGEN_LLUVIA_MINUTOS, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import type { BranchSummary, CreateOrderInput } from "../src/types.ts";

const suite = cargarEscenariosK();
const PHONE = "5219991234567";

/** Catalogo minimo con los nombres reales del menu de PM (los precios son de prueba). */
function mundo() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  repo.seedBranch({ propertyId, organizationId, name: "Sucursal de prueba", slug: "t7", status: "active", phone: null, address: "Calle de prueba, Mérida", lat: 21.0186, lng: -89.6708 });
  const cat = (name: string) => {
    const id = randomUUID();
    repo.seedCategory({ id, organizationId, name });
    return id;
  };
  const producto = (categoryId: string, name: string, price: number) => {
    const id = randomUUID();
    repo.seedProduct({ id, organizationId, categoryId, name, description: null, searchKeywords: [] });
    repo.seedBranchProduct({ propertyId, productId: id, price, isAvailable: true });
    return id;
  };
  const tacos = cat("Tacos");
  const charros = cat("Frijoles Charros");
  const nachos = cat("Nachos");
  const extras = cat("Extras");
  const bebidas = cat("Bebidas");
  const p = {
    bistec: producto(tacos, "Tacos de Bistec (orden de 3)", 126),
    charrosCompleta: producto(charros, "Frijoles Charros Normal", 123),
    charrosMedia: producto(charros, "Frijoles Charros Normal (1/2 orden)", 70),
    nachosPastor: producto(nachos, "Nachos de Pastor", 150),
    nachosPastorMedia: producto(nachos, "Nachos de Pastor (1/2 orden)", 90),
    extraPina: producto(extras, "Extra Piña", 19),
    coca: producto(bebidas, "Coca-Cola", 45),
  };
  return { repo, organizationId, propertyId, p };
}
type Mundo = ReturnType<typeof mundo>;

const base = (m: Mundo, o: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  organizationId: m.organizationId,
  branchSlug: "t7",
  customerName: "Cliente Sintético",
  customerPhone: PHONE,
  customerAddress: "Calle de prueba 1, Col. Sintética",
  items: [{ productId: m.p.coca, requestedQuantity: 2 }], // $90
  source: "whatsapp",
  paymentMethod: "efectivo",
  canal: "domicilio",
  ...o,
});
const crearConHerramienta = (m: Mundo, input: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) => createOrder(m.repo, { ...mapCreateOrderToolInput({ organizationId: m.organizationId, phone: PHONE, channel: "whatsapp", ...ctxExtra }, { branch_slug: "t7", customer_name: "Cliente Sintético", customer_address: "Calle de prueba 1", payment_method: "efectivo", canal: "domicilio", items: [], ...input }, true), items: [{ productId: m.p.coca, requestedQuantity: 2 }] });
const meta = (message: Record<string, unknown>) => extractMetaInboundMessages({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn" }, messages: [{ id: "w1", from: PHONE, ...message }] } }] }] })[0]!.body;
const BRANCHES = [{ propertyId: "p1", slug: "t7", name: "Sucursal de prueba", address: null } as BranchSummary];
const prompt = (over: Partial<Parameters<typeof buildPmSystemPrompt>[0]> = {}) =>
  buildPmSystemPrompt({ businessName: "Los Taquitos de PM", agentName: "Lupita", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, saludo: "Buenas tardes", branches: BRANCHES, entryBranch: null, customer: { isNew: true }, fechaHoraLocal: "2 de octubre de 2026, 14:10", diaSemana: "viernes", ...over });
const callbacks = (m: Mundo) => (m.repo as unknown as { callbackRequests: Array<{ reason?: string; message?: string; propertyId: string | null }> }).callbackRequests;
const pedidoRecoger = (m: Mundo) => createOrder(m.repo, base(m, { canal: "recoger", customerAddress: undefined, horaRecogida: new Date(Date.now() + 30 * 60_000).toISOString().replace("Z", "+00:00") }));

// Reloj simulado (solo Date): martes 13:00 de Merida. Con el reloj real, +30 min cae en otro dia entre 05:30 y 06:00 UTC y -5 min entre 06:00 y 06:05 UTC.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

/** Una comprobacion REAL por escenario determinista. */
const CHECKS: Record<string, () => Promise<void> | void> = {
  async K01() {
    const m = mundo();
    const o = await crearConHerramienta(m, { requested_complements: ["salsa_guacamolera", "crema_ajo"] });
    expect(o.notes).toContain("Básicas: salsa roja, salsa verde, cebolla con cilantro, limones.");
    expect(o.notes).toContain("Pedidas (sin costo): crema de ajo, salsa guacamolera.");
    expect(o.total).toBe(90);
  },
  async K02() {
    const m = mundo();
    const o = await crearConHerramienta(m, { requested_complements: ["Piña"] });
    expect(o.notes).toContain("Pedidas (sin costo): piña picada.");
    expect(o.total).toBe(90);
    const doble = await searchProducts(m.repo, { propertyId: m.propertyId, query: "extra piña" });
    expect(doble.map((r) => [r.name, Number(r.price)])).toContainEqual(["Extra Piña", 19]);
  },
  async K03() {
    const m = mundo();
    const r = await searchProducts(m.repo, { propertyId: m.propertyId, query: "unos medios charros normal" });
    expect(r.map((x) => x.name)).toEqual(["Frijoles Charros Normal (1/2 orden)"]);
  },
  async K04() {
    const m = mundo();
    const r = await searchProducts(m.repo, { propertyId: m.propertyId, query: "unos nachos grandes de pastor" });
    expect(r.map((x) => x.name)).toContain("Nachos de Pastor");
    expect(r.length).toBeGreaterThan(0);
  },
  K05() {
    expect(canonicalRequestedComplement("xnipec")).toBe("salsa_mexicana");
    expect(canonicalRequestedComplement("cebolla con tomate y limón")).toBe("salsa_mexicana");
  },
  K06() {
    expect(canonicalRequestedComplement("sauceada")).toBe("salsa_habanero_soasado");
    expect(canonicalRequestedComplement("suasada")).toBe("salsa_habanero_soasado");
  },
  async K07() {
    const m = mundo();
    const pin = latestDeliveryPin([{ role: "user", content: formatLocationMessage({ latitude: 21.01, longitude: -89.6 }) }]);
    const o = await crearConHerramienta(m, {}, { ubicacionEntrega: pin });
    expect(parseUbicacionEntregaNota(o.notes)).toEqual({ fuente: "pin", lat: 21.01, lng: -89.6 });
  },
  K08() {
    expect(parseMapsLink("https://www.google.com/maps?q=21.0165,-89.596")).toEqual({ fuente: "link", lat: 21.0165, lng: -89.596 });
    expect(parseMapsLink("https://maps.app.goo.gl/AbC123")).toEqual({ fuente: "link_corto", url: "https://maps.app.goo.gl/AbC123" });
    expect(parseMapsLink("https://evil.example/maps?q=21,-89")).toBeNull();
  },
  async K09() {
    const m = mundo();
    const o = await crearConHerramienta(m, { efectivo_con: 500 });
    expect(o.notes).toContain("Paga con: $500.00 (cambio: $410.00).");
    await expect(crearConHerramienta(m, { efectivo_con: 50 })).rejects.toThrow(/menor al total/);
  },
  async K10() {
    const m = mundo();
    const o = await crearConHerramienta(m, { payment_method: "tarjeta", llevar_terminal: true });
    expect(o.notes).toContain("Llevar terminal.");
    const ef = await crearConHerramienta(m, { llevar_terminal: true, customer_name: "Otro Cliente" });
    expect(ef.notes).not.toContain("Llevar terminal");
  },
  async K11() {
    const m = mundo();
    const o = await crearConHerramienta(m, { indicaciones_acceso: "depto 6, toquen el timbre", telefono_alterno: "9991234568" });
    expect(o.notes).toContain("Indicaciones de acceso: depto 6, toquen el timbre.");
    expect(o.notes).toContain("Teléfono alterno: 9991234568.");
    await expect(crearConHerramienta(m, { telefono_alterno: "123456" })).rejects.toThrow(/10 dígitos/);
  },
  K12() {
    const imagen = meta({ type: "image", image: { id: "x" } });
    expect(imagen).toContain("si es su ubicación pida el pin de WhatsApp");
    expect(imagen).toContain("pida que la describa en una línea");
    expect(imagen).not.toMatch(/no puede abrir/);
  },
  async K13() {
    const m = mundo();
    let turnos = 0;
    const handler: WhatsAppTurnHandler = { async handleInboundMessage() { turnos += 1; return { reply: "x", orderId: null, propertyId: null }; } };
    await createOrder(m.repo, base(m));
    expect(meta({ type: "sticker", sticker: { id: "s" } })).toBe(STICKER_MARKER);
    const out = await handleInboundWhatsAppMessage(m.repo, handler, { organizationId: m.organizationId, messageId: "st", phone: PHONE, body: STICKER_MARKER, phoneNumberId: "1" });
    expect(out).toEqual({ ok: true, retryable: false });
    expect(turnos).toBe(0);
  },
  K14() {
    const borrado = meta({ type: "unsupported", errors: [{ code: 131051 }] });
    expect(borrado).toMatch(/pregúntele qué quería antes de aplicarlo/);
  },
  K15() {
    expect(prompt()).toMatch(/MÁS TARDE EL MISMO DÍA[^\n]*programado_para[^\n]*MISMA en cotizar_pedido y en crear_pedido/);
    const out = mapCreateOrderToolInput({ organizationId: "o", phone: PHONE, channel: "whatsapp" }, { programado_para: "2026-10-04T20:30:00-06:00" }, true);
    expect(out.programadoPara).toBe("2026-10-04T20:30:00-06:00");
  },
  K16() {
    expect(prompt()).toContain(`más unos ${PM_MARGEN_LLUVIA_MINUTOS} minutos`);
    expect(prompt()).not.toMatch(/1 hora a 1 hora 20/);
  },
  K17() {
    expect(prompt()).toMatch(/sí, el sistema le manda un mensaje de "va en camino"/);
    expect(prompt()).toMatch(/Un aviso de LLEGADA del repartidor no existe/);
  },
  async K18() {
    const m = mundo();
    await pedidoRecoger(m);
    const out = await invokeAgentTool(m.repo, { organizationId: m.organizationId, channel: "whatsapp", phone: PHONE }, "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego", message: "auto gris" });
    expect(out.result).toEqual({ ok: true, mensaje_al_cliente: MENSAJE_LLEGADA_REGISTRADA });
    expect(callbacks(m).some((c) => c.reason === "cliente_llego")).toBe(true);
  },
  K19() {
    expect(prompt({ urlFacturacion: "https://facturas.ejemplo.test/pm" })).toContain("https://facturas.ejemplo.test/pm");
    expect(prompt()).toMatch(/No tiene el enlace de facturación: NO lo invente/);
  },
  async K20() {
    const m = mundo();
    const out = await invokeAgentTool(m.repo, { organizationId: m.organizationId, channel: "whatsapp", phone: PHONE, ubicacionEntrega: { fuente: "pin", lat: 21.01, lng: -89.6 } }, "registrar_contacto", { customer_name: "Ana", reason: "pedido_telefonico", message: "depto 6" });
    expect(out.result).toEqual({ ok: true, mensaje_al_cliente: MENSAJE_PEDIDO_TELEFONICO_REGISTRADO });
    expect(out.orderId).toBeNull();
  },
};

describe("escenarios K y KH: estructura", () => {
  it("22 K y 10 KH con id unico y secuencial", () => {
    expect(suite.escenarios.filter((e) => e.id.startsWith("K") && !e.id.startsWith("KH"))).toHaveLength(22);
    expect(suite.escenarios.filter((e) => e.id.startsWith("KH"))).toHaveLength(10);
    expect(suite.escenarios.map((e) => e.id)).toEqual([...Array.from({ length: 22 }, (_, i) => `K${String(i + 1).padStart(2, "0")}`), ...Array.from({ length: 10 }, (_, i) => `KH${String(i + 1).padStart(2, "0")}`)]);
    expect(new Set(suite.escenarios.map((e) => e.intencion)).size).toBe(32);
  });

  it("cada escenario trae lo necesario; los pendientes citan de que dependen y los deterministas, su prueba", () => {
    for (const e of suite.escenarios) {
      expect(e.canal, e.id).toBe("chat");
      expect(e.turnos_cliente.length, e.id).toBeGreaterThan(0);
      expect(e.comportamiento_esperado.length, e.id).toBeGreaterThan(20);
      expect(e.que_no_debe_hacer.length, e.id).toBeGreaterThan(5);
      if (e.estado === "pendiente_construccion") expect(e.depende_de, e.id).toMatch(/\S{8}/);
      else expect(e.depende_de, e.id).toBeNull();
      if (e.estado === "activo" && e.verificacion === "determinista") expect(e.prueba, e.id).toMatch(/tests\//);
    }
  });
});

describe("escenarios K y KH: sin datos personales (repo publico)", () => {
  const texto = (e: (typeof suite.escenarios)[number]) => [...e.turnos_cliente, e.comportamiento_esperado, e.que_no_debe_hacer, e.intencion].join("\n");
  it.each([
    ["telefono", /(?:\+?\d[\s().-]?){7,}/],
    ["correo", /[\w.+-]+@[\w-]+\.[\w.]+/],
    ["enlace", /https?:\/\/|www\.|maps\.app|goo\.gl/i],
    ["coordenadas", /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/],
    ["direccion con numero", /\b(?:calle|c\.)\s*\d+|#\s*\d+/i],
    ["presentacion con nombre propio", /\b(?:me llamo|mi nombre es|soy)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/],
  ] as const)("ningun escenario trae %s", (_n, patron) => {
    expect(suite.escenarios.filter((e) => patron.test(texto(e))).map((e) => e.id)).toEqual([]);
  });
});

describe("escenarios K y KH deterministas: cada uno pasa contra el servidor real", () => {
  const deterministas = escenariosKActivos().filter((e) => e.verificacion === "determinista");
  it("los activos deterministas son exactamente los que tienen comprobacion", () => {
    expect(deterministas.map((e) => e.id).sort()).toEqual(Object.keys(CHECKS).sort());
  });
  for (const e of deterministas) it(`${e.id} ${e.intencion}`, async () => CHECKS[e.id]!());
});

describe("escenarios K y KH con juez o pendientes de construccion", () => {
  it("los de juez activos se listan (los evalua un LLM o una persona, no el CI)", () => {
    const juez = escenariosKActivos().filter((e) => e.verificacion === "juez");
    expect(juez.map((e) => e.id)).toEqual(["KH09"]);
  });
  for (const e of escenariosKPendientesDeConstruccion()) it.todo(`${e.id} ${e.intencion}: depende de ${e.depende_de}`);
});

void PM_BASIC_COMPLEMENTS;
