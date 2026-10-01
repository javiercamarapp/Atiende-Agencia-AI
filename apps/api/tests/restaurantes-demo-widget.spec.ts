// R-19 -- widget publico de chat WhatsApp para demos (sin Meta), por HTTP real sobre repos en memoria. Cubre: solo
// organizaciones marcadas como demo, estado honesto sin proveedor LLM (nunca respuestas simuladas), el agente REAL de
// WhatsApp (LlmGateway con proveedor falso en el borde de red), topes de tasa (IP, sesion, organizacion), validacion, origen y,
// sobre todo, que NINGUNA ruta del widget envia a Meta (outbox vacio, cero fetch, sin importar el despachador).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { DEMO_WIDGET_LIMITS, InMemoryDemoRepository, createLlmWhatsAppTurnHandler, esTelefonoDemo } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const BASE = `/v1/restaurantes/demo/${ORG}`;
const ORIGIN = { origin: "http://localhost:5173" };
const SESSION = "sesion-demo-0123456789abcdef";

type Script = (req: LlmCompletionRequest, n: number) => LlmCompletionResult;
const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamadas = (calls: ReadonlyArray<{ name: string; args: unknown }>, n: number): LlmCompletionResult => ({
  text: "",
  toolCalls: calls.map((c, i) => ({ id: `c${n}-${i}`, name: c.name, argumentsJson: JSON.stringify(c.args) })),
  model: "fake",
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
});

async function setup(options: { demo?: "marcada" | "apagada" | "ninguna"; agente?: boolean; script?: (products: Record<string, string>) => Script } = {}) {
  const t = await buildTestDeps();
  const demoRepo = new InMemoryDemoRepository();
  const modo = options.demo ?? "marcada";
  if (modo === "marcada") demoRepo.markDemo(t.organizationId);
  if (modo === "apagada") demoRepo.markDemo(t.organizationId, { activo: false });

  let gatewayCalls = 0;
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  const script: Script = options.script ? options.script(t.products) : () => texto("Hola, ¿qué le gustaría pedir?");
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "scripted", script: (req) => script(req, gatewayCalls++) })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "unused" })]);
  const turnHandler = createLlmWhatsAppTurnHandler(t.restaurantesRepo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

  const deps: AppDeps = { ...t.deps, demoRepo: (_db) => demoRepo, turnHandler, llmGateway: options.agente === false ? undefined : gateway };
  const app = buildApp(deps);
  const post = (body: Record<string, unknown>, headers: Record<string, string> = ORIGIN) => app.request(`${BASE}/mensaje`, jsonRequestInit(body, headers));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  return { ...t, app, post, json, demoRepo, calls: () => gatewayCalls };
}

afterEach(() => vi.restoreAllMocks());

describe("estado del widget", () => {
  it("demo cargada con agente real disponible: disponible + sucursales activas para elegir", async () => {
    const s = await setup();
    const res = await s.app.request(`${BASE}/estado`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await s.json(res);
    expect(body).toMatchObject({ disponible: true, motivo: null, mensaje: null, restaurante: { slug: ORG, nombre: "Los Taquitos de PM" } });
    expect(body.sucursales).toEqual([{ slug: "fco-montejo", nombre: "Francisco de Montejo" }]);
    expect(body.limites).toEqual({ mensajes_por_sesion: DEMO_WIDGET_LIMITS.perSessionPerDay, caracteres_por_mensaje: DEMO_WIDGET_LIMITS.maxMessageChars });
  });

  it("sin proveedor LLM: estado honesto 'requiere OPENROUTER_API_KEY' (no es una respuesta simulada)", async () => {
    const s = await setup({ agente: false });
    const body = await s.json(await s.app.request(`${BASE}/estado`));
    expect(body).toMatchObject({ disponible: false, motivo: "sin_agente" });
    expect(body.mensaje).toContain("OPENROUTER_API_KEY");
  });

  it("organizacion real (sin marca demo): no disponible y no revela sucursales ni nombre", async () => {
    const s = await setup({ demo: "ninguna" });
    const body = await s.json(await s.app.request(`${BASE}/estado`));
    expect(body).toMatchObject({ disponible: false, motivo: "no_es_demo", restaurante: null, sucursales: [] });
  });

  it("demo apagada por el operador: apagada", async () => {
    const s = await setup({ demo: "apagada" });
    expect((await s.json(await s.app.request(`${BASE}/estado`))).motivo).toBe("apagada");
  });

  it("organizacion inexistente: 404", async () => {
    const s = await setup();
    expect((await s.app.request(`/v1/restaurantes/demo/no-existe/estado`)).status).toBe(404);
  });
});

describe("POST mensaje: solo demos, agente real, sin Meta", () => {
  it("responde con el agente real y guarda la conversacion con telefono ficticio; nada se encola hacia Meta", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const s = await setup();
    const res = await s.post({ session_id: SESSION, mensaje: "Hola, quiero hacer un pedido", sucursal: "fco-montejo" });
    expect(res.status).toBe(200);
    expect(await s.json(res)).toMatchObject({ tipo: "respuesta", respuesta: expect.stringContaining("qué le gustaría pedir"), escalado: false, pedido: null });
    expect(s.calls()).toBeGreaterThan(0);
    // Ninguna salida hacia Meta: outbox de WhatsApp vacio y ninguna llamada de red.
    expect(await s.restaurantesRepo.claimMessagingOutboxBatch(10, 60)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pedido completo por el widget: el motor real crea el pedido con total coherente y la ruta lo reporta", async () => {
    const s = await setup({
      script: (products) => {
        const items = [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
        const pasos: LlmCompletionResult[] = [
          llamadas([{ name: "cotizar_pedido", args: { branch_slug: "fco-montejo", items, canal: "recoger" } }], 0),
          texto("El total es $90. ¿Efectivo y confirma?"),
          llamadas(
            [
              { name: "confirmar_resumen", args: {} },
              { name: "crear_pedido", args: { branch_slug: "fco-montejo", customer_name: "Ana Demo", payment_method: "efectivo", canal: "recoger", items } },
            ],
            2,
          ),
          texto("Listo, su pedido ya está en cocina."),
        ];
        return (_req, n) => pasos[n] ?? texto("ok");
      },
    });
    const primero = await s.json(await s.post({ session_id: SESSION, mensaje: "Quiero 2 coca colas para recoger", sucursal: "fco-montejo" }));
    expect(primero).toMatchObject({ tipo: "respuesta", pedido: null });
    const segundo = await s.json(await s.post({ session_id: SESSION, mensaje: "Sí, en efectivo", sucursal: "fco-montejo" }));
    expect(segundo.pedido).toMatchObject({ total: 90, estado: "pending" });
    const order = await s.restaurantesRepo.findOrderById(s.organizationId, segundo.pedido.id);
    expect(order).toMatchObject({ total: 90, customerName: "Ana Demo", source: "whatsapp" });
    expect(esTelefonoDemo(order!.customerPhone)).toBe(true);
    expect(await s.restaurantesRepo.claimMessagingOutboxBatch(10, 60)).toEqual([]);
  });

  it("organizacion real (sin marca demo): 404 y el agente NO se invoca", async () => {
    const s = await setup({ demo: "ninguna" });
    const res = await s.post({ session_id: SESSION, mensaje: "Hola" });
    expect(res.status).toBe(404);
    expect(s.calls()).toBe(0);
  });

  it("sin proveedor LLM: 503 honesto con el motivo y sin llamar al agente (no hay respuesta simulada)", async () => {
    const s = await setup({ agente: false });
    const res = await s.post({ session_id: SESSION, mensaje: "Hola" });
    expect(res.status).toBe(503);
    const body = await s.json(res);
    expect(body).toMatchObject({ code: "demo_no_disponible", motivo: "sin_agente" });
    expect(body.message).toContain("OPENROUTER_API_KEY");
    expect(s.calls()).toBe(0);
  });

  it("demo apagada: 503 apagada", async () => {
    const s = await setup({ demo: "apagada" });
    const res = await s.post({ session_id: SESSION, mensaje: "Hola" });
    expect(res.status).toBe(503);
    expect(await s.json(res)).toMatchObject({ motivo: "apagada" });
  });

  it("una queja escala: el agente real clasifica el riesgo y responde que avisó al equipo, sin llamar al modelo", async () => {
    const s = await setup();
    const res = await s.post({ session_id: SESSION, mensaje: "Quiero poner una queja, mi pedido llegó frío" });
    expect(res.status).toBe(200);
    expect(await s.json(res)).toMatchObject({ tipo: "respuesta" });
    expect(s.calls()).toBe(0);
    expect(await s.restaurantesRepo.claimMessagingOutboxBatch(10, 60)).toEqual([]);
  });
});

describe("validacion y origen", () => {
  it("origen no permitido: 403", async () => {
    const s = await setup();
    expect((await s.post({ session_id: SESSION, mensaje: "Hola" }, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("session_id invalido, mensaje no texto, vacio o demasiado largo, sucursal inexistente: 400 sin gastar un token", async () => {
    const s = await setup();
    expect((await s.post({ session_id: "corta", mensaje: "Hola" })).status).toBe(400);
    expect((await s.post({ session_id: SESSION, mensaje: 42 })).status).toBe(400);
    expect((await s.post({ session_id: SESSION, mensaje: "   " })).status).toBe(400);
    expect((await s.post({ session_id: SESSION, mensaje: "x".repeat(DEMO_WIDGET_LIMITS.maxMessageChars + 1) })).status).toBe(400);
    expect((await s.post({ session_id: SESSION, mensaje: "Hola", sucursal: "no-existe" })).status).toBe(400);
    expect(s.calls()).toBe(0);
  });
});

describe("topes de tasa y de costo", () => {
  it("por IP: pasado el tope por minuto responde 429", async () => {
    const s = await setup();
    const headers = { ...ORIGIN, "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < DEMO_WIDGET_LIMITS.perIpPerMinute; i += 1) {
      expect((await s.post({ session_id: `sesion-ip-${String(i).padStart(14, "0")}`, mensaje: "Hola" }, headers)).status).toBe(200);
    }
    expect((await s.post({ session_id: "sesion-ip-final-0123456789", mensaje: "Hola" }, headers)).status).toBe(429);
  });

  it("por sesion: el tope de mensajes por visitante corta aunque cambie de IP (tope de costo por visitante)", async () => {
    const s = await setup();
    for (let i = 0; i < DEMO_WIDGET_LIMITS.perSessionPerDay; i += 1) {
      const res = await s.post({ session_id: SESSION, mensaje: "Hola" }, { ...ORIGIN, "x-forwarded-for": `198.51.100.${i + 1}` });
      expect(res.status).toBe(200);
    }
    const res = await s.post({ session_id: SESSION, mensaje: "Hola" }, { ...ORIGIN, "x-forwarded-for": "198.51.100.250" });
    expect(res.status).toBe(429);
    expect(await s.json(res)).toMatchObject({ code: "demo_sesion_tope" });
  });

  it("por organizacion: el tope diario total de la demo (tope de costo) corta a TODOS los visitantes", async () => {
    const s = await setup();
    // Agota el cupo de la organizacion directamente en el limitador (600 requests HTTP serian lentos y no aportan mas).
    for (let i = 0; i < DEMO_WIDGET_LIMITS.perOrganizationPerDay; i += 1) {
      await s.restaurantesRepo.consumeRateLimit("demo-widget-org", await hashOf(s.organizationId), DEMO_WIDGET_LIMITS.perOrganizationPerDay, 86_400);
    }
    const res = await s.post({ session_id: "visitante-nuevo-0123456789", mensaje: "Hola" });
    expect(res.status).toBe(429);
    expect(await s.json(res)).toMatchObject({ code: "demo_tope_alcanzado" });
    expect(s.calls()).toBe(0);
  });
});

async function hashOf(actor: string): Promise<string> {
  const { actorHash } = await import("@atiende/domain-restaurantes");
  return actorHash(actor);
}

describe("ninguna ruta del widget envia a Meta (garantia estatica)", () => {
  it("el archivo del widget no importa el despachador de WhatsApp ni encola en el outbox", () => {
    const source = readFileSync(new URL("../src/routes/verticals/restaurantes/demo-widget.ts", import.meta.url), "utf8");
    // Se ignoran los comentarios: lo que importa es el codigo ejecutable.
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/whatsapp-dispatch|triggerRestaurantesWhatsAppDispatchInline|enqueueMessagingOutbox|graph\.facebook|meta-graph/i);
  });
});
