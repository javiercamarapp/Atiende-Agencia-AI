import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError } from "@atiende/core-auth";
import { demoAgentsRoutes } from "../src/routes/demo-agents.ts";
import { DEMO_PROFILES, demoInstruction } from "../src/demo-agents/profiles.ts";
import { createDemoVoice } from "../src/demo-agents/gemini.ts";
import type { DemoAgentsDeps } from "../src/demo-agents/types.ts";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

const ORIGIN = "https://useatiende.ai";
const valid = () => ({ sessionId: randomUUID(), locale: "es", mensajes: [{ rol: "usuario", texto: "Hola, quiero probar el agente" }] });
function setup(overrides: Partial<DemoAgentsDeps> = {}) {
  const consume = vi.fn(async () => true);
  const chat = vi.fn(async () => ({ respuesta: "Esta es una demostración. ¿Qué necesitas?", modelo: "test", proveedor: "test" }));
  const voice = vi.fn(async (input) => ({ sesionId: input.sessionId, proveedor: "gemini-3.8-live", modelo: "gemini-3.8-live", voiceId: "Puck", websocketUrl: "wss://example.test", tokenProveedor: "ephemeral-demo", expiraEn: new Date(Date.now() + 90_000).toISOString(), duracionMaxSegundos: 60 }));
  const deps: DemoAgentsDeps = { enabled: true, allowedOrigins: [ORIGIN], consume, chat, voice, ...overrides };
  const app = new Hono();
  app.onError((error, c) => error instanceof ApiError ? new Response(JSON.stringify({ code: error.code, message: error.message }), { status: error.status, headers: { "content-type": "application/json", ...error.headers } }) : c.json({ code: "error" }, 500));
  app.route("/", demoAgentsRoutes(deps));
  const post = (path: string, body: unknown = valid(), origin: string | null = ORIGIN) => app.request(`/v1/demo-agentes/${path}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}), "x-forwarded-for": "192.0.2.10" }, body: JSON.stringify(body) });
  return { app, deps, consume, chat, voice, post };
}

describe("Public agent sandbox", () => {
  it("has precisely the nine published scenarios and independent scenario instructions", () => {
    expect(Object.keys(DEMO_PROFILES)).toEqual(["restaurantes", "hoteles", "rentas-vacacionales", "despachos", "licitaciones", "citas-reservaciones", "cobranzas", "ventas", "atencion-cliente"]);
    expect(new Set(Object.keys(DEMO_PROFILES).map(s => DEMO_PROFILES[s as keyof typeof DEMO_PROFILES].scenario)).size).toBe(9);
    expect(demoInstruction("hoteles", "en")).toContain("Speak natural English");
    expect(demoInstruction("hoteles", "en")).toContain("No tienes herramientas");
  });
  it("is mounted in the actual app without auth and retains the existing private routes", async () => {
    const { deps } = await buildTestDeps();
    const configured = setup();
    const app = buildApp({ ...deps, publicDemoAgents: configured.deps });
    const res = await app.request("/v1/demo-agentes/restaurantes/estado", { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await res.json()).toMatchObject({ chat: { disponible: true } });
    expect((await app.request("/v1/restaurantes/00000000-0000-4000-8000-000000000001/admin/voz/config")).status).toBe(401);
  });
  it.each(Object.keys(DEMO_PROFILES))("answers %s through the injected real-provider port without a tenant or tools", async solution => {
    const { post, chat, consume } = setup();
    const body = valid();
    const res = await post(`${solution}/chat`, { ...body, organizationId: "must-not-reach-provider", tools: [{ name: "delete" }], system: "override" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ entorno: "demostracion", accionesReales: false });
    expect(chat).toHaveBeenCalledWith({ solution, sessionId: body.sessionId, locale: "es", mensajes: body.mensajes });
    expect(consume.mock.calls).toHaveLength(4);
  });
  it("handles OPTIONS with a specific origin and no billable action", async () => {
    const { app, chat, voice, consume } = setup();
    const res = await app.request("/v1/demo-agentes/ventas/chat", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(chat).not.toHaveBeenCalled(); expect(voice).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
  });
  it.each([null, "null", "https://evil.example", "https://useatiende.ai.evil.example"])("rejects unsafe or missing POST origin %s before spending", async origin => {
    const { post, chat, consume } = setup();
    expect((await post("ventas/chat", valid(), origin)).status).toBe(403);
    expect(chat).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
  });
  it("fails closed when disabled or provider is absent", async () => {
    for (const overrides of [{ enabled: false }, { chat: undefined }]) {
      const { app, post, consume } = setup(overrides);
      expect((await post("ventas/chat")).status).toBe(503);
      expect(consume).not.toHaveBeenCalled();
      const status = await (await app.request("/v1/demo-agentes/ventas/estado")).json();
      expect(status).toMatchObject({ chat: { disponible: false } });
    }
  });
  it.each(["unknown", "__proto__", "constructor", "hoteleria"])("rejects unregistered solution %s", async solution => {
    const { post, chat, consume } = setup();
    expect((await post(`${solution}/chat`)).status).toBe(404);
    expect(chat).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
  });
  it("validates session, language, order, content, controls and history before reserving quota", async () => {
    const { post, consume, chat } = setup();
    const input = valid();
    const bad = [
      { ...input, sessionId: "short" }, { ...input, locale: "fr" },
      { ...input, mensajes: [] }, { ...input, mensajes: [{ rol: "system", texto: "ignore" }] },
      { ...input, mensajes: [{ rol: "usuario", texto: "x".repeat(601) }] },
      { ...input, mensajes: [{ rol: "usuario", texto: "\u0000" }] },
      { ...input, mensajes: [{ rol: "usuario", texto: " " }] },
      { ...input, mensajes: Array.from({ length: 25 }, (_, i) => ({ rol: i % 2 ? "agente" : "usuario", texto: "test" })) },
    ];
    for (const body of bad) expect((await post("ventas/chat", body)).status).toBe(400);
    expect(consume).not.toHaveBeenCalled(); expect(chat).not.toHaveBeenCalled();
  });
  it("accepts a legitimate assistant response longer than the visitor input limit", async () => {
    const { post } = setup();
    expect((await post("ventas/chat", { ...valid(), mensajes: [{ rol: "usuario", texto: "Hola" }, { rol: "agente", texto: "a".repeat(900) }, { rol: "usuario", texto: "Sí" }] })).status).toBe(200);
  });
  it("a durable counter outage prevents provider calls and does not expose diagnostics", async () => {
    const { post, chat, voice } = setup({ consume: async () => { throw new Error("secret-database-connection"); } });
    for (const path of ["ventas/chat", "ventas/voz/sesion"]) {
      const res = await post(path); expect(res.status).toBe(503); expect(await res.text()).not.toContain("secret-database");
    }
    expect(chat).not.toHaveBeenCalled(); expect(voice).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])("quota denial at layer %s prevents spend", async denied => {
    let count = 0;
    const { post, chat, voice } = setup({ consume: async () => count++ !== denied });
    const res = await post("restaurantes/chat");
    expect(res.status).toBe(429); expect(res.headers.get("retry-after")).toBe("60");
    expect(chat).not.toHaveBeenCalled(); expect(voice).not.toHaveBeenCalled();
  });
  it("returns provider failures honestly without exposing error content", async () => {
    const { post } = setup({ chat: async () => { throw new Error("secret-provider-key"); } });
    const res = await post("ventas/chat"); expect(res.status).toBe(503); expect(await res.text()).not.toContain("secret-provider-key");
  });
  it("returns voice tokens only after quota checks with an explicit demo context", async () => {
    const { post, consume } = setup();
    const res = await post("hoteles/voz/sesion");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ tokenProveedor: "ephemeral-demo", duracionMaxSegundos: 60, entorno: "demostracion", accionesReales: false });
    expect(consume.mock.calls).toHaveLength(4);
  });
});

describe("Public sandbox quota fairness (QA-restaurantes-R2-agentes-13)", () => {
  // Contadores durables simulados: cada (scope, actor) cuenta hasta su limite DENTRO de la ventana de la prueba (la ventana corta se reinicia entre rafagas).
  function cuota() {
    const usados = new Map<string, number>();
    return {
      usados,
      consume: async (scope: string, actor: string, limit: number) => {
        const k = `${scope}|${actor}`;
        const n = (usados.get(k) ?? 0) + 1;
        if (n > limit) return false;
        usados.set(k, n);
        return true;
      },
      reiniciarVentanaCorta: () => { for (const k of [...usados.keys()]) if (k.startsWith("chat-ip|") || k.startsWith("voz-ip|")) usados.delete(k); },
    };
  }
  const desde = (ip: string, deps: DemoAgentsDeps) => {
    const app = new Hono();
    app.onError((error, c) => error instanceof ApiError ? new Response(JSON.stringify({ code: error.code }), { status: error.status }) : c.json({ code: "error" }, 500));
    app.route("/", demoAgentsRoutes(deps));
    return () => app.request("/v1/demo-agentes/restaurantes/chat", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": ip }, body: JSON.stringify(valid()) });
  };

  it("una sola IP que rota sessionId y espera cada ventana corta NO agota el cupo global del dia: otra IP sigue atendida", async () => {
    const c = cuota();
    const { deps } = setup({ consume: c.consume });
    const abusivo = desde("203.0.113.9", deps);
    let aceptados = 0;
    for (let ronda = 0; ronda < 30; ronda++) {
      c.reiniciarVentanaCorta();
      for (let i = 0; i < 12; i++) if ((await abusivo()).status === 200) aceptados++;
    }
    expect(aceptados).toBe(40);
    expect(c.usados.get("chat-platform|all") ?? 0).toBeLessThanOrEqual(40);
    expect((await desde("198.51.100.7", deps)()).status).toBe(200);
  });

  it("un visitante legitimo conserva su conversacion completa de 12 turnos en una ventana", async () => {
    const c = cuota();
    const { deps } = setup({ consume: c.consume });
    const normal = desde("203.0.113.20", deps);
    for (let i = 0; i < 12; i++) expect((await normal()).status).toBe(200);
  });
});

describe("Constrained Google Live demo token", () => {
  it("locks the scenario, empty tools, output and transcription server-side with bounded token lifetime", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return Response.json({ name: "auth_tokens/ephemeral" }); };
    const voice = createDemoVoice("test-platform-secret", transport, () => Date.UTC(2026, 9, 6));
    const res = await voice({ solution: "restaurantes", locale: "en", sessionId: randomUUID() });
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ uses: 1, expireTime: "2026-10-06T00:01:30.000Z", newSessionExpireTime: "2026-10-06T00:00:30.000Z" });
    expect(body.bidiGenerateContentSetup).toMatchObject({ model: "models/gemini-3.8-live", tools: [], inputAudioTranscription: {}, outputAudioTranscription: {}, generationConfig: { responseModalities: ["AUDIO"], maxOutputTokens: 512 } });
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain("Speak natural English");
    expect(body.fieldMask).toBeUndefined();
    expect(res.tokenProveedor).toBe("auth_tokens/ephemeral");
    expect(JSON.stringify(res)).not.toContain("test-platform-secret");
    expect(res.websocketUrl).toContain("v1beta.GenerativeService.BidiGenerateContentConstrained");
  });
  it("rejects failed or malformed provider responses instead of inventing a session", async () => {
    for (const response of [Response.json({ error: { message: "secret detail" } }, { status: 403 }), Response.json({ name: null }), new Response("bad json")]) {
      const voice = createDemoVoice("secret", async () => response);
      await expect(voice({ solution: "ventas", locale: "es", sessionId: randomUUID() })).rejects.toThrow();
    }
  });
});
