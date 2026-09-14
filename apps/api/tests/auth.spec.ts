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
