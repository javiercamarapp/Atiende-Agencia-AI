// Integracion #501 (botones «Confirmar pedido» / «Cambiar algo») x #508 (ronda 3 del agente de PM): la huella sobre renglones resueltos, `ya_registrado` / `otro_pedido`,
// `minutos_para_recoger`, la guardia de honestidad del cierre y los textos fijos del toque. Arnes y LLM falso del repo; sin red.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage, recibirMensajeConEspera, responderTrasEspera } from "../../src/whatsapp/inbound.ts";
import { NOTA_TOQUE_CONFIRMAR, RESPUESTA_TOQUE_RETENIDO, RESPUESTA_TOQUE_YA_CREADO, parsearIdDeBoton } from "../../src/whatsapp/botones-confirmacion.ts";
import { normalizePhone } from "../../src/phone.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

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

afterEach(() => vi.useRealTimers());

const quote = (t: ReturnType<typeof armar>, extra: object = {}, its = t.items) => llamada("q", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: its, ...extra });
const confirmarYCrear = (t: ReturnType<typeof armar>, extra: object = {}, its: object[] = t.items) => [llamada("k", "confirmar_resumen", {}), llamada("c", "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Luis Canul", payment_method: "efectivo", items: its, ...extra })];

describe("#501 x #508: el toque con la huella sobre renglones resueltos y minutos_para_recoger", () => {
  it("el id del boton lleva la huella de la cotizacion: la misma cotizacion con renglones escritos distinto (tortilla en una bebida, id vacio) NO invalida el boton", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [quote(t, {}, [{ product_id: t.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1, tortilla: "mixta" }]), t.resumen]);
    const toque = tocar(t.ultimosBotones(), "confirmar");
    // en el turno del toque el modelo escribe el carrito de OTRA forma (id vacio, sin tortilla) y aun asi el pedido se crea con el boton vigente
    const r = await t.entrar(toque.body, [llamada("k0", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: "", product_name: "coca cola", requested_quantity: 1 }] }), llamada("k", "confirmar_resumen", {}), llamada("c", "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Luis Canul", payment_method: "efectivo", items: [{ product_id: "", product_name: "coca", requested_quantity: 1 }] }), texto("Listo, su pedido ya quedó registrado.")], { botonId: toque.botonId });
    expect(r.outcome.orderId).not.toBeNull();
    expect(await t.pedidos()).toHaveLength(1);
  });

  for (const minutos of [false, true]) {
    it(`toque 2 min despues y el modelo re-cotiza el MISMO carrito antes de confirmar: crea el pedido, sin otro resumen ni botones nuevos (minutos_para_recoger=${minutos})`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
      const t = armar();
      await t.preparar();
      t.f.repo.seedBranchPolicy(t.f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "00:00", cierra: "23:59" }] });
      const extra = minutos ? { minutos_para_recoger: 40 } : {};
      await t.entrar("una coca para recoger en 40 minutos", [quote(t, extra), t.resumen]);
      const botonesAntes = t.ultimosBotones();
      const toque = tocar(botonesAntes, "confirmar");
      vi.setSystemTime(new Date("2026-10-06T13:02:00-06:00"));
      const r = await t.entrar(toque.body, [quote(t, extra), ...confirmarYCrear(t, extra), texto("Listo, su pedido ya quedó registrado.")], { botonId: toque.botonId });
      expect(r.outcome.orderId).not.toBeNull();
      expect(await t.pedidos()).toHaveLength(1);
      expect(t.ultimosBotones()).toEqual(botonesAntes); // no salieron botones nuevos: no hubo un segundo resumen
    });
  }
});

describe("#501 x #508: ya_registrado / otro_pedido contra el segundo toque y el «si» escrito", () => {
  async function conPedidoCreado() {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [quote(t), t.resumen]);
    const toque = tocar(t.ultimosBotones(), "confirmar");
    await t.entrar(toque.body, [...confirmarYCrear(t), texto("Listo, su pedido ya quedó registrado.")], { botonId: toque.botonId });
    return { t, toque };
  }

  it("segundo toque tras crear: texto fijo «ya quedo registrado y no se duplico», sin modelo, un solo pedido", async () => {
    const { t, toque } = await conPedidoCreado();
    const otra = await t.entrar(toque.body, [texto("NO DEBE LLAMARSE")], { botonId: toque.botonId });
    expect(otra.llamadasAlModelo).toBe(0);
    expect(otra.outcome.reply).toBe(RESPUESTA_TOQUE_YA_CREADO);
    expect(await t.pedidos()).toHaveLength(1);
  });

  it("«si» escrito tras crear: el modelo re-cotiza, el servidor responde ya_registrado y NO nace otro pedido ni salen botones nuevos", async () => {
    const { t } = await conPedidoCreado();
    const nBotones = t.salida().filter((s) => s.buttons).length;
    const r = await t.entrar("si", [quote(t), texto("Su pedido ya quedó registrado; lo esperamos.")]);
    expect(r.outcome.orderId).toBeNull();
    expect(r.outcome.reply).toContain("ya quedó registrado");
    expect(await t.pedidos()).toHaveLength(1);
    expect(t.salida().filter((s) => s.buttons)).toHaveLength(nBotones);
    const herramientas = r.ultimaPeticion!.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    expect(herramientas).toContain("ya_registrado");
  });

  it("«otro igual» (otro_pedido:true) abre una cotizacion NUEVA con botones nuevos; el boton del pedido anterior queda inservible", async () => {
    const { t, toque } = await conPedidoCreado();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
    await t.entrar("quiero otro igual", [quote(t, { otro_pedido: true }), t.resumen]);
    const nuevo = tocar(t.ultimosBotones(), "confirmar");
    expect(nuevo.botonId).not.toBe(toque.botonId);
    const viejo = await t.entrar(toque.body, [texto("NO DEBE LLAMARSE")], { botonId: toque.botonId });
    expect(viejo.llamadasAlModelo).toBe(0);
    expect(await t.pedidos()).toHaveLength(1);
    const ok = await t.entrar(nuevo.body, [...confirmarYCrear(t, { otro_pedido: true }), texto("Listo, su segundo pedido quedó registrado.")], { botonId: nuevo.botonId });
    expect(ok.outcome.orderId).not.toBeNull();
    expect(await t.pedidos()).toHaveLength(2);
  });

  it("pedido CANCELADO: re-cotizar el mismo carrito ya no es ya_registrado, es una cotizacion normal con botones", async () => {
    const { t } = await conPedidoCreado();
    const orders = (t.f.repo as unknown as { orders: Array<{ status: string }> }).orders;
    orders[0]!.status = "cancelado";
    const r = await t.entrar("ahora quiero una coca para recoger otra vez", [quote(t), t.resumen]);
    expect(r.ultimaPeticion!.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n")).not.toContain("ya_registrado");
    expect(t.ultimosBotones().map((b) => b.title)).toEqual(["Confirmar pedido", "Cambiar algo"]);
  });
});

describe("#501 x #508: pedido grande RETENIDO y la guardia de honestidad", () => {
  async function conRetenido() {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [quote(t), t.resumen]);
    const toque = tocar(t.ultimosBotones(), "confirmar");
    const parsed = parsearIdDeBoton(toque.botonId)!;
    const snap = (await t.f.repo.readOrderFlow(t.f.organizationId, `wa:${PHONE}`))!;
    // lo que deja la retencion de un pedido grande: estado creado SIN orderId
    await t.f.repo.writeOrderFlow(t.f.organizationId, `wa:${PHONE}`, snap.version, { state: "creado", context: { ...snap.context!, claimedAtMs: Date.now() } }, 3600);
    return { t, toque, parsed };
  }
  it("el segundo toque conserva el texto fijo de retenido (la guardia no lo toca: es verdad)", async () => {
    const { t, toque } = await conRetenido();
    const r = await t.entrar(toque.body, [texto("NO DEBE LLAMARSE")], { botonId: toque.botonId });
    expect(r.outcome.reply).toBe(RESPUESTA_TOQUE_RETENIDO);
    expect(r.outcome.reply).toContain("pendiente de que la sucursal lo confirme");
  });
  it("«si» escrito: el servidor NO dice ya_registrado y la afirmacion falsa «ya quedo registrado» del modelo se cambia por el texto de retenido", async () => {
    const { t } = await conRetenido();
    const r = await t.entrar("si", [quote(t), texto("Su pedido ya quedó registrado.")]);
    expect(r.outcome.reply).not.toMatch(/ya qued[oó] registrado/);
    expect(r.outcome.reply).toBe(RESPUESTA_TOQUE_RETENIDO);
    const herramientas = r.ultimaPeticion!.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    expect(herramientas).not.toContain("ya_registrado");
    expect(herramientas).toContain("pedido_retenido");
  });
  it("una respuesta verdadera del modelo sobre el retenido pasa intacta", async () => {
    const { t } = await conRetenido();
    const r = await t.entrar("si", [quote(t), texto("Su pedido está pendiente de que la sucursal lo confirme; ya le avisamos y lo contactarán.")]);
    expect(r.outcome.reply).toContain("pendiente de que la sucursal lo confirme");
  });
});

describe("#508: la guardia de honestidad mira el pedido de ESTE flujo, no toda la conversacion", () => {
  it("SEGUNDO pedido: con un primero ya creado, un turno que cotiza otro y afirma «ya quedo registrado» sin crearlo pierde la afirmacion", async () => {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [quote(t), t.resumen]);
    const toque = tocar(t.ultimosBotones(), "confirmar");
    await t.entrar(toque.body, [...confirmarYCrear(t), texto("Listo, su pedido ya quedó registrado.")], { botonId: toque.botonId });
    const r = await t.entrar("ahora otro pedido aparte: 2 cocas", [quote(t, {}, t.items2), texto("Agregué sus 2 Coca-Cola. Su pedido ya quedó registrado.")]);
    expect(r.outcome.orderId).toBeNull();
    expect(r.outcome.reply).not.toMatch(/ya qued[oó] registrado/);
    expect(await t.pedidos()).toHaveLength(1);
  });
});

describe("#501 x #508: ráfagas, edicion y cancelacion", () => {
  async function rafaga(t: ReturnType<typeof armar>, mensajes: Array<{ body: string; botonId?: string }>, guion: LlmCompletionResult[]) {
    for (const [i, m] of mensajes.entries()) {
      const r = await recibirMensajeConEspera(t.f.repo, { organizationId: t.f.organizationId, messageId: `wamid.R${i}`, phone: PHONE, body: m.body, ...(m.botonId ? { botonId: m.botonId } : {}) });
      expect(r.estado).toBe(i === 0 ? "responder" : "absorbido");
    }
    t.setGuion(guion);
    const antes = t.peticiones.length;
    const out = await responderTrasEspera(t.f.repo, t.turnHandler, { organizationId: t.f.organizationId, messageId: "wamid.R0", phone: PHONE, phoneNumberId: PNID });
    return { out, vistos: t.peticiones.slice(antes).flatMap((q) => q.messages.map((m) => m.content)).join("\n") };
  }
  async function conResumen() {
    const t = armar();
    await t.preparar();
    await t.entrar("quiero una coca para recoger", [quote(t), t.resumen]);
    return { t, confirmar: tocar(t.ultimosBotones(), "confirmar") };
  }

  it("rafaga texto de cancelacion + toque: no se inyecta el «si» y no nace ningun pedido", async () => {
    const { t, confirmar } = await conResumen();
    const r = await rafaga(t, [{ body: "mejor cancela mi pedido" }, { body: confirmar.body, botonId: confirmar.botonId }], [texto("Con gusto, no registro el pedido. ¿Algo más?")]);
    expect(r.vistos).not.toContain(NOTA_TOQUE_CONFIRMAR);
    expect(await t.pedidos()).toHaveLength(0);
  });
  it("toque tras EDITAR el pedido (mejor 2): obsoleto fijo sin modelo; el boton nuevo cierra con 2", async () => {
    const { t, confirmar } = await conResumen();
    await t.entrar("mejor dos", [quote(t, {}, t.items2), texto("Su pedido: 2 Coca-Cola, total $90.00 para recoger. ¿Lo confirma?")]);
    const viejo = await t.entrar(confirmar.body, [texto("NO DEBE LLAMARSE")], { botonId: confirmar.botonId });
    expect(viejo.llamadasAlModelo).toBe(0);
    expect(await t.pedidos()).toHaveLength(0);
    const nuevo = tocar(t.ultimosBotones(), "confirmar");
    const ok = await t.entrar(nuevo.body, [...confirmarYCrear(t, {}, t.items2), texto("Listo, su pedido ya quedó registrado.")], { botonId: nuevo.botonId });
    expect(ok.outcome.orderId).not.toBeNull();
    expect((await t.pedidos())[0]!.items[0]!.quantity).toBe(2);
  });
  it("toque + «si» escrito en la misma rafaga con el pedido ya creado por el toque: un solo pedido", async () => {
    const { t, confirmar } = await conResumen();
    await t.entrar(confirmar.body, [...confirmarYCrear(t), texto("Listo, su pedido ya quedó registrado.")], { botonId: confirmar.botonId });
    const r = await rafaga(t, [{ body: confirmar.body, botonId: confirmar.botonId }, { body: "si" }], [quote(t), texto("Su pedido ya quedó registrado.")]);
    expect(r.out.orderId ?? null).toBeNull();
    expect(await t.pedidos()).toHaveLength(1);
  });
});

describe("#501 x #477: el codigo de compensacion GRACIAS se aplica una sola vez con el toque", () => {
  it("la cotizacion con el 10 % lleva botones; el toque crea el pedido al total con descuento y consume el codigo; el segundo toque no lo vuelve a usar", async () => {
    const t = armar();
    await t.preparar();
    const CODIGO = "GRACIAS-AB12CD34";
    await t.f.repo.createPromotion(t.f.organizationId, { code: CODIGO, name: "Compensacion", type: "percentage", value: 10, maxUses: 1, isActive: true, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() });
    t.f.repo.seedCompensationCode(t.f.organizationId, PHONE, CODIGO);
    await t.entrar("quiero 4 cocas para recoger", [quote(t, {}, [{ product_id: t.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 4 }]), texto("Su pedido: 4 Coca-Cola, total $162.00 con su descuento. ¿Lo confirma?")]);
    const toque = tocar(t.ultimosBotones(), "confirmar");
    const its = [{ product_id: t.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 4 }];
    const r = await t.entrar(toque.body, [...confirmarYCrear(t, {}, its), texto("Listo, su pedido ya quedó registrado.")], { botonId: toque.botonId });
    expect(r.outcome.orderId).not.toBeNull();
    expect((t.f.repo as unknown as { orders: Array<{ total: number }> }).orders[0]!.total).toBe(162);
    expect((await t.f.repo.findPromotionByCode(t.f.organizationId, CODIGO))?.timesUsed).toBe(1);
    const otra = await t.entrar(toque.body, [texto("NO DEBE LLAMARSE")], { botonId: toque.botonId });
    expect(otra.outcome.reply).toBe(RESPUESTA_TOQUE_YA_CREADO);
    expect((await t.f.repo.findPromotionByCode(t.f.organizationId, CODIGO))?.timesUsed).toBe(1);
  });
});
