// Voz de citas, lado PANEL: estado honesto de la escalera y sesion de vista previa. Cada caso afirma el EFECTO (que token salio, que NO se filtro).
import { describe, expect, it } from "vitest";
import type { LlmGateway } from "@atiende/agent-core";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { CitasRepository } from "@atiende/domain-citas";
import { FakeVoiceProvider, GeminiLiveProvider, VOZ_PLATAFORMA, verificarPreviewToken } from "@atiende/voice-core";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildCitasTestContext } from "./citas-fixtures.ts";

const SECRETO = "test-voice-preview-token-secret";
const LLAVE_GEMINI = "AIza-llave-de-plataforma-no-debe-salir";
const LLAVE_OPENROUTER = "sk-or-llave-de-plataforma-no-debe-salir";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Modela el guard REAL de Postgres: `consume_api_rate_limit` exige auth.uid() nulo y lanza 42501 bajo una sesion de staff. El repositorio en memoria no lo
 * aplica, asi que se envuelve el motor (para saber con que usuario abrio cada sesion) y la fabrica del repo. */
function conGuardaDeSistema(base: AppDeps, repo: CitasRepository): { deps: AppDeps; llamadas: { metodo: string; usuario: string | null }[] } {
  const usuarioDe = new WeakMap<TenantDbSession, string | null>();
  const llamadas: { metodo: string; usuario: string | null }[] = [];
  const engine = {
    withAppSession: <T,>(claims: { userId: string | null }, fn: (s: TenantDbSession) => Promise<T>) =>
      base.engine.withAppSession(claims, (session) => {
        usuarioDe.set(session, claims.userId);
        return fn(session);
      }),
  };
  const citasRepo = (db: TenantDbSession): CitasRepository =>
    new Proxy(repo, {
      get(target, prop, receiver) {
        const valor = Reflect.get(target, prop, receiver);
        if (prop !== "consumeRateLimit") return typeof valor === "function" ? valor.bind(target) : valor;
        return (...args: unknown[]) => {
          const usuario = usuarioDe.get(db) ?? null;
          llamadas.push({ metodo: String(prop), usuario });
          if (usuario !== null) throw Object.assign(new Error("consumeRateLimit: solo de sistema (auth.uid() debe ser nulo)"), { code: "42501" });
          return (valor as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return { deps: { ...base, engine: engine as unknown as AppDeps["engine"], citasRepo }, llamadas };
}

async function construir(opts: { provider?: FakeVoiceProvider | GeminiLiveProvider | null; sinSecreto?: boolean; geminiApiKey?: string | null; openrouter?: boolean; gateway?: boolean } = {}) {
  const ctx = await buildCitasTestContext(buildApp);
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
  const guardado = conGuardaDeSistema(deps, ctx.citasRepo);
  const app = buildApp(guardado.deps);
  return { ctx, deps: guardado.deps, llamadas: guardado.llamadas, app, base: `/v1/citas/properties/${ctx.propertyId}/admin/voz` };
}

describe("GET .../admin/voz/estado", () => {
  it("solo owner/admin: staff 403 y sin sesion 401", async () => {
    const { ctx, app, base } = await construir();
    expect((await app.request(`${base}/estado`, authedJson(ctx.staff.owner.token))).status).toBe(200);
    expect((await app.request(`${base}/estado`, authedJson(ctx.staff.admin.token))).status).toBe(200);
    expect((await app.request(`${base}/estado`, authedJson(ctx.staff.staffMember.token))).status).toBe(403);
    expect((await app.request(`${base}/estado`)).status).toBe(401);
  });

  it("sin ninguna credencial: escalera NO operativa, dice que falta, y la vista previa no esta disponible (con el motivo)", async () => {
    const { ctx, app, base } = await construir({ provider: null });
    const cuerpo = (await (await app.request(`${base}/estado`, authedJson(ctx.staff.owner.token))).json()) as Json;
    expect(cuerpo.escalera.operativa).toBe(false);
    expect(cuerpo.escalera.escalones.map((e: { escalon: string; configurado: boolean }) => [e.escalon, e.configurado])).toEqual([["gemini-3.8-live", false], ["cascada-openrouter", false]]);
    expect(cuerpo.preview.disponible).toBe(false);
    expect(cuerpo.preview.motivo).toContain("GEMINI_API_KEY");
  });

  it("precio por minuto: el MISMO de la config de plataforma (mismo costo para todas las verticales)", async () => {
    const { ctx, app, base } = await construir();
    const cuerpo = (await (await app.request(`${base}/estado`, authedJson(ctx.staff.owner.token))).json()) as Json;
    expect(cuerpo.precioMicroUsdPorMinuto).toEqual({ "gemini-3.8-live": VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto, "cascada-openrouter": VOZ_PLATAFORMA.cascada.precioMicroUsdPorMinuto });
  });

  it("con las dos llaves y el gateway: ambos escalones configurados, y NUNCA se devuelve una llave ni el secreto de tools", async () => {
    const { ctx, app, base } = await construir({ provider: new GeminiLiveProvider({ apiKey: LLAVE_GEMINI }), geminiApiKey: LLAVE_GEMINI, openrouter: true, gateway: true });
    const texto = JSON.stringify(await (await app.request(`${base}/estado`, authedJson(ctx.staff.owner.token))).json());
    const cuerpo = JSON.parse(texto) as Json;
    expect(cuerpo.escalera.operativa).toBe(true);
    expect(cuerpo.escalera.escalones.every((e: { configurado: boolean }) => e.configurado)).toBe(true);
    expect(cuerpo.preview).toEqual({ disponible: true, motivo: null });
    for (const secreto of [LLAVE_GEMINI, LLAVE_OPENROUTER, "test-voice-tool-secret", SECRETO]) expect(texto).not.toContain(secreto);
  });

  it("solo OpenRouter + gateway: la escalera es operativa (cascada) pero la vista previa NO (el navegador solo habla con Gemini)", async () => {
    const { ctx, app, base } = await construir({ provider: null, openrouter: true, gateway: true });
    const cuerpo = (await (await app.request(`${base}/estado`, authedJson(ctx.staff.owner.token))).json()) as Json;
    expect(cuerpo.escalera.operativa).toBe(true);
    expect(cuerpo.preview.disponible).toBe(false);
  });
});

describe("POST .../admin/voz/preview/sesion", () => {
  it("emite el token efimero del proveedor + el token propio firmado, ligado a organizacion, sucursal y sesion; el prompt es el del agente de citas", async () => {
    const { ctx, app, base, deps } = await construir();
    const res = await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, { voiceId: "Puck" }));
    expect(res.status).toBe(201);
    const c = (await res.json()) as Json;
    expect(c).toMatchObject({ voiceId: "Puck", proveedor: "fake" });
    expect(c.tokenProveedor).toContain("fake-token-");
    expect(verificarPreviewToken(SECRETO, c.tokenPreview, new Date(), { sessionId: c.sesionId, organizationId: ctx.organizationId, propertyId: ctx.propertyId })).toMatchObject({ ok: true });
    expect(verificarPreviewToken(SECRETO, c.tokenPreview, new Date(), { propertyId: "00000000-0000-4000-8000-000000000099" })).toEqual({ ok: false, razon: "ligadura" });
    expect(verificarPreviewToken(SECRETO, c.tokenPreview, new Date(Date.now() + 301_000))).toEqual({ ok: false, razon: "expirado" });
    const emitida = (deps.voiceProvider as FakeVoiceProvider).emitidas[0]!;
    expect(emitida.comportamiento).toContain("Clínica Dental Sonrisas");
    expect(emitida.comportamiento).toContain("asistente automático");
    expect(emitida.propertyId).toBe(ctx.propertyId);
  });

  it("el rate limit se consume en una sesion de SISTEMA (usuario nulo) y al agotar el cupo responde 429", async () => {
    const { ctx, app, base, llamadas } = await construir();
    const primero = await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, {}));
    expect(primero.status).toBe(201);
    expect(llamadas.filter((l) => l.metodo === "consumeRateLimit")).toEqual([{ metodo: "consumeRateLimit", usuario: null }]);
    let ultimo = 0;
    for (let i = 0; i < 25; i++) ultimo = (await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, {}))).status;
    expect(ultimo).toBe(429);
  });

  it("voz por omision (Kore) y voz fuera del catalogo 400", async () => {
    const { ctx, app, base } = await construir();
    expect(((await (await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, {}))).json()) as { voiceId: string }).voiceId).toBe("Kore");
    expect((await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, { voiceId: "No-Existe" }))).status).toBe(400);
    expect((await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, { voiceId: 7 }))).status).toBe(400);
  });

  it("solo owner/admin: staff 403 y sin sesion 401", async () => {
    const { ctx, app, base } = await construir();
    expect((await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.staffMember.token, {}))).status).toBe(403);
    expect((await app.request(`${base}/preview/sesion`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(401);
  });

  it("sin proveedor, con el proveedor sin credencial o sin VOICE_PREVIEW_TOKEN_SECRET: 503 honesto, nunca un falso exito", async () => {
    const sinProveedor = await construir({ provider: null });
    expect((await sinProveedor.app.request(`${sinProveedor.base}/preview/sesion`, authedJson(sinProveedor.ctx.staff.owner.token, {}))).status).toBe(503);
    const sinCredencial = await construir({ provider: new GeminiLiveProvider({ apiKey: "" }) });
    expect((await sinCredencial.app.request(`${sinCredencial.base}/preview/sesion`, authedJson(sinCredencial.ctx.staff.owner.token, {}))).status).toBe(503);
    const sinSecreto = await construir({ sinSecreto: true });
    const res = await sinSecreto.app.request(`${sinSecreto.base}/preview/sesion`, authedJson(sinSecreto.ctx.staff.owner.token, {}));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("VOICE_PREVIEW_TOKEN_SECRET");
  });
});
