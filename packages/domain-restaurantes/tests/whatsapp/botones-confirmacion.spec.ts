// B03 (import-orig-04): cierre del pedido con botones «Confirmar pedido» / «Cambiar algo». Unitarias (ids, limites, marcador, vigencia, extraccion del toque) y
// punta a punta: guion del modelo -> inbound -> outbox -> despachador REAL con el cliente de Graph real contra el simulador de Meta (sin credenciales ni red).
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { FakeWhatsAppGraphClient, MetaGraphWhatsAppClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { MetaCloudSimulator, serveFetchHandler } from "@atiende/whatsapp-gateway/testing";
import { QUOTE_TTL_MS } from "../../src/agent-tools/order-flow.ts";
import { createRestaurantesMessagingOutboxPort } from "../../src/whatsapp/outbox-adapter.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage, recibirMensajeConEspera, responderTrasEspera } from "../../src/whatsapp/inbound.ts";
import { extractMetaInboundMessages } from "../../src/whatsapp/channel-config.ts";
import {
  BOTON_CAMBIAR_TITULO,
  BOTON_CONFIRMAR_TITULO,
  BOTON_ID_MAX,
  BOTON_TITULO_MAX,
  BOTONES_CUERPO_MAX,
  BOTONES_MAX,
  NOTA_TOQUE_CAMBIAR,
  NOTA_TOQUE_CONFIRMAR,
  RESPUESTA_TOQUE_EN_PROCESO,
  RESPUESTA_TOQUE_OBSOLETO,
  RESPUESTA_TOQUE_RETENIDO,
  RESPUESTA_TOQUE_YA_CREADO,
  TEXTO_BOTONES_APARTE,
  VENTANA_SERVICIO_MS,
  cabeEnMensajeInteractivo,
  construirBotonesDeConfirmacion,
  contenidoDeMensajeConToque,
  contenidoParaElModelo,
  dentroDeVentanaDeServicio,
  idDeBoton,
  marcadorDeToque,
  parsearIdDeBoton,
  pareceResumenParaConfirmar,
  quitarMarcadoresDeToque,
  toqueDeMensaje,
  vigenciaDelToque,
} from "../../src/whatsapp/botones-confirmacion.ts";
import { normalizePhone } from "../../src/phone.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

const HASH = "0123456789abcdef0123456789abcdef";
const AT = 1_790_000_000_000;

describe("botones: construccion y limites de la Cloud API", () => {
  it("dos botones con los titulos fijos, <= 20 caracteres, ids unicos y <= 256", () => {
    const botones = construirBotonesDeConfirmacion({ quoteHash: HASH, quotedAtMs: AT });
    expect(botones.map((b) => b.title)).toEqual(["Confirmar pedido", "Cambiar algo"]);
    expect(BOTON_CONFIRMAR_TITULO.length).toBeLessThanOrEqual(BOTON_TITULO_MAX);
    expect(BOTON_CAMBIAR_TITULO.length).toBeLessThanOrEqual(BOTON_TITULO_MAX);
    expect(botones.length).toBeLessThanOrEqual(BOTONES_MAX);
    expect(new Set(botones.map((b) => b.id)).size).toBe(botones.length);
    for (const b of botones) expect(b.id.length).toBeLessThanOrEqual(BOTON_ID_MAX);
  });

  it("el id ida y vuelta conserva accion, huella e instante; el titulo no entra al id", () => {
    const id = idDeBoton({ accion: "confirmar", quoteHash: HASH, quotedAtMs: AT });
    expect(parsearIdDeBoton(id)).toEqual({ accion: "confirmar", quoteHash: HASH, quotedAtMs: AT });
    expect(parsearIdDeBoton(idDeBoton({ accion: "cambiar", quoteHash: HASH, quotedAtMs: AT }))?.accion).toBe("cambiar");
  });

  it("ids mal formados, editados a mano, de otra version o demasiado largos NO se reconocen", () => {
    const id = idDeBoton({ accion: "confirmar", quoteHash: HASH, quotedAtMs: AT });
    const huella = id.split(":")[2]!;
    expect(parsearIdDeBoton(id.replace(huella, "f".repeat(32)))).toBeNull(); // huella editada: la suma no cuadra
    expect(parsearIdDeBoton(id.replace("confirmar", "cambiar"))).toBeNull(); // accion editada
    expect(parsearIdDeBoton(id.replace("rp1", "rp2"))).toBeNull();
    expect(parsearIdDeBoton(`${id}x`)).toBeNull();
    expect(parsearIdDeBoton(`${id}${"a".repeat(300)}`)).toBeNull();
    for (const raro of [undefined, null, 5, "", "btn_0", "cita:confirmar:abc"]) expect(parsearIdDeBoton(raro)).toBeNull();
  });

  it("el cuerpo del interactivo cabe hasta 1024 caracteres; mas, no", () => {
    expect(cabeEnMensajeInteractivo("x".repeat(BOTONES_CUERPO_MAX))).toBe(true);
    expect(cabeEnMensajeInteractivo("x".repeat(BOTONES_CUERPO_MAX + 1))).toBe(false);
    expect(cabeEnMensajeInteractivo("")).toBe(false);
  });

  it("solo un mensaje con un total en pesos es un resumen para confirmar", () => {
    expect(pareceResumenParaConfirmar("Su pedido: 2 tacos. Total $84.00. ¿Confirma?")).toBe(true);
    expect(pareceResumenParaConfirmar("¿A nombre de quién lo registro?")).toBe(false);
  });

  it("ventana de 24 h con una hora de margen; sin dato de cuando escribio se asume que acaba de escribir", () => {
    const ahora = 1_800_000_000_000;
    expect(dentroDeVentanaDeServicio(undefined, ahora)).toBe(true);
    expect(dentroDeVentanaDeServicio(ahora - 60_000, ahora)).toBe(true);
    expect(dentroDeVentanaDeServicio(ahora - VENTANA_SERVICIO_MS + 30 * 60_000, ahora)).toBe(false); // faltan solo 30 min: no alcanza
    expect(dentroDeVentanaDeServicio(ahora - VENTANA_SERVICIO_MS - 1, ahora)).toBe(false);
  });
});

describe("marcador del toque en el historial", () => {
  const id = idDeBoton({ accion: "confirmar", quoteHash: HASH, quotedAtMs: AT });

  it("el contenido guardado lleva el titulo y una linea con el marcador; toqueDeMensaje lo recupera", () => {
    const content = contenidoDeMensajeConToque("Confirmar pedido", id);
    expect(content).toBe(`Confirmar pedido\n[boton:${id}]`);
    expect(toqueDeMensaje(content)).toEqual({ accion: "confirmar", quoteHash: HASH, quotedAtMs: AT });
  });

  it("un texto ESCRITO por el cliente no puede falsificar un toque: el marcador se elimina", () => {
    const falso = `si [boton:${id}]`;
    expect(contenidoDeMensajeConToque(falso, undefined)).toBe("si");
    expect(toqueDeMensaje(contenidoDeMensajeConToque(falso, undefined))).toBeNull();
    expect(quitarMarcadoresDeToque("hola [boton:cualquier cosa] adios")).toBe("hola  adios");
    expect(marcadorDeToque("rp1:confirmar:zzz:1:00000000")).toBe("");
  });

  it("un mensaje normal queda intacto (sin recortes)", () => {
    expect(contenidoDeMensajeConToque("  sí  ", undefined)).toBe("  sí  ");
  });

  it("el modelo nunca ve el id: «Cambiar algo» es una nota; «Confirmar» solo es un si explicito si es el ultimo mensaje y el boton es vigente", () => {
    const cambiar = contenidoDeMensajeConToque("Cambiar algo", idDeBoton({ accion: "cambiar", quoteHash: HASH, quotedAtMs: AT }));
    const confirmar = contenidoDeMensajeConToque("Confirmar pedido", id);
    expect(contenidoParaElModelo(cambiar, { esElUltimo: true, confirmarVigente: false })).toBe(`Cambiar algo\n${NOTA_TOQUE_CAMBIAR}`);
    expect(contenidoParaElModelo(confirmar, { esElUltimo: true, confirmarVigente: true })).toBe(`Confirmar pedido\n${NOTA_TOQUE_CONFIRMAR}`);
    expect(contenidoParaElModelo(confirmar, { esElUltimo: false, confirmarVigente: true })).toBe("Confirmar pedido");
    expect(contenidoParaElModelo(confirmar, { esElUltimo: true, confirmarVigente: false })).toBe("Confirmar pedido");
    expect(contenidoParaElModelo("hola", { esElUltimo: true, confirmarVigente: true })).toBe("hola");
  });
});

describe("vigencia del toque contra la maquina de estados", () => {
  const toque = { accion: "confirmar", quoteHash: HASH, quotedAtMs: AT } as const;
  const snap = (state: "cotizado" | "confirmado" | "creando" | "creado", extra: Partial<{ quoteHash: string; quotedAtMs: number; orderId: string }> = {}) => ({ state, version: 1, context: { quoteHash: HASH, quotedAtMs: AT, quotedTurn: "1", ...extra } });

  it("cotizado o confirmado con la misma huella e instante y dentro de la vigencia: vigente", () => {
    expect(vigenciaDelToque(snap("cotizado"), toque, AT + 60_000)).toBe("vigente");
    expect(vigenciaDelToque(snap("confirmado"), toque, AT + 60_000)).toBe("vigente");
  });
  it("ya creado / creandose: no se duplica", () => {
    expect(vigenciaDelToque(snap("creado", { orderId: "o1" }), toque, AT + 1000)).toBe("ya_creado");
    expect(vigenciaDelToque(snap("creado"), toque, AT + 1000)).toBe("retenido");
    expect(vigenciaDelToque(snap("creando"), toque, AT + 1000)).toBe("en_proceso");
  });
  it("otra huella, otro instante, vencida o sin estado: obsoleto", () => {
    expect(vigenciaDelToque(snap("cotizado", { quoteHash: "f".repeat(32) }), toque, AT + 1000)).toBe("obsoleto");
    expect(vigenciaDelToque(snap("cotizado", { quotedAtMs: AT + 5 }), toque, AT + 1000)).toBe("obsoleto");
    expect(vigenciaDelToque(snap("cotizado"), toque, AT + QUOTE_TTL_MS + 1)).toBe("obsoleto");
    expect(vigenciaDelToque(snap("creado", { quoteHash: "e".repeat(32) }), toque, AT + 1000)).toBe("obsoleto");
    expect(vigenciaDelToque({ state: null, context: null, version: 0 }, toque, AT)).toBe("obsoleto");
  });
  it("base sin maquina de estados: no verificable (se sigue como un «si» escrito)", () => {
    expect(vigenciaDelToque(null, toque, AT)).toBe("no_verificable");
  });
});

describe("extraccion del toque en el webhook", () => {
  const id = idDeBoton({ accion: "confirmar", quoteHash: HASH, quotedAtMs: AT });
  const payload = (reply: { id: string; title: string }, extra: object = {}) => ({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-1" }, messages: [{ id: "wamid.T1", from: "5219990003333", timestamp: "1790000100", type: "interactive", interactive: { type: "button_reply", button_reply: reply }, ...extra }] } }] }],
  });

  it("un boton de resumen conserva su id y cuando lo envio el cliente; el titulo sigue siendo el texto", () => {
    expect(extractMetaInboundMessages(payload({ id, title: "Confirmar pedido" }))).toEqual([{ id: "wamid.T1", from: "5219990003333", body: "Confirmar pedido", botonId: id, recibidoEnMs: 1_790_000_100_000 }]);
  });
  it("cualquier otro boton (de otra funcion, plantillas, ids raros) sigue como antes: solo el titulo", () => {
    expect(extractMetaInboundMessages(payload({ id: "cita:confirmar:abc", title: "Confirmar" }))).toEqual([{ id: "wamid.T1", from: "5219990003333", body: "Confirmar" }]);
    expect(extractMetaInboundMessages(payload({ id: id.replace(HASH, "f".repeat(32)), title: "Confirmar pedido" }))).toEqual([{ id: "wamid.T1", from: "5219990003333", body: "Confirmar pedido" }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Punta a punta
// ---------------------------------------------------------------------------------------------------------------------

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;
const PHONE = "+5219990003333";
const PNID = "pn-t7";

function armar(perfilPm = true) {
  const f = buildRestaurantFixture();
  let cola: LlmCompletionResult[] = [];
  const peticiones: LlmCompletionRequest[] = [];
  const provider = new FakeLlmProvider({
    id: "guion",
    script: (req) => {
      peticiones.push(req);
      return cola.shift() ?? texto("Con gusto.");
    },
  });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
  const turnHandler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  let n = 0;
  const entrar = async (body: string, guion: LlmCompletionResult[], extra: { botonId?: string; recibidoEnMs?: number; deliverReply?: boolean; messageId?: string } = {}) => {
    cola = [...guion];
    n += 1;
    const antes = peticiones.length;
    const outcome = await handleInboundWhatsAppMessage(f.repo, turnHandler, { organizationId: f.organizationId, messageId: extra.messageId ?? `wamid.U${n}`, phone: PHONE, body, phoneNumberId: PNID, ...extra });
    return { outcome, llamadasAlModelo: peticiones.length - antes, ultimaPeticion: peticiones[peticiones.length - 1] };
  };
  const salida = () => f.repo.getOutbox().map((o) => ({ key: o.dedupeKey, ...(o.payload as { body: string; buttons?: { id: string; title: string }[]; solicitar_ubicacion?: boolean }) }));
  const pedidos = async () => {
    const c = await f.repo.findCustomerByPhone(f.organizationId, normalizePhone(PHONE));
    return c ? await f.repo.listEligibleOrderHistory(c.id) : [];
  };
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
  const items2 = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const cotizar = (its = items) => llamada("q", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: its });
  const crear = (its = items) => llamada("c", "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Luis Canul", payment_method: "efectivo", items: its });
  const resumen = texto("Su pedido: 1 Coca-Cola, total $45.00 para recoger. ¿Lo confirma?");
  const preparar = async () => {
    if (perfilPm) await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM as never);
  };
  /** Botones del ultimo mensaje interactivo encolado. */
  const ultimosBotones = () => [...salida()].reverse().find((s) => s.buttons)?.buttons ?? [];
  return { f, turnHandler, setGuion: (g: LlmCompletionResult[]) => { cola = [...g]; }, entrar, salida, pedidos, cotizar, crear, resumen, items, items2, preparar, ultimosBotones, peticiones };
}

const tocar = (botones: readonly { id: string; title: string }[], accion: "confirmar" | "cambiar") => {
  const b = botones.find((x) => parsearIdDeBoton(x.id)?.accion === accion)!;
  return { body: b.title, botonId: b.id };
};

describe("cierre con botones: el resumen sale en UN mensaje interactivo", () => {
  it("tras cotizar sale UN solo mensaje: el texto del resumen + 2 botones, con la llave de idempotencia del mensaje de Meta", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    expect(r.outcome.ok).toBe(true);
    const s = t.salida();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ key: "inbound-reply:wamid.U1", to: PHONE, phone_number_id: PNID, transaccional: true });
    expect(s[0]!.body).toContain("$45.00");
    expect(s[0]!.buttons?.map((b) => b.title)).toEqual(["Confirmar pedido", "Cambiar algo"]);
  });

  it("el reenvio del mismo mensaje de Meta no duplica nada (ni texto ni botones)", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen], { messageId: "wamid.MISMO" });
    const otra = await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen], { messageId: "wamid.MISMO" });
    expect(otra.llamadasAlModelo).toBe(0);
    expect(t.salida()).toHaveLength(1);
  });

  it("una pregunta sin total (¿a nombre de quien?) o un turno sin cotizacion NO llevan botones", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("hola, quiero pedir", [texto("Con gusto, ¿qué desea pedir?")]);
    await t.entrar("una coca para recoger", [t.cotizar(), texto("¿A nombre de quién registro el pedido?")]);
    expect(t.salida().every((s) => !s.buttons)).toBe(true);
  });

  it("el perfil generico (sin PM) y el turno que termina en una escalacion no llevan botones", async () => {
    const g = armar(false);
    await g.entrar("quiero una coca para recoger", [g.cotizar(), g.resumen]);
    expect(g.salida().every((s) => !s.buttons)).toBe(true);
    const e = armar();
    await e.preparar();
    await e.entrar("quiero hablar con una persona", [e.cotizar(), e.resumen]);
    expect(e.salida().every((s) => !s.buttons)).toBe(true);
  });

  it("canal sin entrega a Meta (widget demo / simulador del panel: deliverReply=false): no se encola nada, el texto del resumen queda en la respuesta", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen], { deliverReply: false });
    expect(t.salida()).toHaveLength(0);
    expect(r.outcome.reply).toContain("¿Lo confirma?");
  });

  it("fuera de la ventana de 24 h no se encolan botones: sale el texto de siempre", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen], { recibidoEnMs: Date.now() - VENTANA_SERVICIO_MS - 60_000 });
    const s = t.salida();
    expect(s).toHaveLength(1);
    expect(s[0]!.buttons).toBeUndefined();
    expect(s[0]!.body).toContain("¿Lo confirma?");
  });

  it("dentro de la ventana (mensaje de hace 5 minutos) si lleva botones", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen], { recibidoEnMs: Date.now() - 5 * 60_000 });
    expect(t.salida()[0]!.buttons).toHaveLength(2);
  });

  it("resumen de mas de 1024 caracteres: el texto completo sale como siempre y los botones van aparte con una pregunta corta", async () => {
    const t = armar();
    await t.preparar();
    const largo = `Su pedido: 1 Coca-Cola, total $45.00. ${"Detalle del pedido. ".repeat(60)}¿Lo confirma?`;
    expect(largo.length).toBeGreaterThan(BOTONES_CUERPO_MAX);
    await t.entrar("quiero una coca para recoger", [t.cotizar(), texto(largo)]);
    const s = t.salida();
    expect(s).toHaveLength(2);
    expect(s[0]!.buttons).toBeUndefined();
    expect(s[0]!.body).toContain("Detalle del pedido.");
    expect(s[1]).toMatchObject({ key: "inbound-botones:wamid.U1", body: TEXTO_BOTONES_APARTE });
    expect(s[1]!.buttons).toHaveLength(2);
  });

  it("domicilio sin pin: el resumen con botones convive con la solicitud de ubicacion (cada uno su mensaje y su llave)", async () => {
    const t = armar();
    await t.preparar();
    t.f.repo.seedKnownZone({ id: "zona-va", organizationId: t.f.organizationId, name: "Vista Alegre", lat: 21.0152, lng: -89.5995 });
    t.f.repo.seedBranchDeliveryZones(t.f.propertyId, ["zona-va"]);
    await t.entrar("a domicilio en Vista Alegre", [
      llamada("a", "buscar_sucursal_cercana", { colonia: "Vista Alegre" }),
      llamada("q", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Vista Alegre", items: t.items }),
      texto("Su pedido a domicilio: 1 Coca-Cola, total $45.00 más envío. ¿Lo confirma?"),
    ]);
    const llaves = t.salida().map((s) => s.key);
    expect(llaves).toContain("inbound-reply:wamid.U1");
    expect(llaves).toContain("inbound-ubicacion:wamid.U1");
    expect(t.salida().find((s) => s.key === "inbound-reply:wamid.U1")!.buttons).toHaveLength(2);
  });
});

describe("el toque «Confirmar pedido»", () => {
  it("crea el pedido por el MISMO camino de siempre, con la cotizacion vigente, y el modelo lee un si explicito (nunca el id)", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const toque = tocar(t.ultimosBotones(), "confirmar");
    const r = await t.entrar(toque.body, [llamada("k", "confirmar_resumen", {}), t.crear(), texto("Listo, su pedido ya quedó registrado.")], { botonId: toque.botonId });
    expect(r.outcome.orderId).not.toBeNull();
    expect(await t.pedidos()).toHaveLength(1);
    const vistos = r.ultimaPeticion!.messages.map((m) => m.content).join("\n");
    expect(vistos).toContain(NOTA_TOQUE_CONFIRMAR);
    expect(vistos).not.toContain("rp1:");
    expect(vistos).not.toContain("[boton:");
  });

  it("el «si» escrito sigue funcionando igual que antes", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const r = await t.entrar("sí", [llamada("k", "confirmar_resumen", {}), t.crear(), texto("Listo, su pedido ya quedó registrado.")]);
    expect(r.outcome.orderId).not.toBeNull();
    expect(await t.pedidos()).toHaveLength(1);
  });

  it("no es un atajo: si la regla del servidor rechaza el pedido (minimo a domicilio) el toque NO crea nada y el modelo lo explica", async () => {
    const t = armar();
    await t.preparar();
    t.f.repo.seedBranchPolicy(t.f.propertyId, { pedidoMinimoDomicilio: 500 });
    await t.entrar("una coca a domicilio", [llamada("q", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: t.items }), t.resumen]);
    const toque = tocar(t.ultimosBotones(), "confirmar");
    // el cliente cambio a domicilio despues de confirmar: el servidor exige re-cotizar (huella distinta), no crea
    const r = await t.entrar(toque.body, [llamada("k", "confirmar_resumen", {}), llamada("c", "crear_pedido", { branch_slug: "fco-montejo", canal: "domicilio", customer_address: "Calle 7 #210, Vista Alegre", customer_name: "Luis", payment_method: "efectivo", items: t.items }), texto("Para domicilio necesito cotizar de nuevo; ¿lo prefiere a recoger?")], { botonId: toque.botonId });
    expect(r.outcome.orderId).toBeNull();
    expect(await t.pedidos()).toHaveLength(0);
  });

  it("un segundo toque (el cliente toca dos veces) NO duplica: respuesta fija sin modelo y un solo pedido", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const toque = tocar(t.ultimosBotones(), "confirmar");
    await t.entrar(toque.body, [llamada("k", "confirmar_resumen", {}), t.crear(), texto("Listo, su pedido ya quedó registrado.")], { botonId: toque.botonId });
    const otra = await t.entrar(toque.body, [texto("NO DEBE LLAMARSE")], { botonId: toque.botonId });
    expect(otra.llamadasAlModelo).toBe(0);
    expect(otra.outcome.reply).toBe(RESPUESTA_TOQUE_YA_CREADO);
    expect(await t.pedidos()).toHaveLength(1);
  });

  it("el boton de un resumen VIEJO (el pedido cambio) no crea nada y responde que ya no es el vigente", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const viejo = tocar(t.ultimosBotones(), "confirmar");
    await t.entrar("mejor dos", [t.cotizar(t.items2), texto("Su pedido: 2 Coca-Cola, total $90.00 para recoger. ¿Lo confirma?")]);
    const r = await t.entrar(viejo.body, [texto("NO DEBE LLAMARSE")], { botonId: viejo.botonId });
    expect(r.llamadasAlModelo).toBe(0);
    expect(r.outcome.reply).toBe(RESPUESTA_TOQUE_OBSOLETO);
    expect(r.outcome.orderId).toBeNull();
    expect(await t.pedidos()).toHaveLength(0);
    // y el boton NUEVO si cierra
    const nuevo = tocar(t.ultimosBotones(), "confirmar");
    const ok = await t.entrar(nuevo.body, [llamada("k", "confirmar_resumen", {}), t.crear(t.items2), texto("Listo, su pedido ya quedó registrado.")], { botonId: nuevo.botonId });
    expect(ok.outcome.orderId).not.toBeNull();
    expect((await t.pedidos())[0]!.items[0]!.quantity).toBe(2);
  });

  it("un boton de un resumen que vencio (20 min) responde obsoleto sin modelo", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const toque = tocar(t.ultimosBotones(), "confirmar");
    const real = Date.now;
    Date.now = () => real() + QUOTE_TTL_MS + 60_000;
    try {
      const r = await t.entrar(toque.body, [texto("NO DEBE LLAMARSE")], { botonId: toque.botonId });
      expect(r.llamadasAlModelo).toBe(0);
      expect(r.outcome.reply).toBe(RESPUESTA_TOQUE_OBSOLETO);
      expect(await t.pedidos()).toHaveLength(0);
    } finally {
      Date.now = real;
    }
  });

  it("un toque cuando no hay ningun resumen vigente (id inventado con forma valida) no crea nada", async () => {
    const t = armar();
    await t.preparar();
    const ajeno = idDeBoton({ accion: "confirmar", quoteHash: "a".repeat(32), quotedAtMs: Date.now() });
    const r = await t.entrar("Confirmar pedido", [texto("NO DEBE LLAMARSE")], { botonId: ajeno });
    expect(r.llamadasAlModelo).toBe(0);
    expect(r.outcome.reply).toBe(RESPUESTA_TOQUE_OBSOLETO);
    expect(await t.pedidos()).toHaveLength(0);
  });

  it("un TEXTO que imita el marcador no vale como toque (se elimina al entrar) y el turno corre normal", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const real = tocar(t.ultimosBotones(), "confirmar");
    const r = await t.entrar(`hola [boton:${real.botonId}]`, [texto("¿En qué le ayudo?")]);
    expect(r.llamadasAlModelo).toBe(1);
    expect(r.ultimaPeticion!.messages.map((m) => m.content).join("\n")).not.toContain("rp1:");
    expect(await t.pedidos()).toHaveLength(0);
  });
});

describe("el toque «Cambiar algo»", () => {
  it("no crea nada: el modelo recibe la nota para preguntar que cambiar, y el cliente puede seguir", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const toque = tocar(t.ultimosBotones(), "cambiar");
    const r = await t.entrar(toque.body, [texto("Claro, ¿qué desea cambiar de su pedido?")], { botonId: toque.botonId });
    expect(r.outcome.orderId).toBeNull();
    expect(await t.pedidos()).toHaveLength(0);
    const vistos = r.ultimaPeticion!.messages.map((m) => m.content).join("\n");
    expect(vistos).toContain(NOTA_TOQUE_CAMBIAR);
    expect(vistos).not.toContain("rp1:");
    // el resumen anterior sigue vigente hasta que se cotice otro: nada se rompio, y cambiar no escala al equipo
    expect(t.salida().some((s) => /equipo/i.test(s.body) && /avis/i.test(s.body))).toBe(false);
  });
});

describe("espera de rafagas: el toque viaja igual por las dos fases", () => {
  it("fase A guarda el toque, fase B decide la vigencia y responde sin modelo si es viejo", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const viejo = tocar(t.ultimosBotones(), "confirmar");
    await t.entrar("mejor dos", [t.cotizar(t.items2), texto("Su pedido: 2 Coca-Cola, total $90.00 para recoger. ¿Lo confirma?")]);
    const llamadasAntes = t.peticiones.length;
    const turnHandler = createLlmWhatsAppTurnHandler(t.f.repo, (() => {
      throw new Error("no se usa");
    }) as never, { defaultRole: "default", escalatedRole: "escalated" });
    const rec = await recibirMensajeConEspera(t.f.repo, { organizationId: t.f.organizationId, messageId: "wamid.R1", phone: PHONE, body: viejo.body, botonId: viejo.botonId });
    expect(rec.estado).toBe("responder");
    const out = await responderTrasEspera(t.f.repo, turnHandler, { organizationId: t.f.organizationId, messageId: "wamid.R1", phone: PHONE, phoneNumberId: PNID });
    expect(out.reply).toBe(RESPUESTA_TOQUE_OBSOLETO);
    expect(t.peticiones.length).toBe(llamadasAntes);
    expect(await t.pedidos()).toHaveLength(0);
  });
});

describe("entrega real: despachador + cliente de Graph de produccion contra el simulador de Meta", () => {
  it("el resumen con botones es aceptado por el simulador (1-3 botones, cuerpo) y el toque que Meta devolveria se reconoce y cierra el pedido", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const webhook = await serveFetchHandler(async () => new Response('{"ok":true}', { status: 200 }));
    const sim = new MetaCloudSimulator({ appSecret: "s", accessToken: "tok", phoneNumberId: PNID, webhookUrl: `${webhook.baseUrl}/hook` });
    await sim.start();
    try {
      // el cliente escribio antes: se abrio su ventana de 24 h
      await sim.deliverText(PHONE.replace("+", ""), "quiero una coca para recoger");
      const client = new MetaGraphWhatsAppClient({ accessToken: "tok", baseUrl: sim.baseUrl });
      const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(createRestaurantesMessagingOutboxPort(t.f.repo));
      expect(resumen.sent).toBe(1);
      const aceptado = sim.accepted.at(-1)!;
      expect(aceptado.type).toBe("interactive");
      expect(aceptado.buttons.map((b) => b.title)).toEqual(["Confirmar pedido", "Cambiar algo"]);
      expect(aceptado.text).toContain("$45.00");
      // Meta devuelve el toque como `button_reply` con el id que mandamos
      const confirmar = aceptado.buttons.find((b) => b.title === "Confirmar pedido")!;
      const extraidos = extractMetaInboundMessages({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.TAP", from: PHONE.replace("+", ""), timestamp: String(Math.floor(Date.now() / 1000)), type: "interactive", interactive: { type: "button_reply", button_reply: { id: confirmar.id, title: confirmar.title } } }] } }] }] });
      expect(extraidos).toHaveLength(1);
      const m = extraidos[0]!;
      const r = await t.entrar(m.body, [llamada("k", "confirmar_resumen", {}), t.crear(), texto("Listo, su pedido ya quedó registrado.")], { botonId: m.botonId, ...(m.recibidoEnMs !== undefined ? { recibidoEnMs: m.recibidoEnMs } : {}), messageId: m.id });
      expect(r.outcome.orderId).not.toBeNull();
      expect(await t.pedidos()).toHaveLength(1);
    } finally {
      await sim.stop();
      await webhook.close();
    }
  });

  it("con el cliente de Graph FALSO el despachador envia el interactivo como `botones`", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    const graph = new FakeWhatsAppGraphClient();
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: graph }).dispatchPending(createRestaurantesMessagingOutboxPort(t.f.repo));
    expect(resumen.sent).toBe(1);
    expect(graph.sent[0]!.buttons).toHaveLength(2);
  });
});

describe("respuestas fijas", () => {
  it("hablan de usted y no prometen lo que no hicieron", () => {
    for (const r of [RESPUESTA_TOQUE_OBSOLETO, RESPUESTA_TOQUE_YA_CREADO, RESPUESTA_TOQUE_EN_PROCESO]) {
      expect(r).not.toMatch(/\btú\b|\bquieres\b|\bpuedes\b/i);
    }
    expect(RESPUESTA_TOQUE_OBSOLETO).toMatch(/no lo confirmé/);
  });
});

describe("revision: rafagas con texto + toque, pedido retenido, saneo y notas rancias", () => {
  async function rafaga(t: ReturnType<typeof armar>, mensajes: Array<{ body: string; botonId?: string }>, guion: LlmCompletionResult[]) {
    for (const [i, m] of mensajes.entries()) {
      const r = await recibirMensajeConEspera(t.f.repo, { organizationId: t.f.organizationId, messageId: `wamid.B${i}`, phone: PHONE, body: m.body, ...(m.botonId ? { botonId: m.botonId } : {}) });
      expect(r.estado).toBe(i === 0 ? "responder" : "absorbido");
    }
    t.setGuion(guion);
    const antes = t.peticiones.length;
    const out = await responderTrasEspera(t.f.repo, t.turnHandler, { organizationId: t.f.organizationId, messageId: "wamid.B0", phone: PHONE, phoneNumberId: PNID });
    return { out, vistos: t.peticiones.slice(antes).flatMap((q) => q.messages.map((m) => m.content)).join("\n"), llamadas: t.peticiones.length - antes };
  }
  async function conResumen() {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [t.cotizar(), t.resumen]);
    return { t, confirmar: tocar(t.ultimosBotones(), "confirmar") };
  }

  it("texto que cambia el pedido ANTES del toque: no se inyecta el si; el modelo lee el texto y no se crea el pedido viejo", async () => {
    const { t, confirmar } = await conResumen();
    const r = await rafaga(t, [{ body: "mejor 5 cocas" }, { body: confirmar.body, botonId: confirmar.botonId }], [texto("Entendido, 5 cocas; voy a cotizar de nuevo.")]);
    expect(r.vistos).not.toContain(NOTA_TOQUE_CONFIRMAR);
    expect(r.vistos).toContain("mejor 5 cocas");
    expect(await t.pedidos()).toHaveLength(0);
  });
  it("toque y despues texto: tampoco se inyecta", async () => {
    const { t, confirmar } = await conResumen();
    const r = await rafaga(t, [{ body: confirmar.body, botonId: confirmar.botonId }, { body: "mejor 5 cocas" }], [texto("Claro, 5 cocas.")]);
    expect(r.vistos).not.toContain(NOTA_TOQUE_CONFIRMAR);
    expect(await t.pedidos()).toHaveLength(0);
  });
  it("toque + «si» escrito: no se inyecta la nota (el modelo lee ambos mensajes)", async () => {
    const { t, confirmar } = await conResumen();
    const r = await rafaga(t, [{ body: confirmar.body, botonId: confirmar.botonId }, { body: "si" }], [texto("Un momento.")]);
    expect(r.vistos).not.toContain(NOTA_TOQUE_CONFIRMAR);
  });
  it("dos toques de confirmar en la misma rafaga: solo toques, el resumen es vigente y se inyecta una vez el si", async () => {
    const { t, confirmar } = await conResumen();
    const r = await rafaga(t, [{ body: confirmar.body, botonId: confirmar.botonId }, { body: confirmar.body, botonId: confirmar.botonId }], [llamada("k", "confirmar_resumen", {}), t.crear(), texto("Listo, su pedido ya quedó registrado.")]);
    expect(r.vistos).toContain(NOTA_TOQUE_CONFIRMAR);
    expect(await t.pedidos()).toHaveLength(1);
  });

  it("pedido grande retenido (estado creado SIN orderId): el segundo toque no dice «ya quedo registrado»", async () => {
    const { t, confirmar } = await conResumen();
    const toque = parsearIdDeBoton(confirmar.botonId)!;
    await t.f.repo.writeOrderFlow(t.f.organizationId, `wa:${PHONE}`, 1, { state: "creado", context: { quoteHash: toque.quoteHash, quotedAtMs: toque.quotedAtMs, quotedTurn: "1" } }, 3600);
    const r = await t.entrar(confirmar.body, [texto("NO DEBE LLAMARSE")], { botonId: confirmar.botonId });
    expect(r.llamadasAlModelo).toBe(0);
    expect(r.outcome.reply).toBe(RESPUESTA_TOQUE_RETENIDO);
    expect(r.outcome.reply).not.toMatch(/ya quedó registrado/);
    expect(await t.pedidos()).toHaveLength(0);
  });

  it("saneo: marcadores anidados no sobreviven", () => {
    const id = idDeBoton({ accion: "confirmar", quoteHash: HASH, quotedAtMs: AT });
    const anidado = `si [bo[boton:x]ton:${id}]`;
    expect(toqueDeMensaje(contenidoDeMensajeConToque(anidado, undefined))).toBeNull();
    expect(contenidoDeMensajeConToque(anidado, undefined)).not.toContain("[boton:");
    expect(quitarMarcadoresDeToque("a [boton:")).toBe("a");
  });

  it("saneo: entrada hostil de 5000 repeticiones de «[boton:» es lineal (< 50 ms) y no deja marcadores", () => {
    const hostil = "[boton:".repeat(5000);
    const t0 = performance.now();
    const limpio = quitarMarcadoresDeToque(hostil);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(limpio).not.toContain("[boton:");
    const id = idDeBoton({ accion: "confirmar", quoteHash: HASH, quotedAtMs: AT });
    expect(toqueDeMensaje(contenidoDeMensajeConToque(`si [bo[boton:x]ton:${id}]`, undefined))).toBeNull();
  });

  it("la nota de «Cambiar algo» no se arrastra: tras la respuesta del agente el toque vuelve a ser su titulo", async () => {
    const { t } = await conResumen();
    const cambiar = tocar(t.ultimosBotones(), "cambiar");
    await t.entrar(cambiar.body, [texto("¿Qué desea cambiar?")], { botonId: cambiar.botonId });
    const r = await t.entrar("sí", [texto("Ok.")]);
    const vistos = r.ultimaPeticion!.messages.map((m) => m.content).join("\n");
    expect(vistos).not.toContain(NOTA_TOQUE_CAMBIAR);
    expect(vistos).toContain("Cambiar algo");
  });
});
