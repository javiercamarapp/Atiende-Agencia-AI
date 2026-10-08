// Test de integración REAL de POST /internal/whatsapp/dispatch — la ruta que
// finalmente envía de verdad, vía Graph API, la respuesta que el agente de
// WhatsApp de las 3 verticales (citas/hoteles/restaurantes) ya decidía pero nunca
// llegaba al cliente (ver @atiende/whatsapp-gateway/README.md). Usa
// FakeWhatsAppGraphClient — NUNCA toca la red ni usa un WHATSAPP_ACCESS_TOKEN real.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryCoreRepository, InMemoryAuthzAuditRepository, InMemoryImpersonationRepository, InMemoryLlmUsageRepository, InMemoryResumenDiarioRepository, InMemorySaludRepository, InMemorySuperadminAccionesRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
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
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher, WhatsAppSendError } from "@atiende/whatsapp-gateway";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";
import type { TurnoAgente } from "@atiende/domain-restaurantes";

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
  const rentasMensajeriaRepoUnused = new InMemoryRentasMensajeriaRepository();

  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    coreStaffRepo: (_db) => coreRepo,
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
    citasCalendarSyncPortResolver: createCalendarSyncPortResolver(citasRepo, { clientId: "test-google-client-id", clientSecret: "test-google-client-secret" }),
    citasCalComPortFactory: (cfg) => new RealCalComPort(cfg),
    citasCalDavPortFactory: (cfg) => new RealCalDavPort(cfg),
    citasGoogleTokenExchange: async () => {
      throw new Error("no debería llamarse en este fixture");
    },
    citasCaldavUrlValidator: async () => {
      throw new Error("no debería llamarse en este fixture");
    },
    licitacionesRepo: (_db) => licitacionesRepoUnused,
    despachosRepo: (_db) => despachosRepoUnused,
    despachosAuditSink: new InMemoryAuditSink(),
    rentasRepo: (_db) => rentasRepoUnused,
    rentasOwnerPortalRepo: (_db) => rentasOwnerPortalRepoUnused,
    rentasOnboardingRepo: (_db) => new InMemoryRentasOnboardingRepository(),
    rentasCalendarSyncRepo: (_db) => rentasCalendarSyncRepoUnused,
    rentasMensajeriaRepo: (_db) => rentasMensajeriaRepoUnused,
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

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` — nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  // Antes de este fix la ruta era app.post-only con secretMatches, así que esta
  // forma de invocación (la única que Vercel Cron sabe usar) hubiera dado 404.
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = buildDispatchTestContext({ withDispatcher: true });
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/whatsapp/dispatch", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = buildDispatchTestContext({ withDispatcher: true });
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/whatsapp/dispatch", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET con un Bearer incorrecto responde 401", async () => {
    const ctx = buildDispatchTestContext({ withDispatcher: true });
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/whatsapp/dispatch", { method: "GET", headers: { authorization: "Bearer secreto-equivocado" } });
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

// Salud de Meta enganchada al cron existente: token por vencer y timeouts/fallos del agente. Reloj fijo: miercoles 7-oct-2026 12:00 America/Merida
// (18:00 UTC). Los lectores son dobles inyectados: ninguna prueba llama a Meta.
describe("POST /internal/whatsapp/dispatch: salud de Meta y del agente", () => {
  const AHORA = new Date("2026-10-07T18:00:00Z");
  const DIA = 86_400_000;
  const ORG = "00000000-0000-0000-0000-00000000a001";
  const turnos = (n: number, timeouts: number): TurnoAgente[] => Array.from({ length: n }, (_, i) => ({ organizationId: ORG, at: new Date(AHORA.getTime() - ((i % 9) + 0.5) * 60_000), resultado: i < timeouts ? "timeout" : "ok" }));
  const request = (deps: AppDeps) => buildApp(deps).request("/internal/whatsapp/dispatch", { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });

  it("token a 7 dias y 2 % de timeouts: la corrida emite ambos avisos de plataforma y responde igual que sin vigilancia", async () => {
    const base = buildDispatchTestContext({ withDispatcher: true });
    const { deps, emisiones } = conEmisiones({
      ...base.deps,
      saludMeta: {
        lectorToken: { leer: async () => ({ valido: true, expiraEn: new Date(AHORA.getTime() + 7 * DIA) }) },
        lectorTurnos: () => ({ leer: async () => turnos(100, 2) }),
        reloj: () => AHORA,
      },
    });
    const res = await request(deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(emisiones.map((e) => e.evento).sort()).toEqual(["superadmin.agente.timeouts_altos", "superadmin.whatsapp.token_por_vencer"]);
    expect(emisiones.every((e) => e.organizationId === null && e.enlace === "/superadmin/salud")).toBe(true);
  });

  it("un lector del token que lanza y un lector de turnos que lanza NO alteran la respuesta del cron", async () => {
    const base = buildDispatchTestContext({ withDispatcher: true });
    const { deps, emisiones } = conEmisiones({
      ...base.deps,
      saludMeta: {
        lectorToken: { leer: async () => { throw new Error("Graph caido"); } },
        lectorTurnos: () => ({ leer: async () => { throw new Error("base caida"); } }),
        reloj: () => AHORA,
      },
    });
    const res = await request(deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(emisiones).toHaveLength(0);
  });

  it("el token se consulta solo en el primer tick de cada hora (minutos 0-4 UTC): a las 12:05 no se llama a Meta, a las 12:04 si", async () => {
    let llamadas = 0;
    const lectorToken = { leer: async () => { llamadas += 1; return { valido: true, expiraEn: null }; } };
    const base = buildDispatchTestContext({ withDispatcher: true });
    const con = (reloj: Date) => ({ ...base.deps, saludMeta: { lectorToken, lectorTurnos: () => ({ leer: async () => [] }), reloj: () => reloj } });
    await request(con(new Date("2026-10-07T18:05:00Z")));
    expect(llamadas).toBe(0);
    await request(con(new Date("2026-10-07T18:04:59Z")));
    expect(llamadas).toBe(1);
  });

  it("si withAppSession RECHAZA durante la vigilancia (token y agente), la respuesta del cron no cambia", async () => {
    const base = buildDispatchTestContext({ withDispatcher: true });
    const normal = await (await request(base.deps)).json();
    let sesionesVigilancia = 0;
    const engine = {
      withAppSession: (claims: never, fn: (s: never) => Promise<unknown>) => {
        // las sesiones de la vigilancia se reconocen porque se piden DESPUES del despacho: las rechazamos todas desde que se activa la bandera
        if (sesionesVigilancia >= 0 && vigilando) { sesionesVigilancia += 1; return Promise.reject(new Error("base caida")); }
        return base.deps.engine.withAppSession(claims, fn as never);
      },
    } as unknown as AppDeps["engine"];
    let vigilando = false;
    const deps: AppDeps = {
      ...base.deps,
      engine,
      saludMeta: {
        lectorToken: { leer: async () => { vigilando = true; return { valido: true, expiraEn: new Date(AHORA.getTime() + DIA) }; } },
        lectorTurnos: () => { vigilando = true; return { leer: async () => turnos(100, 5) }; },
        reloj: () => { vigilando = true; return AHORA; },
      },
    };
    const res = await request(deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(normal);
    expect(sesionesVigilancia).toBeGreaterThanOrEqual(2);
  });

  it("un Graph colgado (debug_token que nunca responde) no bloquea el despacho: corta por su tope y la respuesta es la normal", async () => {
    const base = buildDispatchTestContext({ withDispatcher: true });
    const normal = await (await request(base.deps)).json();
    const { deps } = conEmisiones({ ...base.deps, saludMeta: { lectorToken: { leer: () => new Promise<{ valido: boolean | null; expiraEn: Date | null }>(() => undefined) }, limiteLecturaTokenMs: 30, lectorTurnos: () => ({ leer: async () => [] }), reloj: () => AHORA } });
    const t0 = Date.now();
    const res = await request(deps);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await res.json()).toEqual(normal);
  });

  it("el log de la vigilancia muestra el estado (no redactado): no_leido sale en nivel warn y nunca lleva secretos", async () => {
    const base = buildDispatchTestContext({ withDispatcher: true });
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deps = { ...base.deps, saludMeta: { lectorToken: { leer: async () => { throw new Error("Graph caido EAAsecreto-12345"); } }, lectorTurnos: () => ({ leer: async () => [] }), reloj: () => AHORA } };
    try {
      await request(deps);
      const lineas = aviso.mock.calls.map((a) => String(a[0])).filter((l) => l.includes("whatsapp_dispatch_salud_meta"));
      expect(lineas).toHaveLength(1);
      const log = JSON.parse(lineas[0]!) as Record<string, unknown>;
      expect(log).toMatchObject({ level: "warn", evento: "whatsapp_dispatch_salud_meta", estadoMeta: "no_leido", estadoAgente: "ok" });
      expect(lineas[0]).not.toContain("redactado");
      expect(lineas[0]).not.toContain("EAAsecreto");
      // con token leido bien, el nivel es info y el estado tambien es visible
      aviso.mockClear();
      info.mockClear();
      await request({ ...deps, saludMeta: { ...deps.saludMeta, lectorToken: { leer: async () => ({ valido: true, expiraEn: null }) } } });
      const infoLinea = info.mock.calls.map((a) => String(a[0])).find((l) => l.includes("whatsapp_dispatch_salud_meta"));
      expect(JSON.parse(infoLinea!)).toMatchObject({ level: "info", estadoMeta: "sin_fecha", estadoAgente: "ok" });
    } finally {
      aviso.mockRestore();
      info.mockRestore();
    }
  });

  it("sin saludMeta configurado (sin token) el cron se comporta como antes: ninguna llamada a Meta y la base sin migrar no rompe", async () => {
    const ctx = buildDispatchTestContext({ withDispatcher: true });
    const res = await request(ctx.deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});
