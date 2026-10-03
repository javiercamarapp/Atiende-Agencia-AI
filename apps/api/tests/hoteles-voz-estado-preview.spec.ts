// Voz de hoteles, lado PANEL: estado honesto de la escalera y sesion de vista previa. Cada caso afirma el EFECTO (que token salio, que NO se filtro).
import { describe, expect, it } from "vitest";
import { FakeVoiceProvider, GeminiLiveProvider, VOZ_PLATAFORMA, verificarPreviewToken } from "@atiende/voice-core";
import type { LlmGateway } from "@atiende/agent-core";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";

const SECRETO = "test-voice-preview-token-secret";
const LLAVE_GEMINI = "AIza-llave-de-plataforma-no-debe-salir";
const LLAVE_OPENROUTER = "sk-or-llave-de-plataforma-no-debe-salir";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
const envolver = (app: ReturnType<typeof buildApp>) => ({ request: (i: string, init?: RequestInit) => Promise.resolve(app.request(i, init)) as Promise<Resp> });

async function construir(
  opts: { provider?: FakeVoiceProvider | GeminiLiveProvider | null; sinSecreto?: boolean; geminiApiKey?: string | null; openrouter?: boolean; gateway?: boolean } = {},
) {
  const ctx = await buildHotelesTestContext(buildApp);
  const provider = opts.provider === undefined ? new FakeVoiceProvider() : opts.provider;
  const deps: AppDeps = {
    ...ctx.deps,
    ...(provider ? { voiceProvider: provider } : { voiceProvider: undefined }),
    ...(opts.gateway ? { llmGateway: {} as LlmGateway } : {}),
    env: {
      ...ctx.deps.env,
      voicePreviewTokenSecret: opts.sinSecreto ? null : SECRETO,
      geminiApiKey: opts.geminiApiKey ?? null,
      llmProviders: { ...ctx.deps.env.llmProviders, openrouter: opts.openrouter ? { apiKey: LLAVE_OPENROUTER, countryOfResidence: null, modelsJson: null, zdr: false, sharedBreaker: null, breakerEnv: "test" } : null },
    },
  };
  return { ctx, deps, app: envolver(buildApp(deps)), base: `/hoteles/${ctx.propertyId}/voz` };
}

describe("GET /hoteles/:propertyId/voz/estado", () => {
  it("solo owner/gm: frontdesk 403 y sin sesion 401", async () => {
    const { ctx, app, base } = await construir();
    expect((await app.request(`${base}/estado`, authedJson(ctx.staff.frontdesk.token))).status).toBe(403);
    expect((await app.request(`${base}/estado`)).status).toBe(401);
  });

  it("sin ninguna credencial: escalera NO operativa, dice que falta, y la vista previa no esta disponible (con el motivo)", async () => {
    const { ctx, app, base } = await construir({ provider: null });
    const res = await app.request(`${base}/estado`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.agente).toEqual({ configurado: false, habilitado: false });
    expect(cuerpo.escalera.operativa).toBe(false);
    expect(cuerpo.escalera.escalones.map((e: { escalon: string; configurado: boolean }) => [e.escalon, e.configurado])).toEqual([["gemini-3.8-live", false], ["cascada-openrouter", false]]);
    expect(cuerpo.preview.disponible).toBe(false);
    expect(cuerpo.preview.motivo).toContain("GEMINI_API_KEY");
  });

  it("precio por minuto: el MISMO de la config de plataforma (mismo costo para todas las verticales)", async () => {
    const { ctx, app, base } = await construir();
    const cuerpo = await (await app.request(`${base}/estado`, authedJson(ctx.staff.owner.token))).json();
    expect(cuerpo.precioMicroUsdPorMinuto).toEqual({ "gemini-3.8-live": VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto, "cascada-openrouter": VOZ_PLATAFORMA.cascada.precioMicroUsdPorMinuto });
  });

  it("con las dos llaves y el gateway: ambos escalones configurados, y NUNCA se devuelve una llave ni el secreto de tools", async () => {
    const { ctx, app, base } = await construir({ provider: new GeminiLiveProvider({ apiKey: LLAVE_GEMINI }), geminiApiKey: LLAVE_GEMINI, openrouter: true, gateway: true });
    await ctx.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, "secreto-de-tools-de-la-property", true);
    const res = await app.request(`${base}/estado`, authedJson(ctx.staff.owner.token));
    const texto = JSON.stringify(await res.json());
    const cuerpo = JSON.parse(texto);
    expect(cuerpo.agente).toEqual({ configurado: true, habilitado: true });
    expect(cuerpo.escalera.operativa).toBe(true);
    expect(cuerpo.escalera.escalones.every((e: { configurado: boolean }) => e.configurado)).toBe(true);
    expect(cuerpo.preview).toEqual({ disponible: true, motivo: null });
    for (const secreto of [LLAVE_GEMINI, LLAVE_OPENROUTER, "secreto-de-tools-de-la-property", SECRETO]) expect(texto).not.toContain(secreto);
  });

  it("solo OpenRouter + gateway: la escalera es operativa (cascada) pero la vista previa NO (el navegador solo habla con Gemini)", async () => {
    const { ctx, app, base } = await construir({ provider: null, openrouter: true, gateway: true });
    const cuerpo = await (await app.request(`${base}/estado`, authedJson(ctx.staff.owner.token))).json();
    expect(cuerpo.escalera.operativa).toBe(true);
    expect(cuerpo.preview.disponible).toBe(false);
  });
});

describe("POST /hoteles/:propertyId/voz/preview/sesion", () => {
  it("emite el token efimero del proveedor + el token propio firmado, ligado a organizacion, property y sesion", async () => {
    const { ctx, app, base, deps } = await construir();
    const res = await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, { voiceId: "Puck" }));
    expect(res.status).toBe(201);
    const c = await res.json();
    expect(c).toMatchObject({ voiceId: "Puck", proveedor: "fake" });
    expect(c.tokenProveedor).toContain("fake-token-");
    expect(verificarPreviewToken(SECRETO, c.tokenPreview, new Date(), { sessionId: c.sesionId, organizationId: ctx.organizationId, propertyId: ctx.propertyId })).toMatchObject({ ok: true });
    // ligado: un token de OTRA property u organizacion se rechaza aunque la firma sea valida
    expect(verificarPreviewToken(SECRETO, c.tokenPreview, new Date(), { propertyId: "00000000-0000-4000-8000-000000000099" })).toEqual({ ok: false, razon: "ligadura" });
    expect(verificarPreviewToken(SECRETO, c.tokenPreview, new Date(Date.now() + 301_000))).toEqual({ ok: false, razon: "expirado" });
    // el prompt del agente de hoteles viaja al proveedor, con la reglas duras y el nombre del hotel
    const emitida = (deps.voiceProvider as FakeVoiceProvider).emitidas[0]!;
    expect(emitida.comportamiento).toContain("NO existe ningún descuento");
    expect(emitida.comportamiento).toContain("Hotel de Prueba");
    expect(emitida.propertyId).toBe(ctx.propertyId);
  });

  it("voz por omision (Kore) y voz fuera del catalogo 400", async () => {
    const { ctx, app, base } = await construir();
    expect(((await (await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, {}))).json()) as { voiceId: string }).voiceId).toBe("Kore");
    expect((await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, { voiceId: "No-Existe" }))).status).toBe(400);
    expect((await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, { voiceId: 7 }))).status).toBe(400);
  });

  it("solo owner/gm: frontdesk 403 y sin sesion 401", async () => {
    const { ctx, app, base } = await construir();
    expect((await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.frontdesk.token, {}))).status).toBe(403);
    expect((await app.request(`${base}/preview/sesion`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(401);
  });

  it("sin proveedor, con el proveedor sin credencial o sin VOICE_PREVIEW_TOKEN_SECRET: 503 honesto, nunca un falso exito", async () => {
    for (const opts of [{ provider: null }, { provider: new FakeVoiceProvider({ configurado: false }) }, { sinSecreto: true }] as const) {
      const { ctx, app, base } = await construir(opts);
      const res = await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, {}));
      expect(res.status).toBe(503);
    }
  });

  it("el proveedor falla al emitir: 503 con mensaje generico (sin detalle del proveedor)", async () => {
    const { ctx, app, base } = await construir({ provider: new FakeVoiceProvider({ fallaAlEmitir: true }) });
    const res = await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("falso");
  });
});
