// Banco e2e del ciclo completo de restaurantes (R-23 / R-35). Levanta la API REAL (`buildApp`) en un
// puerto HTTP efimero y la rodea de simuladores locales que hablan HTTP de verdad:
//
//   comensal --(HTTP firmado)--> MetaCloudSimulator ==> POST /v1/restaurantes/whatsapp/webhook
//   API --(MetaGraphWhatsAppClient, HTTP real)--> MetaCloudSimulator (ventana de 24 h, 131047)
//   API --(fetch a api.resend.com redirigido)--> ResendSink (el "Mailpit" de este repo: Resend es el unico transporte)
//   pedido --> comanda --> FakeSoftRestaurantAdapter (POS falso sembrado, idempotente por externalRef)
//
// Solo repos en memoria y un LLM guionado (FakeLlmProvider, sin red). Nada toca la base real ni ninguna
// credencial: los secretos son literales ficticios de este banco. El SQL/RLS lo cubre scripts/verify-*.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import {
  InMemoryConversacionesRepository,
  InMemoryHandoffAgentGate,
  InMemoryPrivacidadRepository,
  InMemoryVozKpiRepository,
  InMemoryVozRepository,
  FakeVoiceProvider,
  VOICE_TOOL_HTTP_PATHS,
  createLlmWhatsAppTurnHandler,
} from "@atiende/domain-restaurantes";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import {
  FakeSoftRestaurantAdapter,
  InMemoryComandaOutboxStore,
  MapaProductoCodigo,
  crearResolverSucursalPos,
  encolarComandaParaPedido,
} from "@atiende/domain-restaurantes/softrestaurant";
import type { SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import { MetaGraphWhatsAppClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { MetaCloudSimulator, ResendSink, createSimulatorFetch, serveFetchHandler } from "@atiende/whatsapp-gateway/testing";
import type { RunningServer } from "@atiende/whatsapp-gateway/testing";
import { buildApp } from "../../src/app.ts";
import type { AppDeps } from "../../src/deps.ts";
import { softRestaurantComandaDeps } from "../../src/routes/verticals/restaurantes/softrestaurant-wiring.ts";
import { TEST_ENV } from "../fixtures.ts";
import { buildRestaurantesKpiTestContext } from "../restaurantes-admin-kpis-fixtures.ts";
import type { RestaurantesKpiTestContext } from "../restaurantes-admin-kpis-fixtures.ts";

/** Martes 2026-10-06 13:00 hora de Merida (UTC-6 todo el ano): sucursal abierta (12:00-01:00), no es lunes. */
export const MARTES_ABIERTO = "2026-10-06T19:00:00.000Z";
/** Lunes 2026-10-05 13:00 Merida: dia de la promo 2x1 (solo recoger). */
export const LUNES_ABIERTO = "2026-10-05T19:00:00.000Z";
/** Martes 2026-10-06 08:00 Merida: antes de abrir. */
export const MARTES_CERRADO = "2026-10-06T14:00:00.000Z";

export const E2E_SECRETS = {
  appSecret: "e2e-whatsapp-app-secret",
  verifyToken: "e2e-verify-token",
  accessToken: "e2e-graph-access-token",
  resendKey: "e2e-resend-key",
  internalSecret: "e2e-internal-secret",
  voiceToolSecret: "e2e-voice-tool-secret",
} as const;
export const PHONE_NUMBER_ID = "5550001112";
export const ORG_SLUG = "los-taquitos-de-pm";

export type ScriptStep = (req: LlmCompletionRequest) => LlmCompletionResult;

const base = { model: "fake/scripted", tokensIn: 1, tokensOut: 1, costUsd: 0 };
export const say = (text: string): ScriptStep => () => ({ text, ...base });
export const call = (name: string, args: Record<string, unknown> | ((req: LlmCompletionRequest) => Record<string, unknown>)): ScriptStep => (req) => ({
  text: "",
  toolCalls: [{ id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`, name, argumentsJson: JSON.stringify(typeof args === "function" ? args(req) : args) }],
  ...base,
});
/** Variante de `call` que registra el resultado de la tool ANTERIOR en `seen` (para asertar despues, sin romper el guion). */
export function callObserving(seen: unknown[], name: string, args: Record<string, unknown>): ScriptStep {
  const inner = call(name, args);
  return (req) => {
    const hasTool = req.messages.some((m) => m.role === "tool");
    if (hasTool) seen.push(lastTool(req));
    return inner(req);
  };
}
/** Registra el resultado de la ultima tool y responde texto. */
export function sayObserving(seen: unknown[], text: string): ScriptStep {
  return (req) => {
    if (req.messages.some((m) => m.role === "tool")) seen.push(lastTool(req));
    return { text, ...base };
  };
}
/** Resultado JSON de la ULTIMA tool ejecutada, tal como lo leeria un modelo real en su contexto. */
export function lastTool<T = Record<string, unknown>>(req: LlmCompletionRequest): T {
  const msg = [...req.messages].reverse().find((m) => m.role === "tool");
  if (!msg || msg.role !== "tool") throw new Error("se esperaba un mensaje tool previo");
  return JSON.parse(msg.content) as T;
}

export interface CicloStack {
  readonly ctx: RestaurantesKpiTestContext;
  readonly deps: AppDeps;
  readonly api: RunningServer;
  readonly sim: MetaCloudSimulator;
  readonly sink: ResendSink;
  readonly pos: FakeSoftRestaurantAdapter;
  readonly comandas: InMemoryComandaOutboxStore;
  readonly conversaciones: InMemoryConversacionesRepository;
  readonly privacidad: InMemoryPrivacidadRepository;
  readonly voz: InMemoryVozRepository;
  readonly vozKpi: InMemoryVozKpiRepository;
  readonly products: { readonly bistec3: string; readonly pastor: string; readonly coca: string; readonly heineken: string; readonly horchata: string };
  readonly propertyId: string;
  /** Reemplaza el guion del LLM (cada prueba trae el suyo). */
  setScript(steps: readonly ScriptStep[]): void;
  /** Drena el outbox de WhatsApp por la ruta real de cron (ademas del drenado inline del webhook). */
  dispatchWhatsApp(): Promise<Response>;
  /** Drena el outbox de correo por la ruta real. */
  dispatchEmail(): Promise<Response>;
  /** Drena el outbox de comandas al POS por la ruta real. */
  dispatchPos(): Promise<Response>;
  url(path: string): string;
  stop(): Promise<void>;
}

/** El falso se declara "real" SOLO en pruebas para poder prender la bandera (mismo truco que restaurantes-softrestaurant.spec). */
function falsoComoReal(fake: FakeSoftRestaurantAdapter): SoftRestaurantPort {
  return new Proxy(fake, { get: (t, p, r) => (p === "esReal" ? true : Reflect.get(t, p, r)) }) as unknown as SoftRestaurantPort;
}

export async function startCicloStack(opts: { readonly now?: string } = {}): Promise<CicloStack> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(opts.now ?? MARTES_ABIERTO) });

  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const repo = ctx.restaurantesRepo;
  const propertyId = ctx.propertyIdA;
  const organizationId = ctx.organizationId;

  // --- Menu y reglas PM de la sucursal A (la B queda sin menu: sirve para aislamiento) ---
  const cat = randomUUID();
  const catBebidas = randomUUID();
  const catCervezas = randomUUID();
  repo.seedCategory({ id: cat, organizationId, name: "Tacos" });
  repo.seedCategory({ id: catBebidas, organizationId, name: "Bebidas" });
  repo.seedCategory({ id: catCervezas, organizationId, name: "Cervezas" });
  const products = { bistec3: randomUUID(), pastor: randomUUID(), coca: randomUUID(), heineken: randomUUID(), horchata: randomUUID() };
  const seedProduct = (id: string, categoryId: string, name: string, price: number, isAvailable = true) => {
    repo.seedProduct({ id, organizationId, categoryId, name, description: null, searchKeywords: [] });
    repo.seedBranchProduct({ propertyId, productId: id, price, isAvailable });
  };
  seedProduct(products.bistec3, cat, "Tacos de Bistec de Res (orden de 3)", 164);
  seedProduct(products.pastor, cat, "Tacos al Pastor (orden de 3)", 120);
  seedProduct(products.coca, catBebidas, "Coca-Cola", 45);
  seedProduct(products.heineken, catCervezas, "Heineken", 55);
  seedProduct(products.horchata, catBebidas, "Agua de Horchata", 40, false);
  repo.seedNoDomicilio({ productIds: [products.heineken] });
  repo.seedBranchPolicy(propertyId, {
    horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }],
    pedidoMinimoDomicilio: 200,
    pedidoMinimoRecoger: null,
    propinaPolitica: "solo_tarjeta",
  });
  // Sucursal A: coordenadas reales de Francisco de Montejo; zona conocida cercana y otra lejana.
  repo.seedBranch({ propertyId, organizationId, name: "Francisco de Montejo", slug: "fco-montejo", status: "active", phone: "+529991234567", address: "Calle 1 #100, Merida", lat: 21.0186, lng: -89.6708 });
  const zonaCerca = randomUUID();
  const zonaLejos = randomUUID();
  repo.seedKnownZone({ id: zonaCerca, organizationId, name: "Francisco de Montejo", lat: 21.0186, lng: -89.6708 });
  repo.seedKnownZone({ id: zonaLejos, organizationId, name: "Progreso", lat: 21.2822, lng: -89.6637 });
  repo.seedBranchDeliveryZones(propertyId, [zonaCerca]);
  repo.seedWhatsAppBranchChannel(organizationId, propertyId, PHONE_NUMBER_ID);
  repo.seedWhatsAppChannel(organizationId, PHONE_NUMBER_ID);

  // --- POS falso en modo ACTIVO ---
  const pos = new FakeSoftRestaurantAdapter({ ahora: () => new Date() });
  const comandas = new InMemoryComandaOutboxStore();
  comandas.ponerModo(organizationId, "activo");

  // --- Simuladores locales ---
  const sim = new MetaCloudSimulator({ appSecret: E2E_SECRETS.appSecret, accessToken: E2E_SECRETS.accessToken, phoneNumberId: PHONE_NUMBER_ID });
  await sim.start();
  const sink = new ResendSink(E2E_SECRETS.resendKey);
  await sink.start();
  // El correo sale por `fetch` global hacia api.resend.com: se redirige al sumidero; cualquier otro host se bloquea.
  vi.stubGlobal("fetch", createSimulatorFetch({ resendBaseUrl: sink.baseUrl, graphBaseUrl: sim.baseUrl }));

  // --- LLM guionado + turn handler con comanda al POS (mismo cableado que production/deps.ts) ---
  let script: readonly ScriptStep[] = [];
  let cursor = 0;
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  gateway.registerLadder("e2e-default", [
    new FakeLlmProvider({
      id: "scripted",
      script: (req) => {
        const step = script[cursor++];
        if (!step) throw new Error(`guion del LLM agotado en el paso ${cursor} (el sistema pidio mas turnos de los guionados)`);
        return step(req);
      },
    }),
  ]);
  gateway.registerLadder("e2e-escalated", [new FakeLlmProvider({ id: "escalated-unused" })]);

  const conversaciones = new InMemoryConversacionesRepository({ actorUserId: ctx.staff.owner.id, actorEsAdministrador: true });
  // La toma de handoff necesita la conversacion de WhatsApp (en Postgres la crea el webhook): se refleja aqui.
  const gateBase = new InMemoryHandoffAgentGate(conversaciones);
  const handoffGate = {
    estadoParaAgente: (org: string, phone: string) => gateBase.estadoParaAgente(org, phone),
    solicitarHumano: (input: { organizationId: string; propertyId: string | null; phone: string; motivo: string }) => {
      if (!conversaciones.conversaciones.some((c) => c.telefono === input.phone)) {
        conversaciones.conversaciones.push({ canal: "whatsapp", id: randomUUID(), organizationId: input.organizationId, propertyId: input.propertyId ?? propertyId, telefono: input.phone, mensajes: [], actividadAt: new Date().toISOString() });
      }
      return gateBase.solicitarHumano({ ...input, propertyId: input.propertyId ?? propertyId });
    },
  };
  const privacidad = new InMemoryPrivacidadRepository();
  const env = {
    ...TEST_ENV,
    whatsappAppSecret: E2E_SECRETS.appSecret,
    whatsappVerifyToken: E2E_SECRETS.verifyToken,
    whatsappAccessToken: E2E_SECRETS.accessToken,
    internalSecret: E2E_SECRETS.internalSecret,
    voiceToolSecret: E2E_SECRETS.voiceToolSecret,
    resend: { apiKey: E2E_SECRETS.resendKey, from: "atiende <pedidos@atiende.test>" },
    voicePreviewTokenSecret: "e2e-voice-preview-token-secret",
  };
  const voz = new InMemoryVozRepository();
  voz.seedProperty(propertyId, organizationId);
  const vozKpi = new InMemoryVozKpiRepository();

  const holder: { deps: AppDeps | null } = { deps: null };
  const turnHandler: WhatsAppTurnHandler = {
    handleInboundMessage: (args) =>
      holder.deps!.engine.withAppSession({ userId: null }, (db) =>
        createLlmWhatsAppTurnHandler(repo, gateway, {
          defaultRole: "e2e-default",
          escalatedRole: "e2e-escalated",
          encolarComanda: (pedido) => encolarComandaParaPedido(softRestaurantComandaDeps(holder.deps!, db, repo), pedido),
        }).handleInboundMessage(args),
      ),
  };

  const deps: AppDeps = {
    ...ctx.deps,
    env,
    turnHandler,
    softRestaurantStore: () => comandas,
    softRestaurantPort: falsoComoReal(pos),
    softRestaurantMapeo: {
      resolverCodigos: new MapaProductoCodigo([
        { productId: products.coca, codigo: "FAKE-003" },
        { productId: products.bistec3, codigo: "FAKE-002" },
        { productId: products.pastor, codigo: "FAKE-001" },
      ]),
      resolverSucursal: crearResolverSucursalPos({ [propertyId]: "T2" }),
    },
    whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient: new MetaGraphWhatsAppClient({ accessToken: E2E_SECRETS.accessToken, baseUrl: sim.baseUrl }) }),
    privacidadRepo: () => privacidad,
    conversacionesRepo: () => conversaciones,
    handoffGate: () => handoffGate,
    vozRepo: () => voz,
    vozKpiRepo: () => vozKpi,
    voiceProvider: new FakeVoiceProvider(),
  };
  holder.deps = deps;

  const app = buildApp(deps);
  const api = await serveFetchHandler((request) => app.fetch(request));
  sim.setWebhookUrl(`${api.baseUrl}/v1/restaurantes/whatsapp/webhook`);

  const internal = (path: string) => fetch(`${api.baseUrl}${path}`, { method: "POST", headers: { "x-atiende-internal-secret": E2E_SECRETS.internalSecret } });

  return {
    ctx,
    deps,
    api,
    sim,
    sink,
    pos,
    comandas,
    conversaciones,
    privacidad,
    voz,
    vozKpi,
    products,
    propertyId,
    setScript(steps) {
      script = steps;
      cursor = 0;
    },
    dispatchWhatsApp: () => internal("/internal/whatsapp/dispatch"),
    dispatchEmail: () => internal("/internal/restaurantes/email-dispatch"),
    dispatchPos: () => internal("/internal/restaurantes/softrestaurant-dispatch"),
    url: (path) => `${api.baseUrl}${path}`,
    async stop() {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      await api.close();
      await sim.stop();
      await sink.stop();
    },
  };
}

export interface VoiceCall {
  readonly callId: string;
  readonly token: string;
  /** Invoca una tool del agente de voz por su ruta HTTP real (la misma del manifiesto) con secreto de sucursal/legado + token de llamada. */
  tool(name: keyof typeof VOICE_TOOL_HTTP_PATHS, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** "Telefonia": emite el token de llamada con el caller ID que reporta la linea (nunca el modelo) y devuelve el agente guionado. */
export async function startVoiceCall(stack: CicloStack, callerPhone: string, callId: string): Promise<VoiceCall> {
  const headers = { "content-type": "application/json", "x-atiende-tool-secret": E2E_SECRETS.voiceToolSecret };
  const res = await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/voice/call-token`), { method: "POST", headers, body: JSON.stringify({ call_id: callId, caller_phone: callerPhone, branch_slug: "fco-montejo" }) });
  if (res.status !== 200) throw new Error(`call-token fallo: ${res.status} ${await res.text()}`);
  const { call_token: token } = (await res.json()) as { call_token: string };
  return {
    callId,
    token,
    async tool(name, body) {
      const raw = JSON.stringify(body);
      const r = await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}${VOICE_TOOL_HTTP_PATHS[name]}`), {
        method: "POST",
        headers: { ...headers, "x-atiende-call-token": token, "content-length": String(new TextEncoder().encode(raw).byteLength) },
        body: raw,
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
  };
}
