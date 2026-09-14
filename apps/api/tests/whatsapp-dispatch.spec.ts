// Test de integración REAL de POST /internal/whatsapp/dispatch — la ruta que
// finalmente envía de verdad, vía Graph API, la respuesta que el agente de
// WhatsApp de las 3 verticales (citas/hoteles/restaurantes) ya decidía pero nunca
// llegaba al cliente (ver @atiende/whatsapp-gateway/README.md). Usa
// FakeWhatsAppGraphClient — NUNCA toca la red ni usa un WHATSAPP_ACCESS_TOKEN real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } from "@atiende/mcp-cfdi";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, createGoogleCalendarPortResolver, InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { FakeIcalFeedPort, InMemoryRentasCalendarStore, InMemoryRentasCalendarSyncRepository, InMemoryRentasOwnerPortalRepository, InMemoryRentasRepository } from "@atiende/domain-rentas";
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher, WhatsAppSendError } from "@atiende/whatsapp-gateway";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

interface DispatchTestContext {
  readonly deps: AppDeps;
  readonly citasRepo: InMemoryCitasRepository;
  readonly hotelesRepo: InMemoryHotelesRepository;
  readonly restaurantesRepo: InMemoryRestaurantesRepository;
  readonly graphClient: FakeWhatsAppGraphClient;
  readonly citasOrgId: string;
  readonly hotelesPropertyId: string;
  readonly hotelesOrgId: string;
  readonly restaurantesOrgId: string;
}

/** Fixture liviano dedicado a esta ruta — a diferencia de
 * citas-fixtures.ts/hoteles-fixtures.ts (que arman organización+staff+reservas
 * completas para probar CADA vertical), aquí solo hace falta un organizationId por
 * vertical con su `messaging_outbox` accesible; el resto de `AppDeps` queda con
 * repos en memoria "unused" del mismo patrón que ya usan esos fixtures. */
function buildDispatchTestContext(opts: { readonly withDispatcher: boolean; readonly graphClient?: FakeWhatsAppGraphClient }): DispatchTestContext {
  const coreRepo = new InMemoryCoreRepository();
  const engine = new InMemoryTenancyEngine();

  const citasRepo = new InMemoryCitasRepository();
  const citasOrgId = randomUUID();
  citasRepo.seedOrganization({ id: citasOrgId, slug: "dispatch-citas", name: "Dispatch Citas", defaultTimezone: "America/Merida" });

  const hotelesRepo = new InMemoryHotelesRepository();
  const hotelesOrgId = randomUUID();
  const hotelesPropertyId = randomUUID();

  const restaurantesRepo = new InMemoryRestaurantesRepository();
  const restaurantesOrgId = randomUUID();
  restaurantesRepo.seedOrganization({ id: restaurantesOrgId, slug: "dispatch-restaurantes", name: "Dispatch Restaurantes" });

  const graphClient = opts.graphClient ?? new FakeWhatsAppGraphClient();
  const whatsAppDispatcher = opts.withDispatcher ? new WhatsAppOutboundDispatcher({ graphClient }) : undefined;

  const licitacionesRepoUnused = new InMemoryLicitacionesRepository();
  const despachosRepoUnused = new InMemoryDespachosRepository();
  const rentasRepoUnused = new InMemoryRentasRepository();
  const rentasOwnerPortalRepoUnused = new InMemoryRentasOwnerPortalRepository();
  const rentasCalendarSyncRepoUnused = new InMemoryRentasCalendarSyncRepository(new InMemoryRentasCalendarStore());

  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    engine,
    restaurantesRepo: (_db) => restaurantesRepo,
    turnHandler: acknowledgeOnlyTurnHandler(restaurantesRepo),
    hotelesRepo: (_db) => hotelesRepo,
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    hotelesTurnHandler: hotelesAcknowledgeOnlyTurnHandler(hotelesRepo),
    hotelesCfdiPort: new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
    hotelesFraudeAuditSink: new InMemoryAuditSink(),
    citasRepo: (_db) => citasRepo,
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(citasRepo, { clientId: "test-google-client-id", clientSecret: "test-google-client-secret" }),
    citasGoogleTokenExchange: async () => {
      throw new Error("no debería llamarse en este fixture");
    },
    licitacionesRepo: (_db) => licitacionesRepoUnused,
    despachosRepo: (_db) => despachosRepoUnused,
    despachosAuditSink: new InMemoryAuditSink(),
    rentasRepo: (_db) => rentasRepoUnused,
    rentasOwnerPortalRepo: (_db) => rentasOwnerPortalRepoUnused,
    rentasCalendarSyncRepo: (_db) => rentasCalendarSyncRepoUnused,
    rentasIcalFeedPort: new FakeIcalFeedPort(),
    llmGateway: undefined,
    whatsAppDispatcher,
  };

  return { deps, citasRepo, hotelesRepo, restaurantesRepo, graphClient, citasOrgId, hotelesPropertyId, hotelesOrgId, restaurantesOrgId };
}

describe("POST /internal/whatsapp/dispatch", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = buildDispatchTestContext({ withDispatcher: true });
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/whatsapp/dispatch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("responde 503 explícito cuando no hay WHATSAPP_ACCESS_TOKEN configurado (whatsAppDispatcher undefined) — nunca finge un envío", async () => {
    const ctx = buildDispatchTestContext({ withDispatcher: false });
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/whatsapp/dispatch", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("drena mensajes pendientes de las 3 verticales en una sola corrida, vía el graph client real (fake)", async () => {
    const ctx = buildDispatchTestContext({ withDispatcher: true });

    await ctx.citasRepo.enqueueMessagingOutbox(ctx.citasOrgId, "whatsapp", "whatsapp.inbound_reply", "inbound-reply:wamid-citas-1", {
      to: "+5219990000001",
      phone_number_id: "citas-phone-1",
      body: "Su cita quedó agendada",
    });
    await ctx.hotelesRepo.enqueueMessagingOutbox(ctx.hotelesPropertyId, ctx.hotelesOrgId, "whatsapp", "whatsapp.inbound_reply", "inbound-reply:wamid-hoteles-1", {
      to: "+5219990000002",
      phone_number_id: "hoteles-phone-1",
      body: "Su orden de room service va en camino",
    });
    await ctx.restaurantesRepo.enqueueMessagingOutbox(ctx.restaurantesOrgId, "whatsapp", "whatsapp.inbound_reply", "inbound-reply:wamid-restaurantes-1", {
      to: "+5219990000003",
      phone_number_id: "restaurantes-phone-1",
      body: "Su pedido está confirmado",
    });

    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/whatsapp/dispatch", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: Record<string, { sent: number; claimed: number }> };
    expect(body.ok).toBe(true);
    expect(body.results.citas).toMatchObject({ claimed: 1, sent: 1 });
    expect(body.results.hoteles).toMatchObject({ claimed: 1, sent: 1 });
    expect(body.results.restaurantes).toMatchObject({ claimed: 1, sent: 1 });

    expect(ctx.graphClient.sent).toHaveLength(3);
    expect(ctx.graphClient.sent.map((m) => m.body).sort()).toEqual(["Su cita quedó agendada", "Su orden de room service va en camino", "Su pedido está confirmado"].sort());
  });

  it("GARANTÍA DE IDEMPOTENCIA de punta a punta vía HTTP: una segunda corrida del job NUNCA reenvía un mensaje ya sent", async () => {
    const ctx = buildDispatchTestContext({ withDispatcher: true });
    await ctx.citasRepo.enqueueMessagingOutbox(ctx.citasOrgId, "whatsapp", "whatsapp.inbound_reply", "inbound-reply:wamid-citas-idem", {
      to: "+5219990000009",
      phone_number_id: "citas-phone-1",
      body: "mensaje único",
    });

    const app = buildApp(ctx.deps);
    const first = await app.request("/internal/whatsapp/dispatch", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(first.status).toBe(200);
    expect(ctx.graphClient.sent).toHaveLength(1);

    // Segunda corrida del MISMO job (mismo cron externo re-invocando la ruta) contra
    // el mismo estado — nada más que despachar, cero llamadas nuevas al graph client.
    const second = await app.request("/internal/whatsapp/dispatch", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { results: Record<string, { claimed: number; sent: number }> };
    expect(secondBody.results.citas).toMatchObject({ claimed: 0, sent: 0 });
    expect(ctx.graphClient.sent).toHaveLength(1); // sigue en 1, nunca 2

    // Tercera corrida por si acaso.
    await app.request("/internal/whatsapp/dispatch", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(ctx.graphClient.sent).toHaveLength(1);
  });

  it("un vertical con un mensaje que falla permanentemente no bloquea el despacho de los otros 2", async () => {
    const graphClient = new FakeWhatsAppGraphClient({
      onSend: (msg) => (msg.to === "+5219990000666" ? new WhatsAppSendError("400 número inválido", false) : undefined),
    });
    const ctx = buildDispatchTestContext({ withDispatcher: true, graphClient });

    await ctx.citasRepo.enqueueMessagingOutbox(ctx.citasOrgId, "whatsapp", "whatsapp.inbound_reply", "inbound-reply:wamid-citas-bad", {
      to: "+5219990000666",
      phone_number_id: "citas-phone-1",
      body: "este va a fallar permanente",
    });
    await ctx.restaurantesRepo.enqueueMessagingOutbox(ctx.restaurantesOrgId, "whatsapp", "whatsapp.inbound_reply", "inbound-reply:wamid-restaurantes-ok", {
      to: "+5219990000777",
      phone_number_id: "restaurantes-phone-1",
      body: "este sí llega",
    });

    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/whatsapp/dispatch", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: Record<string, { claimed: number; sent: number; dead: number }> };
    expect(body.ok).toBe(true); // un mensaje 'dead' no es un fallo de la RUTA
    expect(body.results.citas).toMatchObject({ claimed: 1, sent: 0, dead: 1 });
    expect(body.results.restaurantes).toMatchObject({ claimed: 1, sent: 1, dead: 0 });
  });
});
