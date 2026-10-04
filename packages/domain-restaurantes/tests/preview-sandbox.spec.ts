// Modo preview del registro unico de tools: el dueno prueba al agente en el panel SIN efectos. Se afirma el EFECTO
// (cero escrituras de dominio, mismo total que el servidor), no la implementacion. Leccion X48 del original: el modo
// sale del contexto fijado por el servidor, nunca de los argumentos que escribe el modelo.
import { describe, expect, it } from "vitest";
import { FOLIO_PREVIEW_PREFIJO, esTelefonoPreview, invokeAgentTool, telefonoFicticioPreview, type AgentToolContext } from "../src/agent-tools/registry.ts";
import type { RestaurantesRepository } from "../src/repository.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

/** Envuelve el repositorio y cuenta CADA llamada a un metodo de escritura de dominio. Solo `writeOrderFlow` (la maquina
 * de estados por sesion, con TTL, que la preview comparte con el flujo real) queda fuera de la cuenta. */
function conContadorDeEscrituras(repo: RestaurantesRepository) {
  const escrituras: string[] = [];
  const escritura = /^(upsert|create|add|enqueue|insert|register|mark|set|update|delete|record|claim|acknowledge|complete|increment)/;
  const proxy = new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && typeof value === "function") {
        const bound = value.bind(target);
        if (escritura.test(prop) && prop !== "writeOrderFlow") {
          return (...args: unknown[]) => {
            escrituras.push(prop);
            return bound(...args);
          };
        }
        return bound;
      }
      return value;
    },
  });
  return { repo: proxy as RestaurantesRepository, escrituras };
}

function setup(extraCtx: Partial<AgentToolContext> = {}) {
  const f = buildRestaurantFixture();
  const contado = conContadorDeEscrituras(f.repo);
  const phone = telefonoFicticioPreview("sesion-1");
  let turn = 1;
  const ctx = (): AgentToolContext => ({
    organizationId: f.organizationId,
    channel: "whatsapp",
    phone,
    modo: "preview",
    flow: { key: `preview:sesion-1`, turn: String(turn) },
    ...extraCtx,
  });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 3 }];
  const run = (name: string, args: Record<string, unknown>) => invokeAgentTool(contado.repo, ctx(), name, args);
  return { f, run, items, escrituras: contado.escrituras, nextTurn: () => void (turn += 1), phone };
}

async function pedidosYClientes(f: ReturnType<typeof buildRestaurantFixture>) {
  const page = await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 100 });
  const clientes = await f.repo.listCustomers(f.organizationId, { limit: 100 });
  return { pedidos: page.orders.length, clientes: clientes.customers.length, outbox: f.repo.getOutbox().length };
}

describe("modo preview del registro de tools", () => {
  it("cotizar -> confirmar -> crear deja cero filas en orders, customers, outbox y avisos, y devuelve un folio PRUEBA con el total del servidor", async () => {
    const s = setup();
    const antes = await pedidosYClientes(s.f);
    const base = { branch_slug: "fco-montejo", items: s.items, canal: "recoger" };
    const cot = await s.run("cotizar_pedido", base);
    const totalServidor = (cot.raw as { total: number }).total;
    s.nextTurn();
    await s.run("confirmar_resumen", {});
    s.nextTurn();
    const creado = await s.run("crear_pedido", { ...base, customer_name: "Dueno Prueba", payment_method: "efectivo" });

    expect(creado.simulated).toBe(true);
    expect(creado.orderId).toBeNull();
    const orden = (creado.result as { order: { id: string; total: number; status: string; items: unknown[] } }).order;
    expect(orden.id.startsWith(FOLIO_PREVIEW_PREFIJO)).toBe(true);
    expect(orden.status).toBe("simulado");
    expect(orden.total).toBe(totalServidor);
    expect(orden.items.length).toBeGreaterThan(0);

    expect(await pedidosYClientes(s.f)).toEqual(antes);
    expect(s.escrituras).toEqual([]);
    expect(await s.f.repo.findCustomerByPhone(s.f.organizationId, s.phone)).toBeNull();
  });

  it("la preview exige la misma maquina de estados: crear sin cotizar ni confirmar se rechaza", async () => {
    const s = setup();
    await expect(s.run("crear_pedido", { branch_slug: "fco-montejo", items: s.items, canal: "recoger", customer_name: "X", payment_method: "efectivo" })).rejects.toMatchObject({ code: "sin_cotizacion" });
  });

  it("un `modo` (o `modo_prueba`) que escriba el modelo en los argumentos se ignora: en modo real sigue creando, en preview sigue simulando", async () => {
    const real = setup({ modo: "real", phone: "9991234567" });
    const base = { branch_slug: "fco-montejo", items: real.items, canal: "recoger" };
    await real.run("cotizar_pedido", base);
    real.nextTurn();
    await real.run("confirmar_resumen", {});
    real.nextTurn();
    const creadoReal = await real.run("crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo", modo: "preview", modo_prueba: true });
    expect(creadoReal.simulated).toBeUndefined();
    expect(creadoReal.orderId).not.toBeNull();
    expect((await pedidosYClientes(real.f)).pedidos).toBe(1);

    const prev = setup();
    const b2 = { branch_slug: "fco-montejo", items: prev.items, canal: "recoger" };
    await prev.run("cotizar_pedido", { ...b2, modo: "real" });
    prev.nextTurn();
    await prev.run("confirmar_resumen", { modo: "real" });
    prev.nextTurn();
    const creadoPrev = await prev.run("crear_pedido", { ...b2, customer_name: "Ana", payment_method: "efectivo", modo: "real", modo_prueba: false });
    expect(creadoPrev.simulated).toBe(true);
    expect((await pedidosYClientes(prev.f)).pedidos).toBe(0);
  });

  it("buscar_cliente responde cliente nuevo con el telefono ficticio, aunque el modelo mande otro telefono", async () => {
    const s = setup();
    await s.f.repo.upsertCustomer(s.f.organizationId, "9992222222", "Beto");
    const out = await s.run("buscar_cliente", { phone: "9992222222" });
    expect(out.result).toEqual({ isNew: true });
  });

  it("buscar_cliente con `previewCustomerId` resuelve el cliente conocido de la organizacion; uno de otra organizacion da cliente nuevo", async () => {
    const f = buildRestaurantFixture();
    const conocido = await f.repo.upsertCustomer(f.organizationId, "9992222222", "Beto");
    const otra = buildRestaurantFixture();
    const ajeno = await otra.repo.upsertCustomer(otra.organizationId, "9993333333", "Ajeno");
    const ctx = (id: string): AgentToolContext => ({ organizationId: f.organizationId, channel: "whatsapp", phone: telefonoFicticioPreview("s"), modo: "preview", previewCustomerId: id });
    const ok = await invokeAgentTool(f.repo, ctx(conocido.id), "buscar_cliente", {});
    expect((ok.result as { name?: string }).name).toBe("Beto");
    const cruzado = await invokeAgentTool(f.repo, ctx(ajeno.id), "buscar_cliente", {});
    expect(cruzado.result).toEqual({ isNew: true });
  });

  it("escalar_a_humano y registrar_contacto responden exito simulado sin crear aviso", async () => {
    const s = setup();
    const a = await s.run("escalar_a_humano", { customer_name: "Ana", motivo: "queja" });
    const b = await s.run("registrar_contacto", { customer_name: "Ana", reason: "duda" });
    expect(a.result).toMatchObject({ ok: true, simulado: true });
    expect(b.result).toMatchObject({ ok: true, simulado: true });
    expect(s.escrituras).toEqual([]);
  });

  it("el telefono ficticio cae en el rango reservado y es estable por sesion", () => {
    const t = telefonoFicticioPreview("abc");
    expect(esTelefonoPreview(t)).toBe(true);
    expect(telefonoFicticioPreview("abc")).toBe(t);
    expect(esTelefonoPreview("9991234567")).toBe(false);
  });
});

// ── Turno completo del agente de WhatsApp en modo preview (el chat «Probar agente» del panel) ──────────────────────────
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import type { ConversationMessage } from "../src/repository.ts";

function agente(repo: RestaurantesRepository, script: (r: LlmCompletionRequest) => LlmCompletionResult) {
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "scripted", script })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "unused" })]);
  return createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
}

describe("turno del agente de WhatsApp en modo preview", () => {
  const ok = (text: string, toolCalls?: { id: string; name: string; argumentsJson: string }[]): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0, ...(toolCalls ? { toolCalls } : {}) });

  it("cotizar, confirmar y crear a lo largo de tres mensajes devuelve pedidoSimulado y no escribe nada; con modo real el mismo guion SI crea el pedido", async () => {
    for (const modo of ["preview", "real"] as const) {
      const f = buildRestaurantFixture();
      const contado = conContadorDeEscrituras(f.repo);
      const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
      const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
      const handler = agente(contado.repo, (req) => {
        const ultimo = req.messages.at(-1)!;
        if (ultimo.role === "tool") return ok("Listo.");
        const texto = String((ultimo as { content: string }).content);
        if (texto.includes("cotiza")) return ok("", [{ id: "t1", name: "cotizar_pedido", argumentsJson: JSON.stringify(base) }]);
        if (texto.includes("confirmo")) return ok("", [{ id: "t2", name: "confirmar_resumen", argumentsJson: "{}" }]);
        return ok("", [{ id: "t3", name: "crear_pedido", argumentsJson: JSON.stringify({ ...base, customer_name: "Dueno", payment_method: "efectivo" }) }]);
      });
      const historial: ConversationMessage[] = [];
      const phone = telefonoFicticioPreview("s");
      let ultimaRespuesta: Awaited<ReturnType<typeof handler.handleInboundMessage>> | undefined;
      for (const texto of ["cotiza dos cocas", "confirmo", "crea el pedido"]) {
        historial.push({ role: "user", content: texto });
        ultimaRespuesta = await handler.handleInboundMessage({ organizationId: f.organizationId, phone, messages: [...historial], customer: { isNew: true }, ...(modo === "preview" ? { modo } : {}) });
        historial.push({ role: "assistant", content: ultimaRespuesta.reply });
      }
      const pedidos = (await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 50 })).orders.length;
      if (modo === "preview") {
        expect(ultimaRespuesta!.orderId).toBeNull();
        expect((ultimaRespuesta!.pedidoSimulado as { id: string; total: number }).id.startsWith(FOLIO_PREVIEW_PREFIJO)).toBe(true);
        expect((ultimaRespuesta!.pedidoSimulado as { total: number }).total).toBe(90);
        expect(pedidos).toBe(0);
        expect(contado.escrituras).toEqual([]);
      } else {
        expect(ultimaRespuesta!.orderId).not.toBeNull();
        expect(ultimaRespuesta!.pedidoSimulado).toBeUndefined();
        expect(pedidos).toBe(1);
      }
    }
  });

  it("un mensaje de alto riesgo (queja) en preview NO crea aviso real al equipo", async () => {
    const f = buildRestaurantFixture();
    const contado = conContadorDeEscrituras(f.repo);
    const handler = agente(contado.repo, () => ok("hola"));
    const r = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: telefonoFicticioPreview("s"), messages: [{ role: "user", content: "Quiero hablar con una persona, tengo una queja grave" }], customer: { isNew: true }, modo: "preview" });
    expect(r.reply.length).toBeGreaterThan(0);
    expect(contado.escrituras).toEqual([]);
  });

  it("la configuracion en borrador se usa solo en preview: el nombre del negocio aparece en el prompt", async () => {
    const f = buildRestaurantFixture();
    const prompts: string[] = [];
    const handler = agente(f.repo, (req) => (prompts.push(req.system ?? ""), ok("hola")));
    const borrador = { perfil: "generico" as const, agentName: null, businessName: "Taqueria Borrador", toneStyle: null, deliveryTimeText: null, greetingText: null, salsasText: null, promosText: null, escalationReasonsOff: [], largeOrderText: null, replyDebounceSeconds: null };
    const msg = [{ role: "user" as const, content: "hola" }];
    await handler.handleInboundMessage({ organizationId: f.organizationId, phone: "9991111111", messages: msg, customer: { isNew: true }, modo: "preview", configBorrador: borrador });
    await handler.handleInboundMessage({ organizationId: f.organizationId, phone: "9991111111", messages: msg, customer: { isNew: true }, configBorrador: borrador });
    expect(prompts[0]).toContain("Taqueria Borrador");
    expect(prompts[1]).not.toContain("Taqueria Borrador");
  });
});
