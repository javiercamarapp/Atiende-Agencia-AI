// «Probar agente» del panel: chat de prueba SIN efectos. Se afirma el EFECTO: rol sin permiso => 403; otra organizacion => 403/404;
// sin LLM => 503 honesto; un pedido completo por chat deja cero pedidos/clientes/avisos y la conversacion NO se persiste.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

const ok = (text: string, toolCalls?: { id: string; name: string; argumentsJson: string }[]): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0, ...(toolCalls ? { toolCalls } : {}) });

async function construir(opts: { sinLlm?: boolean; script?: (r: LlmCompletionRequest) => LlmCompletionResult } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const categoryId = randomUUID();
  const productId = randomUUID();
  ctx.restaurantesRepo.seedCategory({ id: categoryId, organizationId: ctx.organizationId, name: "Bebidas" });
  ctx.restaurantesRepo.seedProduct({ id: productId, organizationId: ctx.organizationId, categoryId, name: "Coca-Cola", description: null, searchKeywords: [] });
  ctx.restaurantesRepo.seedBranchProduct({ propertyId: ctx.propertyIdA, productId, price: 45, isAvailable: true });

  const prompts: string[] = [];
  const base = { branch_slug: "fco-montejo", items: [{ product_id: productId, product_name: "Coca-Cola", requested_quantity: 2 }], canal: "recoger" };
  const guion = (req: LlmCompletionRequest): LlmCompletionResult => {
    prompts.push(req.system ?? "");
    const ultimo = req.messages.at(-1)!;
    if (ultimo.role === "tool") return ok("Listo.");
    const texto = String((ultimo as { content: string }).content);
    if (texto.includes("cotiza")) return ok("", [{ id: "t1", name: "cotizar_pedido", argumentsJson: JSON.stringify(base) }]);
    if (texto.includes("confirmo")) return ok("", [{ id: "t2", name: "confirmar_resumen", argumentsJson: "{}" }]);
    if (texto.includes("crea")) return ok("", [{ id: "t3", name: "crear_pedido", argumentsJson: JSON.stringify({ ...base, customer_name: "Dueno", payment_method: "efectivo" }) }]);
    return ok("Hola, soy el asistente virtual.");
  };
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "scripted", script: opts.script ?? guion })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "unused" })]);
  const deps: AppDeps = {
    ...ctx.deps,
    ...(opts.sinLlm ? {} : { llmGateway: gateway, turnHandler: createLlmWhatsAppTurnHandler(ctx.restaurantesRepo, gateway, { defaultRole: "default", escalatedRole: "escalated" }) }),
  };
  const app = envolver(buildApp(deps));
  const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/agente-whatsapp/preview/mensaje`;
  const sesionId = randomUUID();
  const enviar = (token: string, mensajes: { rol: string; texto: string }[], extra: Record<string, unknown> = {}, u = url) => app.request(u, authedJson(token, { sesionId, mensajes, ...extra }));
  return { ctx, app, url, enviar, sesionId, prompts, productId };
}

const usuario = (texto: string) => ({ rol: "usuario", texto });
const agente = (texto: string) => ({ rol: "agente", texto });

describe("POST .../admin/agente-whatsapp/preview/mensaje", () => {
  it("un pedido completo por chat devuelve la tarjeta simulada PRUEBA con el total real y NO crea pedidos, clientes, avisos ni conversacion", async () => {
    const t = await construir();
    const owner = t.ctx.staff.owner.token;
    const espiaConversacion = vi.spyOn(t.ctx.restaurantesRepo, "appendWhatsAppUserMessageOnce");
    const espiaLedger = vi.spyOn(t.ctx.restaurantesRepo, "claimWhatsAppMessage");
    const espiaCallback = vi.spyOn(t.ctx.restaurantesRepo, "createCallbackRequest");

    const h1 = [usuario("cotiza dos cocas")];
    const r1 = await t.enviar(owner, h1);
    expect(r1.status).toBe(200);
    const h2 = [...h1, agente((await r1.json()).respuesta), usuario("confirmo")];
    const r2 = await t.enviar(owner, h2);
    const h3 = [...h2, agente((await r2.json()).respuesta), usuario("crea el pedido")];
    const r3 = await (await t.enviar(owner, h3)).json();

    expect(r3.pedidoSimulado.id.startsWith("PRUEBA-")).toBe(true);
    expect(r3.pedidoSimulado.total).toBe(90);
    expect((await t.ctx.restaurantesRepo.listOrders(t.ctx.organizationId, { propertyIds: null, limit: 50 })).orders).toHaveLength(0);
    expect((await t.ctx.restaurantesRepo.listCustomers(t.ctx.organizationId, { limit: 50 })).customers).toHaveLength(0);
    expect(t.ctx.restaurantesRepo.getOutbox()).toHaveLength(0);
    expect(espiaConversacion).not.toHaveBeenCalled();
    expect(espiaLedger).not.toHaveBeenCalled();
    expect(espiaCallback).not.toHaveBeenCalled();
  });

  it("sin proveedor LLM responde 503 honesto 'requiere OPENROUTER_API_KEY' (nunca una respuesta inventada)", async () => {
    const t = await construir({ sinLlm: true });
    const res = await t.enviar(t.ctx.staff.owner.token, [usuario("hola")]);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("agente_no_disponible");
    expect(body.message).toContain("OPENROUTER_API_KEY");
  });

  it("roles y organizacion: staff y repartidor -> 403; owner de otra organizacion -> 403; sin sesion -> 401; admin si puede", async () => {
    const t = await construir();
    for (const token of [t.ctx.staff.staffSucursalA.token, t.ctx.staff.repartidor.token, t.ctx.staff.otroOrgOwner.token]) {
      expect((await t.enviar(token, [usuario("hola")])).status).toBe(403);
    }
    expect((await t.app.request(t.url, { method: "POST", body: JSON.stringify({ sesionId: t.sesionId, mensajes: [usuario("hola")] }) })).status).toBe(401);
    expect((await t.enviar(t.ctx.staff.admin.token, [usuario("hola")])).status).toBe(200);
  });

  it("cliente simulado de OTRA organizacion o inexistente -> 404; uno de la organizacion llega al agente", async () => {
    const t = await construir();
    const ajeno = await t.ctx.restaurantesRepo.upsertCustomer(t.ctx.otherOrganizationId, "9993333333", "Ajeno");
    const propio = await t.ctx.restaurantesRepo.upsertCustomer(t.ctx.organizationId, "9992222222", "Beto");
    const owner = t.ctx.staff.owner.token;
    expect((await t.enviar(owner, [usuario("hola")], { clienteSimuladoId: ajeno.id })).status).toBe(404);
    expect((await t.enviar(owner, [usuario("hola")], { clienteSimuladoId: randomUUID() })).status).toBe(404);
    expect((await t.enviar(owner, [usuario("hola")], { clienteSimuladoId: propio.id })).status).toBe(200);
    expect(t.prompts.at(-1)).toContain("Beto");
  });

  it("el borrador sin guardar se usa para probar y NO se guarda; uno invalido -> 400", async () => {
    const t = await construir();
    const owner = t.ctx.staff.owner.token;
    const borrador = { perfil: "generico", agentName: null, businessName: "Taqueria Borrador", toneStyle: null, deliveryTimeText: null };
    expect((await t.enviar(owner, [usuario("hola")], { borrador })).status).toBe(200);
    expect(t.prompts.at(-1)).toContain("Taqueria Borrador");
    expect(await t.ctx.restaurantesRepo.findWhatsAppAgentConfigExacta(t.ctx.organizationId, null)).toBeNull();
    expect((await t.enviar(owner, [usuario("hola")], { borrador: { perfil: "inventado" } })).status).toBe(400);
  });

  it("validacion del historial: vacio, sin alternar, que no termina en usuario, textos largos y sesionId invalido -> 400", async () => {
    const t = await construir();
    const owner = t.ctx.staff.owner.token;
    for (const mensajes of [[], [agente("hola")], [usuario("a"), usuario("b")], [usuario("hola"), agente("x")], [usuario("x".repeat(1001))], [{ rol: "otro", texto: "x" }]]) {
      expect((await t.enviar(owner, mensajes as never)).status).toBe(400);
    }
    expect((await t.app.request(t.url, authedJson(owner, { sesionId: "no-uuid", mensajes: [usuario("hola")] }))).status).toBe(400);
  });

  it("tope por staff: pasado el limite responde 429 sin llamar al modelo", async () => {
    const t = await construir();
    const owner = t.ctx.staff.owner.token;
    let ultimo = 0;
    for (let i = 0; i < 41; i++) ultimo = (await t.enviar(owner, [usuario("hola")])).status;
    expect(ultimo).toBe(429);
  });
});
