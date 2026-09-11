// Fase 2 hoteles §2 — test de integración END-TO-END del agente de WhatsApp con LLM
// real (tool-use real, sin mocks de la lógica de negocio): HTTP real
// (POST /v1/hoteles/whatsapp/webhook, firma HMAC real) -> plomería
// (dedupe/lease/append, domain-hoteles/whatsapp/inbound.ts) ->
// `createLlmHotelesWhatsAppTurnHandler` -> `LlmGateway` REAL (@atiende/agent-core)
// con un `FakeLlmProvider` scripteado en el lugar del proveedor de red -> ejecución
// EN PROCESO de las 2 tools contra @atiende/domain-hoteles real (in-memory) ->
// ticket de F&B real creado, con la MISMA guardia de alergias (REQ-AB-004) que
// protege el canal de staff y el de voz. Ningún paso de negocio está mockeado: solo
// el borde de red del LLM (FakeLlmProvider) y el repositorio en memoria en vez de
// Postgres real — mismo patrón que apps/api/tests/whatsapp-llm-agent.spec.ts de
// restaurantes.
import { randomUUID, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, createLlmHotelesWhatsAppTurnHandler } from "@atiende/domain-hoteles";
import type { HotelesWhatsAppTurnHandler } from "@atiende/domain-hoteles";
import { InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { InMemoryRentasRepository } from "@atiende/domain-rentas";
import { LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

const GUEST_PHONE_WA_ID = "5219991230000"; // Meta manda el wa_id sin "+".

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
              metadata: { phone_number_id: "9876543210" },
              messages: [{ id: messageId, from: GUEST_PHONE_WA_ID, type: "text", text: { body } }],
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

function lastToolResult(request: LlmCompletionRequest): unknown {
  const msg = [...request.messages].reverse().find((m) => m.role === "tool");
  if (!msg || msg.role !== "tool") throw new Error("se esperaba un mensaje tool previo");
  return JSON.parse(msg.content);
}

interface TicketToolResult {
  readonly ticket: { readonly id: string; readonly alergia_declarada: boolean; readonly mensaje_seguridad: string };
}

async function buildLlmAgentTestDeps(script: (request: LlmCompletionRequest) => LlmCompletionResult): Promise<{ deps: AppDeps; organizationId: string; propertyId: string }> {
  const coreRepo = new InMemoryCoreRepository();
  const hotelesRepo = new InMemoryHotelesRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  hotelesRepo.seedWhatsAppChannel(propertyId, organizationId, "9876543210");

  const ownerId = randomUUID();
  coreRepo.addStaff({
    id: ownerId,
    email: "gerente@hotel-e2e.mx",
    fullName: "Gerente",
    passwordHash: await hashPassword("correcto-caballo-batería"),
    createdVia: "seed",
    emailVerifiedAt: new Date().toISOString(),
  });
  coreRepo.addOrganization({ id: organizationId, slug: "hotel-e2e", name: "Hotel E2E", vertical: "hoteles" });
  coreRepo.addMembership({ userId: ownerId, organizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });

  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  const scriptedProvider = new FakeLlmProvider({ id: "scripted", script });
  gateway.registerLadder("hoteles-whatsapp-default", [scriptedProvider]);
  // Nunca debería llamarse en el flujo feliz de este test — registrado solo porque
  // createLlmHotelesWhatsAppTurnHandler exige que el rol exista.
  gateway.registerLadder("hoteles-whatsapp-escalated", [new FakeLlmProvider({ id: "escalated-unused" })]);

  const hotelesTurnHandler: HotelesWhatsAppTurnHandler = createLlmHotelesWhatsAppTurnHandler(hotelesRepo, gateway, {
    defaultRole: "hoteles-whatsapp-default",
    escalatedRole: "hoteles-whatsapp-escalated",
  });

  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    engine: new InMemoryTenancyEngine(),
    restaurantesRepo: new InMemoryRestaurantesRepository(),
    turnHandler: acknowledgeOnlyTurnHandler(new InMemoryRestaurantesRepository()),
    hotelesRepo,
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    hotelesTurnHandler,
    citasRepo: new InMemoryCitasRepository(),
    licitacionesRepo: new InMemoryLicitacionesRepository(),
    despachosRepo: new InMemoryDespachosRepository(),
    despachosAuditSink: new InMemoryAuditSink(),
    rentasRepo: new InMemoryRentasRepository(),
  };
  return { deps, organizationId, propertyId };
}

describe("Agente de WhatsApp con LLM real de hoteles — end-to-end vía el webhook HTTP real", () => {
  it("mensaje real de room service con alergia declarada -> TICKET REAL creado, marcado, sin afirmar seguridad (REQ-AB-004 de punta a punta)", async () => {
    const { deps, propertyId } = await buildLlmAgentTestDeps((request) => {
      if (request.messages.filter((m) => m.role === "tool").length === 0) {
        // Primer y único turno: el modelo registra el pedido con la alergia
        // declarada tal cual la mencionó el huésped.
        return toolCallTurn("call_1", "crear_ticket_huesped_fnb", {
          mensaje: "Quiero un club sandwich, soy alérgico a los mariscos",
          habitacion: "410",
          alergia_declarada: true,
        });
      }
      const ticket = lastToolResult(request) as TicketToolResult;
      expect(ticket.ticket.alergia_declarada).toBe(true);
      // GUARDIA REAL de punta a punta: el resultado que el LLM lee de la propia
      // tool NUNCA dice "es seguro" — solo puede repetir lo que la tool devolvió.
      expect(ticket.ticket.mensaje_seguridad).not.toMatch(/es seguro/i);
      return textTurn("¡Listo! Registramos tu pedido y avisamos a cocina de tu alergia antes de prepararlo.");
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/hoteles/whatsapp/webhook", signedPostInit(metaPayload("wamid.hotel-e2e-1", "Quiero un club sandwich a la 410, soy alérgico a los mariscos")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // El ticket es REAL: existe en el repositorio, marcado con alergia, SIN
    // confirmación humana de cocina ni "seguridad asegurada" — eso solo lo puede
    // hacer un cocinero por el canal de staff ya construido (pedidosFnb.ts).
    const orders = await deps.hotelesRepo.listFnbOrders(propertyId);
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order.allergyDeclared).toBe(true);
    expect(order.kitchenConfirmedBy).toBeNull();
    expect(order.safetyAssuranceSentAt).toBeNull();
    expect(order.createdBy).toBeNull(); // actor system:whatsapp, sin staff humano logueado.
    expect(order.items).toEqual([{ nombre: "Quiero un club sandwich, soy alérgico a los mariscos" }]);

    // El historial de conversación persistido es SOLO TEXTO (mismo diseño §2.5 que
    // restaurantes) — nunca se filtran tool_calls/resultados crudos a la fila.
    const conversationProbe = await deps.hotelesRepo.appendWhatsAppUserMessageOnce(propertyId, "+5219991230000", { role: "user", content: "probe" });
    expect(conversationProbe).toHaveLength(3); // user + assistant del turno real, + esta "probe".
    for (const message of conversationProbe) {
      expect(Object.keys(message)).toEqual(["role", "content"]);
    }
  });

  it("un mensaje que no es de F&B nunca crea un ticket — se deriva a registrar_contacto_no_operativo", async () => {
    const { deps, propertyId } = await buildLlmAgentTestDeps((request) => {
      if (request.messages.filter((m) => m.role === "tool").length === 0) {
        return toolCallTurn("call_1", "registrar_contacto_no_operativo", { motivo: "factura", resumen: "Pide factura del hospedaje de anoche" });
      }
      return textTurn("Alguien de recepción te va a contactar para tu factura.");
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/hoteles/whatsapp/webhook", signedPostInit(metaPayload("wamid.hotel-e2e-2", "Necesito mi factura de anoche")));
    expect(res.status).toBe(200);

    const orders = await deps.hotelesRepo.listFnbOrders(propertyId);
    expect(orders).toHaveLength(0);
  });

  it("si crear_ticket_huesped_fnb falla (mensaje vacío), el turno siguiente escala al modelo caro — nunca reintenta en silencio en el mismo modelo barato", async () => {
    let step = 0;
    const defaultCalls: string[] = [];
    const escalatedCalls: string[] = [];

    const coreRepo = new InMemoryCoreRepository();
    const hotelesRepo = new InMemoryHotelesRepository();
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    hotelesRepo.seedWhatsAppChannel(propertyId, organizationId, "9876543210");
    coreRepo.addOrganization({ id: organizationId, slug: "hotel-e2e-escalada", name: "Hotel E2E Escalada", vertical: "hoteles" });

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
          return toolCallTurn("call_1", "crear_ticket_huesped_fnb", { mensaje: "" });
        }
        throw new Error("el rol default no debería volver a llamarse tras el fallo de la herramienta");
      },
    });
    const escalatedProvider = new FakeLlmProvider({
      id: "escalated",
      script: () => {
        escalatedCalls.push("escalated");
        return textTurn("¿Me puedes repetir qué se te antoja?");
      },
    });
    gateway.registerLadder("hoteles-whatsapp-default", [defaultProvider]);
    gateway.registerLadder("hoteles-whatsapp-escalated", [escalatedProvider]);

    const hotelesTurnHandler = createLlmHotelesWhatsAppTurnHandler(hotelesRepo, gateway, { defaultRole: "hoteles-whatsapp-default", escalatedRole: "hoteles-whatsapp-escalated" });
    const deps: AppDeps = {
      env: TEST_ENV,
      coreRepo,
      engine: new InMemoryTenancyEngine(),
      restaurantesRepo: new InMemoryRestaurantesRepository(),
      turnHandler: acknowledgeOnlyTurnHandler(new InMemoryRestaurantesRepository()),
      hotelesRepo,
      hotelesPaymentsPort: new InMemoryPaymentsPort(),
      hotelesTurnHandler,
      citasRepo: new InMemoryCitasRepository(),
      licitacionesRepo: new InMemoryLicitacionesRepository(),
      despachosRepo: new InMemoryDespachosRepository(),
      despachosAuditSink: new InMemoryAuditSink(),
      rentasRepo: new InMemoryRentasRepository(),
    };
    const app = buildApp(deps);

    const res = await app.request("/v1/hoteles/whatsapp/webhook", signedPostInit(metaPayload("wamid.hotel-escalada-1", "Quiero algo de comer")));
    expect(res.status).toBe(200);
    expect(defaultCalls).toHaveLength(1);
    expect(escalatedCalls).toHaveLength(1);
  });

  it("un número de WhatsApp no configurado en ninguna property responde ack silencioso (200), nunca reintento ni 404", async () => {
    const { deps } = await buildLlmAgentTestDeps(() => textTurn("no debería llamarse"));
    const app = buildApp(deps);
    const payload = metaPayload("wamid.numero-no-configurado", "Hola");
    (payload.entry[0]!.changes[0]!.value.metadata as { phone_number_id: string }).phone_number_id = "0000000000";
    const res = await app.request("/v1/hoteles/whatsapp/webhook", signedPostInit(payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
