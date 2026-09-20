// Fase 2 §2 — test de integración END-TO-END del agente de WhatsApp con LLM
// real (tool-use real, sin mocks de la lógica de negocio): HTTP real
// (POST /v1/restaurantes/whatsapp/webhook, firma HMAC real) -> plomería de
// Fase 1 (dedupe/lease/append, whatsapp/inbound.ts) -> `createLlmWhatsAppTurnHandler`
// (Fase 2) -> `LlmGateway` REAL (@atiende/agent-core) con un `FakeLlmProvider`
// scripteado en el lugar del proveedor de red -> ejecución EN PROCESO de las
// 5 tools contra @atiende/domain-restaurantes real (in-memory) -> pedido real
// creado, cotizado con precios reales, con las mismas guardias anti-
// alucinación que protegen voz. Ningún paso de negocio está mockeado: solo el
// borde de red del LLM (FakeLlmProvider, documentado como determinista, ver
// agent-core/src/gateway/providers/fake-provider.ts) y el repositorio en
// memoria en vez de Postgres real (mismo criterio que el resto de la suite).
import { randomUUID, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, InMemoryCoreRepository, InMemoryAuthzAuditRepository, InMemoryImpersonationRepository, InMemoryLlmUsageRepository, InMemoryResumenDiarioRepository, InMemorySaludRepository, InMemorySuperadminAccionesRepository, InMemoryTenancyEngine } from "@atiende/db";
import {
  InMemoryRestaurantesRepository,
  createLlmWhatsAppTurnHandler,
  type WhatsAppTurnHandler,
} from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } from "@atiende/mcp-cfdi";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, createCalendarSyncPortResolver, RealCalComPort, RealCalDavPort, createGoogleCalendarPortResolver, InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import {
  FakeIcalFeedPort,
  InMemoryBreakGlassAuditRepository,
  InMemoryBreakGlassRentasDataRepository,
  InMemoryBreakGlassSessionRepository,
  InMemoryRentasCalendarStore,
  InMemoryRentasCalendarSyncRepository,
  InMemoryRentasMensajeriaRepository,
  InMemoryRentasOnboardingRepository,
  InMemoryRentasOwnerPortalRepository,
  InMemoryRentasRepository,
  SimuladorCanalMensajeria,
} from "@atiende/domain-rentas";
import { LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

const CUSTOMER_PHONE_E164 = "+5219991230000";
const CUSTOMER_PHONE_WA_ID = "5219991230000"; // Meta manda el wa_id sin "+".

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

function metaPayload(messageId: string, body: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "1234567890" },
              messages: [{ id: messageId, from: CUSTOMER_PHONE_WA_ID, type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

function toolCallTurn(id: string, name: string, args: Record<string, unknown>): LlmCompletionResult {
  return { text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake/scripted", tokensIn: 1, tokensOut: 1, costUsd: 0 };
}

function textTurn(text: string): LlmCompletionResult {
  return { text, model: "fake/scripted", tokensIn: 1, tokensOut: 1, costUsd: 0 };
}

/** Lee el resultado de la ÚLTIMA tool call ejecutada (mensaje `role:'tool'`
 * más reciente del historial efímero) — el script del modelo lo necesita
 * para encadenar tool calls reales con los ids/nombres reales que devolvió
 * la herramienta anterior, exactamente como haría un modelo real leyendo su
 * propio contexto. */
function lastToolResult(request: LlmCompletionRequest): unknown {
  const msg = [...request.messages].reverse().find((m) => m.role === "tool");
  if (!msg || msg.role !== "tool") throw new Error("se esperaba un mensaje tool previo");
  return JSON.parse(msg.content);
}

// Shapes mínimos del contenido real que devuelve cada tool (JSON.stringify
// del `result` que arma executeToolCall en llm-turn-handler.ts) — solo lo que
// este script necesita leer para encadenar la siguiente tool call real.
interface NearestBranchToolResult {
  readonly encontrada: boolean;
  readonly branch_slug?: string;
}
interface ProductToolResultItem {
  readonly id: string;
  readonly name: string;
  readonly pack_size: number | null;
}
interface QuoteToolResult {
  readonly quote: { readonly total: number; readonly lines: ReadonlyArray<{ readonly quantity: number }> };
}
interface OrderToolResult {
  readonly order: { readonly status: string; readonly total: number };
}

async function buildLlmAgentTestDeps(script: (request: LlmCompletionRequest) => LlmCompletionResult): Promise<{ deps: AppDeps; restaurantesRepo: InMemoryRestaurantesRepository; organizationId: string; propertyId: string; tacosBistecId: string }> {
  const coreRepo = new InMemoryCoreRepository();
  const restaurantesRepo = new InMemoryRestaurantesRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  restaurantesRepo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  restaurantesRepo.seedBranch({
    propertyId,
    organizationId,
    name: "Altabrisa",
    slug: "altabrisa",
    status: "active",
    phone: "+529990000000",
    address: "Plaza Victory Altabrisa, Mérida",
    lat: 21.0619,
    lng: -89.6216,
  });
  // Misma zona exacta que la sucursal (distancia 0) — el test ejercita el
  // matching real de known_zone + Haversine real, no un valor fijo.
  restaurantesRepo.seedKnownZone({ organizationId, name: "Altabrisa", lat: 21.0619, lng: -89.6216 });

  const catTacos = randomUUID();
  restaurantesRepo.seedCategory({ id: catTacos, organizationId, name: "Tacos" });
  const tacosBistecId = randomUUID();
  restaurantesRepo.seedProduct({
    id: tacosBistecId,
    organizationId,
    categoryId: catTacos,
    name: "Tacos de Bistec de Res (orden de 3)",
    description: "Orden de 3 tacos de bistec",
    searchKeywords: [],
  });
  restaurantesRepo.seedBranchProduct({ propertyId, productId: tacosBistecId, price: 164, isAvailable: true });

  restaurantesRepo.seedWhatsAppChannel(organizationId, "1234567890");

  const ownerId = randomUUID();
  coreRepo.addStaff({
    id: ownerId,
    email: "dueño@lostaquitos.mx",
    fullName: "Dueño",
    passwordHash: await hashPassword("correcto-caballo-batería"),
    createdVia: "seed",
    emailVerifiedAt: new Date().toISOString(),
  });
  coreRepo.addOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM", vertical: "restaurantes" });
  coreRepo.addMembership({ userId: ownerId, organizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });

  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  const scriptedProvider = new FakeLlmProvider({ id: "scripted", script });
  gateway.registerLadder("whatsapp-agent-default", [scriptedProvider]);
  // Nunca debería llamarse en el flujo feliz de este test — registrado solo
  // porque createLlmWhatsAppTurnHandler exige que el rol exista.
  gateway.registerLadder("whatsapp-agent-escalated", [new FakeLlmProvider({ id: "escalated-unused" })]);

  const turnHandler: WhatsAppTurnHandler = createLlmWhatsAppTurnHandler(restaurantesRepo, gateway, {
    defaultRole: "whatsapp-agent-default",
    escalatedRole: "whatsapp-agent-escalated",
  });

  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    coreStaffRepo: (_db) => coreRepo,
    engine: new InMemoryTenancyEngine(),
    restaurantesRepo: (_db) => restaurantesRepo,
    turnHandler,
    hotelesRepo: (_db) => new InMemoryHotelesRepository(),
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    hotelesTurnHandler: hotelesAcknowledgeOnlyTurnHandler(new InMemoryHotelesRepository()),
    citasRepo: (_db) => new InMemoryCitasRepository(),
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(new InMemoryCitasRepository(), null),
    citasCalendarSyncPortResolver: createCalendarSyncPortResolver(new InMemoryCitasRepository(), null),
    citasCalComPortFactory: (cfg) => new RealCalComPort(cfg),
    citasCalDavPortFactory: (cfg) => new RealCalDavPort(cfg),
    citasGoogleTokenExchange: async () => {
      throw new Error("citasGoogleTokenExchange no está configurado en este fixture (agente de WhatsApp de restaurantes).");
    },
    citasCaldavUrlValidator: async () => {
      throw new Error("citasCaldavUrlValidator no está configurado en este fixture (agente de WhatsApp de restaurantes).");
    },
    licitacionesRepo: (_db) => new InMemoryLicitacionesRepository(),
    despachosRepo: (_db) => new InMemoryDespachosRepository(),
    despachosAuditSink: new InMemoryAuditSink(),
    hotelesCfdiPort: new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
    hotelesFraudeAuditSink: new InMemoryAuditSink(),
    rentasRepo: (_db) => new InMemoryRentasRepository(),
    rentasOwnerPortalRepo: (_db) => new InMemoryRentasOwnerPortalRepository(),
    rentasOnboardingRepo: (_db) => new InMemoryRentasOnboardingRepository(),
    rentasCalendarSyncRepo: (_db) => new InMemoryRentasCalendarSyncRepository(new InMemoryRentasCalendarStore()),
    rentasMensajeriaRepo: (_db) => new InMemoryRentasMensajeriaRepository(),
    rentasCanalMensajeria: (canal) => new SimuladorCanalMensajeria(canal),
    rentasIcalFeedPort: new FakeIcalFeedPort(),
    rentasBreakGlassSessionRepo: (_db) => new InMemoryBreakGlassSessionRepository(),
    rentasBreakGlassAuditRepo: (_db) => new InMemoryBreakGlassAuditRepository(),
    rentasBreakGlassDataRepo: (_db) => new InMemoryBreakGlassRentasDataRepository(new Map()),
    // Bloque C -- impersonación de superadmin con bitácora: campo requerido de
    // AppDeps que este fixture (independiente del de fixtures.ts) todavía no
    // tenía cableado -- instancia en memoria vacía, nada de esta suite ejercita
    // impersonación.
    impersonationRepo: (_db) => new InMemoryImpersonationRepository(),
    authzAuditSink: new InMemoryAuditSink(),
    authzAuditRepo: (_db) => new InMemoryAuthzAuditRepository(),
    llmGateway: undefined,
    llmUsageRepo: new InMemoryLlmUsageRepository(),
      saludRepo: new InMemorySaludRepository(),
      resumenDiarioRepo: new InMemoryResumenDiarioRepository(),
      accionesRepo: new InMemorySuperadminAccionesRepository(),
      resumenDiarioLlmGateway: undefined,
  };
  return { deps, restaurantesRepo, organizationId, propertyId, tacosBistecId };
}

describe("Agente de WhatsApp con LLM real — end-to-end vía el webhook HTTP real", () => {
  it("colonia -> sucursal real -> producto real -> cotización real -> PEDIDO REAL creado, en dos mensajes reales de WhatsApp", async () => {
    let step = 0;
    const { deps, restaurantesRepo, propertyId, tacosBistecId } = await buildLlmAgentTestDeps((request) => {
      const current = step++;
      switch (current) {
        case 0:
          // Primer mensaje del cliente -> el modelo pide la sucursal real más
          // cercana, NUNCA decide "a ojo" (guardia real, nearest-branch.ts).
          return toolCallTurn("call_1", "buscar_sucursal_cercana", { colonia: "Altabrisa" });
        case 1: {
          const nearest = lastToolResult(request) as NearestBranchToolResult;
          expect(nearest.encontrada).toBe(true);
          expect(nearest.branch_slug).toBe("altabrisa");
          return toolCallTurn("call_2", "buscar_producto", { query: "bistec", branch_slug: nearest.branch_slug });
        }
        case 2: {
          const productos = lastToolResult(request) as ProductToolResultItem[];
          expect(productos).toHaveLength(1);
          expect(productos[0]!.id).toBe(tacosBistecId);
          expect(productos[0]!.pack_size).toBe(3);
          return toolCallTurn("call_3", "cotizar_pedido", {
            branch_slug: "altabrisa",
            items: [{ product_id: productos[0]!.id, product_name: productos[0]!.name, requested_quantity: 3, tortilla: "maiz" }],
          });
        }
        case 3: {
          const quoted = lastToolResult(request) as QuoteToolResult;
          // GUARDIA REAL: el total SIEMPRE lo calcula el servidor — 1 orden de
          // 3 tacos de bistec a $164, nunca 3x164.
          expect(quoted.quote.total).toBe(164);
          expect(quoted.quote.lines[0]!.quantity).toBe(1); // 3 piezas = 1 "orden" (packSize 3)
          // Fin del PRIMER mensaje: el agente responde con el total real y
          // pregunta forma de pago, sin llamar más tools todavía.
          return textTurn(`Tu pedido es 1 orden de tacos de bistec (3 piezas) por $${quoted.quote.total}. ¿Pagas con efectivo o tarjeta?`);
        }
        case 4:
          // SEGUNDO mensaje del cliente ("efectivo, soy Fulano..."): el
          // historial persistido es solo TEXTO (diseño §2.5) — el agente
          // vuelve a llamar buscar_producto para recuperar el product_id
          // exacto, costo aceptado y documentado del diseño.
          return toolCallTurn("call_4", "buscar_producto", { query: "bistec", branch_slug: "altabrisa" });
        case 5: {
          const productos = lastToolResult(request) as ProductToolResultItem[];
          return toolCallTurn("call_5", "crear_pedido", {
            branch_slug: "altabrisa",
            customer_name: "Cliente E2E",
            customer_address: "Calle 10 #200, Altabrisa",
            items: [{ product_id: productos[0]!.id, product_name: productos[0]!.name, requested_quantity: 3, tortilla: "maiz" }],
            payment_method: "efectivo",
          });
        }
        case 6: {
          const created = lastToolResult(request) as OrderToolResult;
          expect(created.order.status).toBe("pending");
          expect(created.order.total).toBe(164);
          return textTurn("¡Listo! Tu pedido ya quedó registrado y se mandó a cocina.");
        }
        default:
          throw new Error(`script agotado en el paso ${current}`);
      }
    });
    const app = buildApp(deps);

    // ── Mensaje 1: HTTP real, firma HMAC real, plomería real de Fase 1 ──
    const res1 = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload("wamid.e2e-1", "Hola, quiero pedir para la colonia Altabrisa: tacos de bistec")));
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ ok: true });

    // ── Mensaje 2: confirma pago — debe crear el pedido real ──
    const res2 = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload("wamid.e2e-2", "Con efectivo, soy Cliente E2E, mi dirección es Calle 10 #200, Altabrisa")));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true });

    // ── El pedido es REAL: existe en el repositorio, con precio server-side ──
    const org = (await restaurantesRepo.findOrganizationBySlug("los-taquitos-de-pm"))!;
    const customerPhoneNormalized = CUSTOMER_PHONE_E164.replace(/\D/g, "").slice(-10);
    const customer = await restaurantesRepo.findCustomerByPhone(org.id, customerPhoneNormalized);
    expect(customer).not.toBeNull();
    const orders = await restaurantesRepo.listEligibleOrderHistory(customer!.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.items).toEqual([expect.objectContaining({ name: "Tacos de Bistec de Res (orden de 3)", quantity: 1, price: 164 })]);

    // ── El historial de conversación persistido es SOLO TEXTO (diseño §2.5)
    // — nunca se filtran tool_calls/resultados crudos a la fila persistida. ──
    const conversationProbe = await restaurantesRepo.appendWhatsAppUserMessageOnce(org.id, CUSTOMER_PHONE_E164, { role: "user", content: "probe" });
    // 2 turnos reales (user+assistant) x2 mensajes + esta "probe" = 5.
    expect(conversationProbe).toHaveLength(5);
    for (const message of conversationProbe) {
      expect(message).toHaveProperty("role");
      expect(message).toHaveProperty("content");
      expect(typeof message.content).toBe("string");
      expect(Object.keys(message)).toEqual(["role", "content"]); // nunca toolCalls/toolCallId aquí.
    }

    void propertyId;
  });

  it("si crear_pedido falla, el turno siguiente escala al modelo caro (whatsapp-agent-escalated) — nunca reintenta en silencio en el mismo modelo barato", async () => {
    let step = 0;
    const defaultCalls: string[] = [];
    const escalatedCalls: string[] = [];

    const coreRepo = new InMemoryCoreRepository();
    const restaurantesRepo = new InMemoryRestaurantesRepository();
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    restaurantesRepo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
    restaurantesRepo.seedBranch({ propertyId, organizationId, name: "Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: null, lng: null });
    restaurantesRepo.seedWhatsAppChannel(organizationId, "1234567890");
    coreRepo.addOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM", vertical: "restaurantes" });

    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
    });
    const defaultProvider = new FakeLlmProvider({
      id: "default",
      script: () => {
        defaultCalls.push("default");
        const current = step++;
        if (current === 0) {
          // product_id inexistente -> crear_pedido responde con error real
          // (rechazo anti-alucinación, product-search.ts) -> huboFalloDeHerramienta.
          return toolCallTurn("call_1", "crear_pedido", {
            branch_slug: "altabrisa",
            customer_name: "X",
            customer_address: "Calle 1",
            items: [{ product_id: "00000000-0000-4000-8000-000000000000", product_name: "Producto Fantasma", requested_quantity: 1 }],
            payment_method: "efectivo",
          });
        }
        throw new Error("el rol default no debería volver a llamarse tras el fallo de crear_pedido");
      },
    });
    const escalatedProvider = new FakeLlmProvider({
      id: "escalated",
      script: (request) => {
        escalatedCalls.push("escalated");
        const failed = lastToolResult(request) as { error: string };
        expect(failed.error).toMatch(/no disponible/i);
        return textTurn("Se me complicó ese producto, ¿puedes confirmarlo de nuevo?");
      },
    });
    gateway.registerLadder("whatsapp-agent-default", [defaultProvider]);
    gateway.registerLadder("whatsapp-agent-escalated", [escalatedProvider]);

    const turnHandler = createLlmWhatsAppTurnHandler(restaurantesRepo, gateway, { defaultRole: "whatsapp-agent-default", escalatedRole: "whatsapp-agent-escalated" });
    const deps: AppDeps = {
      env: TEST_ENV,
      coreRepo,
      coreStaffRepo: (_db) => coreRepo,
      engine: new InMemoryTenancyEngine(),
      restaurantesRepo: (_db) => restaurantesRepo,
      turnHandler,
      hotelesRepo: (_db) => new InMemoryHotelesRepository(),
      hotelesPaymentsPort: new InMemoryPaymentsPort(),
      hotelesTurnHandler: hotelesAcknowledgeOnlyTurnHandler(new InMemoryHotelesRepository()),
      citasRepo: (_db) => new InMemoryCitasRepository(),
      citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
      citasConversationGuard: createDefaultConversationGuard(),
      citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(new InMemoryCitasRepository(), null),
      citasCalendarSyncPortResolver: createCalendarSyncPortResolver(new InMemoryCitasRepository(), null),
      citasCalComPortFactory: (cfg) => new RealCalComPort(cfg),
      citasCalDavPortFactory: (cfg) => new RealCalDavPort(cfg),
      citasGoogleTokenExchange: async () => {
        throw new Error("citasGoogleTokenExchange no está configurado en este fixture (agente de WhatsApp de restaurantes).");
      },
      citasCaldavUrlValidator: async () => {
        throw new Error("citasCaldavUrlValidator no está configurado en este fixture (agente de WhatsApp de restaurantes).");
      },
      licitacionesRepo: (_db) => new InMemoryLicitacionesRepository(),
      despachosRepo: (_db) => new InMemoryDespachosRepository(),
      despachosAuditSink: new InMemoryAuditSink(),
      hotelesCfdiPort: new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
      hotelesFraudeAuditSink: new InMemoryAuditSink(),
      rentasRepo: (_db) => new InMemoryRentasRepository(),
      rentasOwnerPortalRepo: (_db) => new InMemoryRentasOwnerPortalRepository(),
      rentasOnboardingRepo: (_db) => new InMemoryRentasOnboardingRepository(),
      rentasCalendarSyncRepo: (_db) => new InMemoryRentasCalendarSyncRepository(new InMemoryRentasCalendarStore()),
      rentasMensajeriaRepo: (_db) => new InMemoryRentasMensajeriaRepository(),
      rentasCanalMensajeria: (canal) => new SimuladorCanalMensajeria(canal),
      rentasIcalFeedPort: new FakeIcalFeedPort(),
    rentasBreakGlassSessionRepo: (_db) => new InMemoryBreakGlassSessionRepository(),
    rentasBreakGlassAuditRepo: (_db) => new InMemoryBreakGlassAuditRepository(),
    rentasBreakGlassDataRepo: (_db) => new InMemoryBreakGlassRentasDataRepository(new Map()),
    // Bloque C -- impersonación de superadmin con bitácora: campo requerido de
    // AppDeps que este fixture (independiente del de fixtures.ts) todavía no
    // tenía cableado -- instancia en memoria vacía, nada de esta suite ejercita
    // impersonación.
    impersonationRepo: (_db) => new InMemoryImpersonationRepository(),
    authzAuditSink: new InMemoryAuditSink(),
    authzAuditRepo: (_db) => new InMemoryAuthzAuditRepository(),
      llmGateway: undefined,
      llmUsageRepo: new InMemoryLlmUsageRepository(),
      saludRepo: new InMemorySaludRepository(),
      resumenDiarioRepo: new InMemoryResumenDiarioRepository(),
      accionesRepo: new InMemorySuperadminAccionesRepository(),
      resumenDiarioLlmGateway: undefined,
    };
    const app = buildApp(deps);

    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload("wamid.escalada-1", "Quiero un producto que no existe")));
    expect(res.status).toBe(200);
    expect(defaultCalls).toHaveLength(1);
    expect(escalatedCalls).toHaveLength(1);
  });
});
