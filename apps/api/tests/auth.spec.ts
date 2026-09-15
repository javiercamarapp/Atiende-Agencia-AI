import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

describe("POST /auth/login", () => {
  it("200 con credenciales correctas, devuelve token+refreshToken+organizations", async () => {
    const { deps, ownerEmail, ownerPassword, organizationId } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; refreshToken: string; organizations: Array<{ id: string; rol: string }> };
    expect(body.token).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.organizations).toEqual([expect.objectContaining({ id: organizationId, rol: "owner" })]);
  });

  it("401 con contraseña incorrecta, mismo mensaje genérico que 'correo no existe' (no filtra cuál fue)", async () => {
    const { deps, ownerEmail } = await buildTestDeps();
    const app = buildApp(deps);
    const wrongPassword = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: "incorrecta" }));
    const noExiste = await app.request("/auth/login", jsonRequestInit({ email: "no-existe@x.mx", password: "lo-que-sea" }));
    expect(wrongPassword.status).toBe(401);
    expect(noExiste.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await noExiste.json());
  });

  it("400 con email mal formado o password vacío", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    expect((await app.request("/auth/login", jsonRequestInit({ email: "no-es-un-email", password: "x" }))).status).toBe(400);
    expect((await app.request("/auth/login", jsonRequestInit({ email: "a@b.com", password: "" }))).status).toBe(400);
  });
});

describe("POST /auth/refresh + GET /auth/me", () => {
  it("un refreshToken válido reemite sesión; el token nuevo funciona en /auth/me", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    const login = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    const { refreshToken } = (await login.json()) as { refreshToken: string };

    const refreshed = await app.request("/auth/refresh", jsonRequestInit({ refreshToken }));
    expect(refreshed.status).toBe(200);
    const { token } = (await refreshed.json()) as { token: string };

    const me = await app.request("/auth/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { email: string };
    expect(meBody.email).toBe(ownerEmail);
  });

  it("401 con un refreshToken inválido/con otro secreto", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/auth/refresh", jsonRequestInit({ refreshToken: "esto-no-es-un-jwt-real" }));
    expect(res.status).toBe(401);
  });

  it("GET /auth/me sin Authorization: 401", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/auth/me");
    expect(res.status).toBe(401);
  });
});

// Hallazgo de auditoría (rubro 2, autenticación y sesión, severidad ALTA: "el refresh
// token vive 30 días sin rotación") — cada uso de POST /auth/refresh revoca el
// refresh token presentado e implementa rotación real, mismo patrón que la revocación
// de POST /auth/logout (0003_refresh_token_revocation.sql), conectado esta vez al
// flujo normal de refresh en vez de a un logout explícito.
describe("POST /auth/refresh — rotación (replay rejection)", () => {
  it("un refresh token usado una segunda vez (replay) es rechazado, aunque siga sin expirar y sea criptográficamente válido", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    const login = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    const { refreshToken } = (await login.json()) as { refreshToken: string };

    const first = await app.request("/auth/refresh", jsonRequestInit({ refreshToken }));
    expect(first.status).toBe(200);
    const { refreshToken: rotatedRefreshToken } = (await first.json()) as { refreshToken: string };
    expect(rotatedRefreshToken).not.toBe(refreshToken);

    // Replay del MISMO refresh token ya usado — debe rechazarse.
    const replay = await app.request("/auth/refresh", jsonRequestInit({ refreshToken }));
    expect(replay.status).toBe(401);

    // El refresh token NUEVO emitido por la rotación sigue funcionando normal.
    const withRotated = await app.request("/auth/refresh", jsonRequestInit({ refreshToken: rotatedRefreshToken }));
    expect(withRotated.status).toBe(200);
  });
});

// Hallazgo de auditoría (rubro 2, severidad ALTA: "no hay forma de invalidar
// sesiones activas de un usuario, ej. tras cambio de contraseña o sospecha de
// compromiso") — ver packages/db/migrations/0006_revoke_all_sessions.sql.
describe("POST /auth/revoke-sessions", () => {
  it("cierra TODOS los refresh tokens del usuario autenticado (self-service, sin enumerar cada jti)", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);

    // Dos sesiones distintas del mismo usuario (ej. dos dispositivos).
    const sesionA = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    const { refreshToken: refreshA, token: accessA } = (await sesionA.json()) as { refreshToken: string; token: string };
    const sesionB = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    const { refreshToken: refreshB } = (await sesionB.json()) as { refreshToken: string };

    // Antes de revocar, ambas sesiones refrescan normal.
    expect((await app.request("/auth/refresh", jsonRequestInit({ refreshToken: refreshA }))).status).toBe(200);

    const revoke = await app.request("/auth/revoke-sessions", { method: "POST", headers: { authorization: `Bearer ${accessA}` } });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ ok: true });

    // refreshA ya fue rotado por el refresh de arriba (nuevo jti) -- pero también
    // quedó emitido ANTES del corte de revoke-sessions, así que un refresh token de
    // OTRA sesión (refreshB, nunca usado) debe rechazarse igual, sin haber sido
    // tocado individualmente por jti.
    expect((await app.request("/auth/refresh", jsonRequestInit({ refreshToken: refreshB }))).status).toBe(401);
  });

  it("401 sin Authorization", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/auth/revoke-sessions", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

// Hallazgo de auditoría (rubro 2, severidad ALTA: "sin rate-limit en /auth/login,
// /auth/refresh, accept-invite -- un token robado o fuerza bruta no encuentran
// ninguna fricción"). El backend en memoria de @atiende/core-ratelimit se resetea
// antes de cada test (ver test-setup/reset-rate-limiter.ts) para que este límite no
// interfiera con el resto de la suite.
describe("rate limiting real en /auth/login, /auth/refresh, /auth/accept-invite", () => {
  it("POST /auth/login: más de 10 intentos en la misma ventana desde la misma IP+email responde 429", async () => {
    const { deps, ownerEmail } = await buildTestDeps();
    const app = buildApp(deps);

    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: "contraseña-incorrecta" }));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("POST /auth/refresh: más de 30 intentos en la misma ventana desde la misma IP responde 429", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);

    let lastStatus = 0;
    for (let i = 0; i < 31; i += 1) {
      const res = await app.request("/auth/refresh", jsonRequestInit({ refreshToken: "esto-no-es-un-jwt-real" }));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("POST /auth/accept-invite: más de 10 intentos en la misma ventana con el mismo token responde 429", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);

    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await app.request(
        "/auth/accept-invite",
        jsonRequestInit({ token: "token-inexistente-siempre-el-mismo", fullName: "Alguien", password: "password123" }),
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

// Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
// hoteles") — ver packages/db/migrations/0003_refresh_token_revocation.sql.
describe("POST /auth/logout", () => {
  it("revoca el refresh token: /auth/refresh deja de funcionar con él después", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    const login = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    const { refreshToken } = (await login.json()) as { refreshToken: string };

    // Antes de logout, el refresh token funciona normal.
    const refreshedAntes = await app.request("/auth/refresh", jsonRequestInit({ refreshToken }));
    expect(refreshedAntes.status).toBe(200);

    const logout = await app.request("/auth/logout", jsonRequestInit({ refreshToken }));
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });

    const refreshedDespues = await app.request("/auth/refresh", jsonRequestInit({ refreshToken }));
    expect(refreshedDespues.status).toBe(401);
  });

  it("no afecta refresh tokens de OTRA sesión del mismo usuario (revoca por jti, no por usuario completo)", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    const sesionA = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    const { refreshToken: refreshA } = (await sesionA.json()) as { refreshToken: string };
    const sesionB = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    const { refreshToken: refreshB } = (await sesionB.json()) as { refreshToken: string };
    expect(refreshA).not.toBe(refreshB);

    await app.request("/auth/logout", jsonRequestInit({ refreshToken: refreshA }));

    expect((await app.request("/auth/refresh", jsonRequestInit({ refreshToken: refreshA }))).status).toBe(401);
    expect((await app.request("/auth/refresh", jsonRequestInit({ refreshToken: refreshB }))).status).toBe(200);
  });

  it("es idempotente: 200 incluso con un refreshToken ya revocado, ya expirado, o directamente inválido", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    const login = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }));
    const { refreshToken } = (await login.json()) as { refreshToken: string };

    expect((await app.request("/auth/logout", jsonRequestInit({ refreshToken }))).status).toBe(200);
    // Segunda vez con el MISMO refreshToken (ya revocado) — sigue siendo 200.
    expect((await app.request("/auth/logout", jsonRequestInit({ refreshToken }))).status).toBe(200);
    // Un valor que ni siquiera es un JWT real — sigue siendo 200, sin filtrar validez.
    expect((await app.request("/auth/logout", jsonRequestInit({ refreshToken: "esto-no-es-un-jwt-real" }))).status).toBe(200);
  });

  it("400 sin refreshToken en el body", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/auth/logout", jsonRequestInit({}));
    expect(res.status).toBe(400);
  });
});
