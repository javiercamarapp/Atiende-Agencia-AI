// L-02 -- sesiones activas (listar, cerrar una, cerrar todas las demas), estado de la cuenta y
// desvinculacion de Google, por HTTP real contra los repos en memoria (misma semantica que 0033).
import { afterEach, describe, expect, it, vi } from "vitest";
import { signRefreshToken } from "@atiende/core-auth";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

afterEach(() => vi.unstubAllGlobals());

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  const raw = JSON.stringify(body);
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), ...headers } };
}

async function setup() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const core = ctx.deps.coreRepo as InMemoryCoreRepository;
  const security = new InMemoryStaffSecurityRepository(core);
  const deps = { ...ctx.deps, staffSecurityRepo: security, env: { ...TEST_ENV } };
  return { ctx, core, security, app: buildApp(deps) };
}

async function login(app: ReturnType<typeof buildApp>, email: string, password: string, userAgent = "UA-test") {
  const res = await app.request("/auth/login", json({ email, password }, { "user-agent": userAgent }));
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; refreshToken: string };
}

type Sesion = { id: string; current: boolean; userAgent: string | null };

async function listar(app: ReturnType<typeof buildApp>, token: string, refreshToken?: string) {
  const res = await app.request("/auth/sessions/listar", authedJson(token, refreshToken ? { refreshToken } : {}));
  expect(res.status).toBe(200);
  return (await res.json()) as { available: boolean; sessions: Sesion[] };
}

describe("registro de sesiones al emitirlas", () => {
  it("login registra la sesion con su user-agent y la lista marca la actual", async () => {
    const { app, ctx } = await setup();
    const a = await login(app, ctx.staff.owner.email, ctx.staff.owner.password, "Chrome/macOS");
    const b = await login(app, ctx.staff.owner.email, ctx.staff.owner.password, "Safari/iPhone");
    const lista = await listar(app, a.token, a.refreshToken);
    expect(lista.available).toBe(true);
    expect(lista.sessions).toHaveLength(2);
    expect(lista.sessions.find((s) => s.current)?.userAgent).toBe("Chrome/macOS");
    expect(lista.sessions.filter((s) => s.current)).toHaveLength(1);
    // sin refresh token en el cuerpo, ninguna se marca como actual
    expect((await listar(app, b.token)).sessions.some((s) => s.current)).toBe(false);
  });

  it("el refresh ROTA la sesion: sigue habiendo una sola fila por dispositivo (no crece con cada refresh)", async () => {
    const { app, ctx } = await setup();
    const a = await login(app, ctx.staff.owner.email, ctx.staff.owner.password);
    const r1 = await app.request("/auth/refresh", json({ refreshToken: a.refreshToken }));
    const s1 = (await r1.json()) as { token: string; refreshToken: string };
    const r2 = await app.request("/auth/refresh", json({ refreshToken: s1.refreshToken }));
    const s2 = (await r2.json()) as { token: string; refreshToken: string };
    const lista = await listar(app, s2.token, s2.refreshToken);
    expect(lista.sessions).toHaveLength(1);
    expect(lista.sessions[0]!.current).toBe(true);
  });

  it("base sin migrar: el login sigue emitiendo sesion y la lista responde available:false (200, nunca 500)", async () => {
    const { app, ctx, security } = await setup();
    security.available = false;
    const a = await login(app, ctx.staff.owner.email, ctx.staff.owner.password);
    expect(await listar(app, a.token, a.refreshToken)).toEqual({ available: false, sessions: [] });
    const refresh = await app.request("/auth/refresh", json({ refreshToken: a.refreshToken }));
    expect(refresh.status).toBe(200);
  });

  it("si registrar la sesion falla con un error inesperado el login igual responde 200", async () => {
    const { app, ctx, security } = await setup();
    vi.spyOn(security, "registerSession").mockRejectedValue(new Error("boom"));
    expect((await app.request("/auth/login", json({ email: ctx.staff.owner.email, password: ctx.staff.owner.password }))).status).toBe(200);
  });
});

describe("POST /auth/sessions/listar y /cerrar", () => {
  it("requiere sesion", async () => {
    const { app } = await setup();
    expect((await app.request("/auth/sessions/listar", json({}))).status).toBe(401);
    expect((await app.request("/auth/sessions/cerrar", json({ sessionId: "x" }))).status).toBe(401);
    expect((await app.request("/auth/sessions/cerrar-todas", json({}))).status).toBe(401);
  });

  it("cerrar una sesion revoca su refresh token de inmediato; la otra sigue sirviendo", async () => {
    const { app, ctx } = await setup();
    const a = await login(app, ctx.staff.owner.email, ctx.staff.owner.password, "A");
    const b = await login(app, ctx.staff.owner.email, ctx.staff.owner.password, "B");
    const lista = await listar(app, a.token, a.refreshToken);
    const otra = lista.sessions.find((s) => !s.current)!;
    const res = await app.request("/auth/sessions/cerrar", authedJson(a.token, { sessionId: otra.id }));
    expect(res.status).toBe(200);
    expect((await app.request("/auth/refresh", json({ refreshToken: b.refreshToken }))).status).toBe(401);
    expect((await app.request("/auth/refresh", json({ refreshToken: a.refreshToken }))).status).toBe(200);
    // cerrar de nuevo la misma: ya no existe
    expect((await app.request("/auth/sessions/cerrar", authedJson(a.token, { sessionId: otra.id }))).status).toBe(404);
  });

  it("no se puede cerrar la sesion de OTRA cuenta (404, y esa sesion sigue viva)", async () => {
    const { app, ctx } = await setup();
    const dueña = await login(app, ctx.staff.owner.email, ctx.staff.owner.password);
    const analista = await login(app, ctx.staff.analyst.email, ctx.staff.analyst.password);
    const ajena = (await listar(app, dueña.token, dueña.refreshToken)).sessions[0]!;
    const res = await app.request("/auth/sessions/cerrar", authedJson(analista.token, { sessionId: ajena.id }));
    expect(res.status).toBe(404);
    expect((await app.request("/auth/refresh", json({ refreshToken: dueña.refreshToken }))).status).toBe(200);
    // y la lista del analista no incluye la sesion de la dueña
    expect((await listar(app, analista.token, analista.refreshToken)).sessions.map((s) => s.id)).not.toContain(ajena.id);
  });

  it("un refresh token de OTRA cuenta en el cuerpo no marca nada como actual", async () => {
    const { app, ctx } = await setup();
    const dueña = await login(app, ctx.staff.owner.email, ctx.staff.owner.password);
    const analista = await login(app, ctx.staff.analyst.email, ctx.staff.analyst.password);
    const lista = await listar(app, dueña.token, analista.refreshToken);
    expect(lista.sessions.some((s) => s.current)).toBe(false);
    const falso = await signRefreshToken(ctx.staff.owner.id, "otro-secreto", 600);
    expect((await listar(app, dueña.token, falso)).sessions.some((s) => s.current)).toBe(false);
  });

  it("sessionId mal formado -> 400; base sin migrar -> 503 al cerrar", async () => {
    const { app, ctx, security } = await setup();
    const a = await login(app, ctx.staff.owner.email, ctx.staff.owner.password);
    expect((await app.request("/auth/sessions/cerrar", authedJson(a.token, { sessionId: "no-es-uuid" }))).status).toBe(400);
    security.available = false;
    expect((await app.request("/auth/sessions/cerrar", authedJson(a.token, { sessionId: "00000000-0000-4000-8000-000000000001" }))).status).toBe(503);
    expect((await app.request("/auth/sessions/cerrar-todas", authedJson(a.token, {}))).status).toBe(503);
  });
});

describe("POST /auth/sessions/cerrar-todas", () => {
  it("corta las demas sesiones (incluidas las no registradas) y devuelve una sesion NUEVA valida para este dispositivo", async () => {
    const { app, ctx } = await setup();
    const a = await login(app, ctx.staff.owner.email, ctx.staff.owner.password, "esta");
    const b = await login(app, ctx.staff.owner.email, ctx.staff.owner.password, "otra");
    // el JWT usa segundos: asegura que las previas se emitieron en un segundo anterior al corte
    await new Promise((r) => setTimeout(r, 1100));
    const res = await app.request("/auth/sessions/cerrar-todas", authedJson(a.token, {}));
    expect(res.status).toBe(200);
    const nueva = (await res.json()) as { token: string; refreshToken: string };
    expect((await app.request("/auth/refresh", json({ refreshToken: b.refreshToken }))).status).toBe(401);
    expect((await app.request("/auth/refresh", json({ refreshToken: a.refreshToken }))).status).toBe(401);
    expect((await app.request("/auth/refresh", json({ refreshToken: nueva.refreshToken }))).status).toBe(200);
    const lista = await listar(app, nueva.token, nueva.refreshToken);
    expect(lista.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("no toca las sesiones de otras cuentas", async () => {
    const { app, ctx } = await setup();
    const dueña = await login(app, ctx.staff.owner.email, ctx.staff.owner.password);
    const analista = await login(app, ctx.staff.analyst.email, ctx.staff.analyst.password);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await app.request("/auth/sessions/cerrar-todas", authedJson(dueña.token, {}))).status).toBe(200);
    expect((await app.request("/auth/refresh", json({ refreshToken: analista.refreshToken }))).status).toBe(200);
  });
});

describe("GET /auth/account/estado", () => {
  it("devuelve correo verificado, contrasena y vinculos de Google de la propia cuenta (sin el sub)", async () => {
    const { app, ctx, core } = await setup();
    await core.linkGoogleIdentity({ staffId: ctx.staff.owner.id, sub: "sub-secreto-de-google", email: "dueña@gmail.com" });
    const res = await app.request("/auth/account/estado", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ email: ctx.staff.owner.email, emailVerified: true, hasPassword: true, google: { configured: true, available: true } });
    expect((body as { google: { identities: unknown[] } }).google.identities).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("sub-secreto-de-google");
    // el analista no ve los vinculos de la dueña
    const otro = await app.request("/auth/account/estado", { headers: { authorization: `Bearer ${ctx.staff.analyst.token}` } });
    expect(((await otro.json()) as { google: { identities: unknown[] } }).google.identities).toHaveLength(0);
  });

  it("requiere sesion; base sin migrar -> available:false con 200", async () => {
    const { app, ctx, security } = await setup();
    expect((await app.request("/auth/account/estado")).status).toBe(401);
    security.available = false;
    const res = await app.request("/auth/account/estado", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { google: { available: boolean } }).google.available).toBe(false);
  });
});

describe("POST /auth/google/desvincular", () => {
  it("exige la contrasena actual; con ella desvincula; la identidad ajena responde 404", async () => {
    const { app, ctx, core, security } = await setup();
    await core.linkGoogleIdentity({ staffId: ctx.staff.owner.id, sub: "sub-d", email: "d@gmail.com" });
    await core.linkGoogleIdentity({ staffId: ctx.staff.analyst.id, sub: "sub-e", email: "e@gmail.com" });
    const [propia] = await security.listGoogleIdentities(ctx.staff.owner.id);
    const [ajena] = await security.listGoogleIdentities(ctx.staff.analyst.id);
    const t = ctx.staff.owner.token;
    const sinClave = await app.request("/auth/google/desvincular", authedJson(t, { identityId: propia!.id }));
    expect(sinClave.status).toBe(422);
    expect(((await sinClave.json()) as { code: string }).code).toBe("current_password_invalid");
    expect((await app.request("/auth/google/desvincular", authedJson(t, { identityId: propia!.id, password: "incorrecta" }))).status).toBe(422);
    expect((await security.listGoogleIdentities(ctx.staff.owner.id))).toHaveLength(1);
    expect((await app.request("/auth/google/desvincular", authedJson(t, { identityId: ajena!.id, password: ctx.staff.owner.password }))).status).toBe(404);
    expect((await security.listGoogleIdentities(ctx.staff.analyst.id))).toHaveLength(1);
    expect((await app.request("/auth/google/desvincular", authedJson(t, { identityId: propia!.id, password: ctx.staff.owner.password }))).status).toBe(200);
    expect(await security.listGoogleIdentities(ctx.staff.owner.id)).toHaveLength(0);
    expect((await app.request("/auth/google/desvincular", authedJson(t, { identityId: "no-uuid", password: ctx.staff.owner.password }))).status).toBe(400);
  });
});
