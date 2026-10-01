// PL-09: validacion de Origin/Host en rutas de sesion -- decision pura + integracion HTTP + no-regresion.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { evaluateOrigin } from "../src/origin-guard.ts";
import type { OriginSignals } from "../src/origin-guard.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const CFG = { allowedOrigins: ["http://localhost:5173", "https://admin.atiende.example/"], appBaseUrl: "https://app.atiende.example/algo" };
const base: OriginSignals = { origin: null, referer: null, host: "api.atiende.example", forwardedHost: null, secFetchSite: null };

describe("evaluateOrigin", () => {
  it("sin senales de navegador (curl, servidor a servidor, tests): pasa", () => {
    expect(evaluateOrigin(base, CFG)).toEqual({ ok: true });
  });
  it("Origin en la allowlist (con o sin barra final) y el de APP_BASE_URL: pasan", () => {
    expect(evaluateOrigin({ ...base, origin: "http://localhost:5173" }, CFG).ok).toBe(true);
    expect(evaluateOrigin({ ...base, origin: "https://admin.atiende.example" }, CFG).ok).toBe(true);
    expect(evaluateOrigin({ ...base, origin: "https://app.atiende.example" }, CFG).ok).toBe(true);
  });
  it("mismo origen por Host o por X-Forwarded-Host: pasa aunque la allowlist no lo liste", () => {
    expect(evaluateOrigin({ ...base, origin: "https://api.atiende.example" }, CFG).ok).toBe(true);
    expect(evaluateOrigin({ ...base, host: "interno:3000", forwardedHost: "www.otro.example", origin: "https://www.otro.example" }, CFG).ok).toBe(true);
  });
  it("Origin ajeno, 'null' o malformado: rechaza", () => {
    expect(evaluateOrigin({ ...base, origin: "https://evil.example" }, CFG)).toEqual({ ok: false, reason: "origin_no_permitido" });
    expect(evaluateOrigin({ ...base, origin: "null" }, CFG)).toEqual({ ok: false, reason: "origin_null" });
    expect(evaluateOrigin({ ...base, origin: "no-es-una-url" }, CFG).ok).toBe(false);
    expect(evaluateOrigin({ ...base, origin: "javascript:alert(1)" }, CFG).ok).toBe(false);
  });
  it("host que solo CONTIENE el permitido como prefijo/sufijo no engaña a la comparacion", () => {
    expect(evaluateOrigin({ ...base, origin: "https://app.atiende.example.evil.example" }, CFG).ok).toBe(false);
    expect(evaluateOrigin({ ...base, origin: "https://evilapp.atiende.example" }, CFG).ok).toBe(false);
  });
  it("sin Origin: Referer ajeno rechaza, Referer propio pasa; Sec-Fetch-Site cross-site rechaza", () => {
    expect(evaluateOrigin({ ...base, referer: "https://evil.example/x" }, CFG)).toEqual({ ok: false, reason: "referer_no_permitido" });
    expect(evaluateOrigin({ ...base, referer: "https://app.atiende.example/login" }, CFG).ok).toBe(true);
    expect(evaluateOrigin({ ...base, secFetchSite: "cross-site" }, CFG)).toEqual({ ok: false, reason: "cross_site" });
    expect(evaluateOrigin({ ...base, secFetchSite: "same-origin" }, CFG).ok).toBe(true);
  });
  it("allowlist vacia no abre nada: solo queda el mismo origen", () => {
    expect(evaluateOrigin({ ...base, origin: "https://evil.example" }, { allowedOrigins: [] }).ok).toBe(false);
    expect(evaluateOrigin({ ...base, origin: "https://api.atiende.example" }, { allowedOrigins: [] }).ok).toBe(true);
  });
});

describe("originGuard montado en la app real", () => {
  it("POST /auth/login desde un origen ajeno: 403 uniforme, sin tocar credenciales ni emitir sesion", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "forbidden", message: "Origen no permitido" });
  });

  it("no-regresion: el login desde el origen permitido (allowlist) y desde el origen del appBaseUrl sigue dando 200", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    for (const origin of [deps.env.allowedOrigins[0]!, new URL(deps.env.appBaseUrl).origin]) {
      const res = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }, { origin }));
      expect(res.status, origin).toBe(200);
    }
  });

  it("magic link (POST iniciar), exchange-code, logout, 2FA y step-up: tambien rechazan origen ajeno", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const evil = { origin: "https://evil.example" };
    for (const [path, body] of [
      ["/auth/magic-link/iniciar", { email: "a@b.com", vertical: "restaurantes" }],
      ["/auth/exchange-code", { code: "x" }],
      ["/auth/logout", {}],
      ["/auth/2fa/confirm", { code: "123456" }],
      ["/auth/step-up", { code: "123456" }],
      ["/auth/refresh", { refreshToken: "x" }],
    ] as const) {
      expect((await app.request(path, jsonRequestInit(body, evil))).status, path).toBe(403);
    }
  });

  it("las rutas de superadmin con efectos tambien rechazan origen ajeno (antes de la autenticacion)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/superadmin/mfa/verificar", jsonRequestInit({ code: "123456" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("GET no se filtra por origen: el redirect de Google/magic-link y /auth/google/status siguen funcionando", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/auth/google/status", { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(200);
  });

  it("rutas fuera de /auth y /superadmin (webhooks, voz, cron) no pasan por la guarda", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/health", { method: "GET", headers: { origin: "https://evil.example" } });
    expect(res.status).not.toBe(403);
  });

  it("las respuestas de /auth/* salen con Cache-Control: no-store (token emitido nunca se cachea)", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    const ok = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});
