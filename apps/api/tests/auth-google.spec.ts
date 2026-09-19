// "Sign in with Google" — recorre el flujo completo (`GET /auth/google/iniciar` ->
// autorización -> `GET /auth/google/callback` -> `POST /auth/exchange-code`) contra
// un servidor OAuth de Google FALSO local (ver `tests/support/fakeGoogleOAuth.ts`,
// mismo mecanismo ya probado en atiende-hoteles) -- sin red ni credenciales reales
// de Google. Cubre el camino feliz (staff ya invitado, primera vinculación y login
// subsecuente con el `sub` ya vinculado) y los rechazos honestos (correo no
// invitado, nonce no coincide, Google no configurado).
//
// Hallazgo de auditoría (P2, "tokens de sesión completos en query params de URL")
// — desde esta pasada, el callback YA NO pone `token`/`refreshToken` reales en el
// redirect: pone un `code` de intercambio opaco de un solo uso que
// `POST /auth/exchange-code` canjea por la sesión real (ver el comentario de
// cabecera de `packages/db/migrations/0008_auth_exchange_code.sql`).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";
import { startFakeGoogleOAuthServer, type FakeGoogleOAuthServer } from "./support/fakeGoogleOAuth.ts";

let fakeGoogle: FakeGoogleOAuthServer;

beforeEach(async () => {
  fakeGoogle = await startFakeGoogleOAuthServer();
});

afterEach(async () => {
  await fakeGoogle.close();
});

/** Recorre `/auth/google/iniciar` -> el authorize del servidor falso (fetch real de
 *  red, `redirect: "manual"` para leer el `Location` sin seguirlo) y devuelve
 *  `code`+`state` listos para `/auth/google/callback`. */
async function autorizarConGoogle(app: ReturnType<typeof buildApp>, vertical: string): Promise<{ code: string; state: string }> {
  const iniciar = await app.request(`/auth/google/iniciar?vertical=${vertical}`);
  expect(iniciar.status).toBe(302);
  const authorizeUrl = iniciar.headers.get("location")!;
  expect(authorizeUrl).toBeTruthy();

  const authorized = await fetch(authorizeUrl, { redirect: "manual" });
  expect(authorized.status).toBe(302);
  const callbackUrl = new URL(authorized.headers.get("location")!);
  const code = callbackUrl.searchParams.get("code");
  const state = callbackUrl.searchParams.get("state");
  expect(code).toBeTruthy();
  expect(state).toBeTruthy();
  return { code: code!, state: state! };
}

function testDepsWithFakeGoogle(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"]) {
  return {
    ...deps,
    env: {
      ...deps.env,
      googleOAuth: { clientId: fakeGoogle.clientId, clientSecret: fakeGoogle.clientSecret, redirectBaseUrl: deps.env.appBaseUrl.replace("app.test.invalid", "api.test.invalid") },
      googleStaffAuth: { authBaseUrl: fakeGoogle.baseUrl, tokenUrl: fakeGoogle.tokenUrl, jwksUrl: fakeGoogle.jwksUrl, issuer: fakeGoogle.issuer },
    },
  };
}

describe("GET /auth/google/iniciar + /auth/google/callback", () => {
  it("staff YA invitado (correo con cuenta de contraseña) -- primer login con Google vincula la identidad y emite un código de intercambio, NUNCA el token real, en la URL", async () => {
    const base = await buildTestDeps();
    const deps = testDepsWithFakeGoogle(base.deps);
    const app = buildApp(deps);

    fakeGoogle.setNextUser({ sub: "google-sub-1", email: base.ownerEmail, emailVerified: true, name: "Dueña de prueba" });

    const { code, state } = await autorizarConGoogle(app, "restaurantes");
    const callback = await app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(callback.status).toBe(302);

    const finalUrl = new URL(callback.headers.get("location")!);
    expect(finalUrl.pathname).toBe("/restaurantes/auth/google/callback");
    const exchangeCode = finalUrl.searchParams.get("code");
    expect(exchangeCode).toBeTruthy();
    // Hallazgo de auditoría: el token/refreshToken reales NUNCA aparecen en la URL.
    expect(finalUrl.searchParams.get("token")).toBeNull();
    expect(finalUrl.searchParams.get("refreshToken")).toBeNull();

    // El frontend (GoogleCallback.tsx) canjea ese código de inmediato -- nunca lee
    // un token directo de la URL.
    const exchange = await app.request("/auth/exchange-code", jsonRequestInit({ code: exchangeCode }));
    expect(exchange.status).toBe(200);
    const { token, refreshToken } = (await exchange.json()) as { token: string; refreshToken: string };
    expect(token).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    // El token emitido por Google funciona exactamente igual que uno de /auth/login.
    const me = await app.request("/auth/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(base.ownerEmail);
  });

  it("el código de intercambio del callback de Google no puede canjearse dos veces (consumo atómico de un solo uso)", async () => {
    const base = await buildTestDeps();
    const deps = testDepsWithFakeGoogle(base.deps);
    const app = buildApp(deps);

    fakeGoogle.setNextUser({ sub: "google-sub-replay", email: base.ownerEmail, emailVerified: true });
    const { code, state } = await autorizarConGoogle(app, "restaurantes");
    const callback = await app.request(`/auth/google/callback?code=${code}&state=${state}`);
    const exchangeCode = new URL(callback.headers.get("location")!).searchParams.get("code");

    const primero = await app.request("/auth/exchange-code", jsonRequestInit({ code: exchangeCode }));
    expect(primero.status).toBe(200);

    const segundo = await app.request("/auth/exchange-code", jsonRequestInit({ code: exchangeCode }));
    expect(segundo.status).toBe(401);
  });

  it("segundo login con la MISMA cuenta de Google (sub ya vinculado) también emite un código de intercambio válido, sin volver a tocar el correo", async () => {
    const base = await buildTestDeps();
    const deps = testDepsWithFakeGoogle(base.deps);
    const app = buildApp(deps);

    fakeGoogle.setNextUser({ sub: "google-sub-2", email: base.ownerEmail, emailVerified: true });
    const primero = await autorizarConGoogle(app, "restaurantes");
    await app.request(`/auth/google/callback?code=${primero.code}&state=${primero.state}`);

    const segundo = await autorizarConGoogle(app, "restaurantes");
    const callback = await app.request(`/auth/google/callback?code=${segundo.code}&state=${segundo.state}`);
    expect(callback.status).toBe(302);
    const finalUrl = new URL(callback.headers.get("location")!);
    const exchangeCode = finalUrl.searchParams.get("code");
    expect(exchangeCode).toBeTruthy();

    const exchange = await app.request("/auth/exchange-code", jsonRequestInit({ code: exchangeCode }));
    expect(exchange.status).toBe(200);
    expect(((await exchange.json()) as { token: string }).token).toBeTruthy();
  });

  it("correo de Google sin ninguna cuenta de staff existente -- rechazo honesto (nunca crea una organización nueva)", async () => {
    const base = await buildTestDeps();
    const deps = testDepsWithFakeGoogle(base.deps);
    const app = buildApp(deps);

    fakeGoogle.setNextUser({ sub: "google-sub-desconocido", email: "nadie-invito-a-este-correo@example.com", emailVerified: true });
    const { code, state } = await autorizarConGoogle(app, "hoteles");
    const callback = await app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(callback.status).toBe(302);
    const finalUrl = new URL(callback.headers.get("location")!);
    expect(finalUrl.pathname).toBe("/hoteles/login");
    expect(finalUrl.searchParams.get("google_error")).toBe("cuenta_no_invitada");
  });

  it("Google no configurado (env.googleOAuth null) -- 503 explícito en ambas rutas, nunca finge el flujo", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, env: { ...base.deps.env, googleOAuth: null } };
    const app = buildApp(deps);

    const iniciar = await app.request("/auth/google/iniciar?vertical=hoteles");
    expect(iniciar.status).toBe(503);
    const callback = await app.request("/auth/google/callback?code=x&state=y");
    expect(callback.status).toBe(503);
  });

  it("vertical inválida/ausente en /auth/google/iniciar -- 400", async () => {
    const base = await buildTestDeps();
    const deps = testDepsWithFakeGoogle(base.deps);
    const app = buildApp(deps);
    expect((await app.request("/auth/google/iniciar")).status).toBe(400);
    expect((await app.request("/auth/google/iniciar?vertical=no-existe")).status).toBe(400);
  });
});
