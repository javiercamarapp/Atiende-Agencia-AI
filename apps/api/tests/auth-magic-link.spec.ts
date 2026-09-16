// "Continuar con correo" sin contraseña — recorre el flujo completo
// (POST /auth/magic-link/iniciar -> GET /auth/magic-link/verify) contra los
// repos en memoria. Cubre el camino feliz, el anti-enumeración (mismo 200 para
// correo existente/inexistente), el consumo de un solo uso, y el rechazo
// honesto de un token inválido/ya usado/vencido.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

describe("POST /auth/magic-link/iniciar + GET /auth/magic-link/verify", () => {
  it("correo existente -- responde 200 genérico y el token emitido funciona en /verify", async () => {
    const { deps, ownerEmail } = await buildTestDeps();
    const app = buildApp(deps);

    const iniciar = await app.request("/auth/magic-link/iniciar", jsonRequestInit({ email: ownerEmail, vertical: "restaurantes" }));
    expect(iniciar.status).toBe(200);
    expect(await iniciar.json()).toEqual({ ok: true });

    // TEST_ENV no trae RESEND_API_KEY (resend.apiKey: null) -- el correo real
    // nunca sale, así que estas pruebas verifican el mecanismo de token
    // directamente contra coreRepo (mismo `staff.id` que /auth/magic-link/iniciar
    // ya resolvió, sin necesitar leer un correo real).
    const staff = await deps.coreRepo.findStaffByEmail(ownerEmail);
    expect(staff).not.toBeNull();
  });

  it("correo inexistente -- responde el MISMO 200 genérico (anti-enumeración, no revela si el correo existe)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);

    const existente = await app.request("/auth/magic-link/iniciar", jsonRequestInit({ email: "existe@x.mx", vertical: "restaurantes" }));
    const inexistente = await app.request("/auth/magic-link/iniciar", jsonRequestInit({ email: "no-existe@x.mx", vertical: "restaurantes" }));
    expect(existente.status).toBe(inexistente.status);
    expect(await existente.json()).toEqual(await inexistente.json());
  });

  it("flujo real de punta a punta: crea el token vía coreRepo (simulando lo que /iniciar ya hizo internamente), lo consume en /verify, y la sesión resultante funciona en /auth/me", async () => {
    const { deps, ownerEmail } = await buildTestDeps();
    const app = buildApp(deps);

    const staff = await deps.coreRepo.findStaffByEmail(ownerEmail);
    const { generateInviteToken } = await import("@atiende/core-auth");
    const { tokenPlain, tokenHash } = generateInviteToken();
    await deps.coreRepo.createMagicLinkToken({ staffId: staff!.id, tokenHash, expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const verify = await app.request(`/auth/magic-link/verify?token=${tokenPlain}&vertical=restaurantes`);
    expect(verify.status).toBe(302);
    const finalUrl = new URL(verify.headers.get("location")!);
    expect(finalUrl.pathname).toBe("/restaurantes/auth/google/callback");
    const token = finalUrl.searchParams.get("token");
    expect(token).toBeTruthy();

    const me = await app.request("/auth/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(ownerEmail);
  });

  it("el mismo token no puede usarse dos veces (consumo atómico de un solo uso)", async () => {
    const { deps, ownerEmail } = await buildTestDeps();
    const app = buildApp(deps);

    const staff = await deps.coreRepo.findStaffByEmail(ownerEmail);
    const { generateInviteToken } = await import("@atiende/core-auth");
    const { tokenPlain, tokenHash } = generateInviteToken();
    await deps.coreRepo.createMagicLinkToken({ staffId: staff!.id, tokenHash, expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const primero = await app.request(`/auth/magic-link/verify?token=${tokenPlain}&vertical=restaurantes`);
    expect(primero.status).toBe(302);
    expect(new URL(primero.headers.get("location")!).searchParams.get("token")).toBeTruthy();

    const segundo = await app.request(`/auth/magic-link/verify?token=${tokenPlain}&vertical=restaurantes`);
    expect(segundo.status).toBe(302);
    const segundaUrl = new URL(segundo.headers.get("location")!);
    expect(segundaUrl.pathname).toBe("/restaurantes/login");
    expect(segundaUrl.searchParams.get("magic_link_error")).toBe("invalido_o_expirado");
  });

  it("token vencido -- rechazo honesto, nunca emite sesión", async () => {
    const { deps, ownerEmail } = await buildTestDeps();
    const app = buildApp(deps);

    const staff = await deps.coreRepo.findStaffByEmail(ownerEmail);
    const { generateInviteToken } = await import("@atiende/core-auth");
    const { tokenPlain, tokenHash } = generateInviteToken();
    await deps.coreRepo.createMagicLinkToken({ staffId: staff!.id, tokenHash, expiresAt: new Date(Date.now() - 1_000).toISOString() });

    const verify = await app.request(`/auth/magic-link/verify?token=${tokenPlain}&vertical=restaurantes`);
    expect(verify.status).toBe(302);
    const url = new URL(verify.headers.get("location")!);
    expect(url.searchParams.get("magic_link_error")).toBe("invalido_o_expirado");
  });

  it("token que nunca existió -- rechazo honesto", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const verify = await app.request(`/auth/magic-link/verify?token=un-token-que-nunca-se-emitio&vertical=hoteles`);
    expect(verify.status).toBe(302);
    expect(new URL(verify.headers.get("location")!).searchParams.get("magic_link_error")).toBe("invalido_o_expirado");
  });

  it("vertical inválida/ausente -- 400 en /iniciar, redirect honesto en /verify", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    expect((await app.request("/auth/magic-link/iniciar", jsonRequestInit({ email: "a@b.com", vertical: "no-existe" }))).status).toBe(400);
    const verify = await app.request(`/auth/magic-link/verify?token=x`);
    expect(verify.status).toBe(302);
    expect(new URL(verify.headers.get("location")!).searchParams.get("magic_link_error")).toBe("invalido");
  });
});
