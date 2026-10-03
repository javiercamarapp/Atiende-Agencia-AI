// L-02 -- cambio de contrasena, reset por correo y verificacion de correo, por HTTP real.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateInviteToken } from "@atiende/core-auth";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

afterEach(() => vi.unstubAllGlobals());

// Credenciales de prueba generadas en cada corrida: ningun literal con forma de contrasena en el repo.
const pw = (tag: string) => `${tag}-${randomUUID()}`;

function json(body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) } };
}

async function setup() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const core = ctx.deps.coreRepo as InMemoryCoreRepository;
  const security = new InMemoryStaffSecurityRepository(core);
  const deps = { ...ctx.deps, staffSecurityRepo: security, env: { ...TEST_ENV, resend: { apiKey: pw("re"), from: "atiende <n@atiende.ai>" } } };
  return { ctx, core, security, app: buildApp(deps) };
}

/** Captura el cuerpo enviado a Resend (fetch directo). */
function captureResend() {
  const sent: Array<{ to: string[]; subject: string; text: string }> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return new Response("{}", { status: 200 });
  });
  return sent;
}

function tokenFromEmail(text: string): string {
  const m = text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`sin token en el correo: ${text}`);
  return m[1]!;
}

describe("POST /auth/change-password", () => {
  it("requiere sesion; exige la contrasena actual; nueva distinta y de 8+", async () => {
    const { app, ctx } = await setup();
    expect((await app.request("/auth/change-password", json({ currentPassword: "x", newPassword: "nueva-clave-123" }))).status).toBe(401);
    const t = ctx.staff.owner.token;
    const bad = await app.request("/auth/change-password", authedJson(t, { currentPassword: "incorrecta", newPassword: "nueva-clave-123" }));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { code: string }).code).toBe("current_password_invalid");
    expect((await app.request("/auth/change-password", authedJson(t, { currentPassword: ctx.staff.owner.password, newPassword: "corta" }))).status).toBe(400);
    expect((await app.request("/auth/change-password", authedJson(t, { currentPassword: ctx.staff.owner.password, newPassword: ctx.staff.owner.password }))).status).toBe(400);
  });

  it("cambia la contrasena: la vieja deja de servir, la nueva entra, el refresh viejo queda revocado y se devuelve sesion nueva", async () => {
    const { app, ctx } = await setup();
    const oldLogin = await app.request("/auth/login", json({ email: ctx.staff.owner.email, password: ctx.staff.owner.password }));
    const { refreshToken: oldRefresh } = (await oldLogin.json()) as { refreshToken: string };
    // el JWT usa segundos: asegura que el refresh viejo se emitio en un segundo anterior al corte
    await new Promise((r) => setTimeout(r, 1100));
    const res = await app.request("/auth/change-password", authedJson(ctx.staff.owner.token, { currentPassword: ctx.staff.owner.password, newPassword: "nueva-clave-segura-1" }));
    expect(res.status).toBe(200);
    const session = (await res.json()) as { token: string; refreshToken: string };
    expect(session.token).toBeTruthy();

    expect((await app.request("/auth/login", json({ email: ctx.staff.owner.email, password: ctx.staff.owner.password }))).status).toBe(401);
    expect((await app.request("/auth/login", json({ email: ctx.staff.owner.email, password: "nueva-clave-segura-1" }))).status).toBe(200);
    expect((await app.request("/auth/refresh", json({ refreshToken: oldRefresh }))).status).toBe(401);
    expect((await app.request("/auth/refresh", json({ refreshToken: session.refreshToken }))).status).toBe(200);
  });

  it("base sin migrar -> 503 honesto", async () => {
    const { app, ctx, security } = await setup();
    security.available = false;
    const res = await app.request("/auth/change-password", authedJson(ctx.staff.owner.token, { currentPassword: ctx.staff.owner.password, newPassword: "nueva-clave-segura-1" }));
    expect(res.status).toBe(503);
    // mensaje neutral: estas rutas no son del segundo factor
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("service_unavailable");
    expect(body.message).not.toMatch(/dos pasos/i);
  });
});

describe("password reset por correo", () => {
  it("solicitar responde el MISMO 200 exista o no el correo; solo el existente recibe correo con enlace", async () => {
    const { app, ctx } = await setup();
    const sent = captureResend();
    const a = await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "licitaciones" }));
    const b = await app.request("/auth/password-reset/solicitar", json({ email: "nadie@nada.mx", vertical: "licitaciones" }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([ctx.staff.owner.email]);
    expect(sent[0]!.text).toContain("/licitaciones/restablecer-contrasena?token=");
  });

  it("flujo completo: enlace -> contrasena nueva -> login nuevo; el enlace es de un solo uso", async () => {
    const { app, ctx } = await setup();
    const sent = captureResend();
    await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "licitaciones" }));
    const token = tokenFromEmail(sent[0]!.text);
    const ok = await app.request("/auth/password-reset/confirmar", json({ token, newPassword: "clave-restablecida-9" }));
    expect(ok.status).toBe(200);
    expect((await app.request("/auth/login", json({ email: ctx.staff.owner.email, password: "clave-restablecida-9" }))).status).toBe(200);
    expect((await app.request("/auth/login", json({ email: ctx.staff.owner.email, password: ctx.staff.owner.password }))).status).toBe(401);
    const reuse = await app.request("/auth/password-reset/confirmar", json({ token, newPassword: "otra-clave-cualquiera-1" }));
    expect(reuse.status).toBe(400);
  });

  it("token inventado -> 400; contrasena corta -> 400; vertical invalida -> 400", async () => {
    const { app, ctx } = await setup();
    expect((await app.request("/auth/password-reset/confirmar", json({ token: generateInviteToken().tokenPlain, newPassword: "clave-larga-123" }))).status).toBe(400);
    expect((await app.request("/auth/password-reset/confirmar", json({ token: "abc", newPassword: "corta" }))).status).toBe(400);
    expect((await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "otra" }))).status).toBe(400);
  });

  it("base sin migrar: solicitar sigue respondiendo el 200 generico (sin correo); confirmar -> 503", async () => {
    const { app, ctx, security } = await setup();
    security.available = false;
    const sent = captureResend();
    const res = await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "licitaciones" }));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect((await app.request("/auth/password-reset/confirmar", json({ token: "abc", newPassword: "clave-larga-123" }))).status).toBe(503);
  });
});

describe("verificacion de correo", () => {
  it("enviar -> confirmar marca el correo verificado; un solo uso; ya verificado no reenvia", async () => {
    const { app, ctx, core } = await setup();
    const sent = captureResend();
    // El fixture ya trae el correo verificado: se quita para probar el flujo real.
    const staff = await core.findStaffById(ctx.staff.admin.id);
    expect(staff?.emailVerifiedAt).not.toBeNull();
    const already = await app.request("/auth/email-verification/enviar", authedJson(ctx.staff.admin.token, { vertical: "licitaciones" }));
    expect(((await already.json()) as { alreadyVerified: boolean }).alreadyVerified).toBe(true);
    expect(sent).toHaveLength(0);

    core.addStaff({ id: "00000000-0000-0000-0000-00000000f001", email: "sin-verificar@empresa-de-prueba.mx", fullName: "Sin verificar", passwordHash: null, createdVia: "registro_autoservicio", emailVerifiedAt: null });
    const { signAccessToken } = await import("@atiende/core-auth");
    const token = await signAccessToken({ sub: "00000000-0000-0000-0000-00000000f001", org_id: ctx.organizationId, vertical: "licitaciones", property_ids: null, email: "sin-verificar@empresa-de-prueba.mx" }, TEST_ENV.jwtSecret, 600);
    const send = await app.request("/auth/email-verification/enviar", authedJson(token, { vertical: "licitaciones" }));
    expect(((await send.json()) as { alreadyVerified: boolean }).alreadyVerified).toBe(false);
    expect(sent[0]!.text).toContain("/licitaciones/verificar-correo?token=");
    const link = tokenFromEmail(sent[0]!.text);
    expect((await app.request("/auth/email-verification/confirmar", json({ token: link }))).status).toBe(200);
    expect((await core.findStaffById("00000000-0000-0000-0000-00000000f001"))?.emailVerifiedAt).not.toBeNull();
    expect((await app.request("/auth/email-verification/confirmar", json({ token: link }))).status).toBe(400);
  });
});

describe("enlaces del correo por vertical (PL-21)", () => {
  // La web monta /<vertical>/restablecer-contrasena y /<vertical>/verificar-correo en las 6 verticales: el
  // enlace que arma la API debe apuntar a la ruta de la vertical que lo pidio, no a una fija.
  const VERTICALES = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"] as const;

  it.each(VERTICALES)("%s: el correo de 'olvide mi contrasena' lleva a su ruta /restablecer-contrasena del dominio de la app", async (vertical) => {
    const { app, ctx } = await setup();
    const sent = captureResend();
    expect((await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical }))).status).toBe(200);
    expect(sent).toHaveLength(1);
    const enlace = new URL(sent[0]!.text.match(/https?:\/\/\S+/)![0]);
    expect(enlace.origin).toBe(new URL(TEST_ENV.appBaseUrl).origin);
    expect(enlace.pathname).toBe(`/${vertical}/restablecer-contrasena`);
    expect(enlace.searchParams.get("token")).toBeTruthy();
  });

  it.each(VERTICALES)("%s: el correo de verificacion lleva a su ruta /verificar-correo", async (vertical) => {
    const { app, ctx, core } = await setup();
    const sent = captureResend();
    core.addStaff({ id: "00000000-0000-0000-0000-00000000f002", email: "sin-verificar-vertical@empresa-de-prueba.mx", fullName: "Sin verificar", passwordHash: null, createdVia: "registro_autoservicio", emailVerifiedAt: null });
    const { signAccessToken } = await import("@atiende/core-auth");
    const token = await signAccessToken({ sub: "00000000-0000-0000-0000-00000000f002", org_id: ctx.organizationId, vertical, property_ids: null, email: "sin-verificar-vertical@empresa-de-prueba.mx" }, TEST_ENV.jwtSecret, 600);
    expect((await app.request("/auth/email-verification/enviar", authedJson(token, { vertical }))).status).toBe(200);
    const enlace = new URL(sent[0]!.text.match(/https?:\/\/\S+/)![0]);
    expect(enlace.pathname).toBe(`/${vertical}/verificar-correo`);
  });
});

describe("bordes y seguridad de los enlaces de un solo uso (L-02)", () => {
  it("pedir un segundo enlace de reset invalida el primero (un solo enlace vivo por cuenta)", async () => {
    const { app, ctx } = await setup();
    const sent = captureResend();
    await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "licitaciones" }));
    await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "licitaciones" }));
    const [primero, segundo] = [tokenFromEmail(sent[0]!.text), tokenFromEmail(sent[1]!.text)];
    expect((await app.request("/auth/password-reset/confirmar", json({ token: primero, newPassword: pw("a") }))).status).toBe(400);
    expect((await app.request("/auth/password-reset/confirmar", json({ token: segundo, newPassword: pw("b") }))).status).toBe(200);
  });

  it("el enlace de reset vence a la hora: con el reloj +61 min responde 400 y la contrasena no cambia", async () => {
    const { app, ctx, security } = await setup();
    const sent = captureResend();
    await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "licitaciones" }));
    const token = tokenFromEmail(sent[0]!.text);
    const real = Date.now();
    security.now = () => real + 61 * 60_000;
    const res = await app.request("/auth/password-reset/confirmar", json({ token, newPassword: pw("tarde") }));
    expect(res.status).toBe(400);
    expect((await app.request("/auth/login", json({ email: ctx.staff.owner.email, password: ctx.staff.owner.password }))).status).toBe(200);
  });

  it("el token de una cuenta solo cambia ESA cuenta (la contrasena de otra no se toca)", async () => {
    const { app, ctx } = await setup();
    const sent = captureResend();
    await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "licitaciones" }));
    const token = tokenFromEmail(sent[0]!.text);
    const nueva = pw("duena");
    expect((await app.request("/auth/password-reset/confirmar", json({ token, newPassword: nueva }))).status).toBe(200);
    expect((await app.request("/auth/login", json({ email: ctx.staff.analyst.email, password: ctx.staff.analyst.password }))).status).toBe(200);
    expect((await app.request("/auth/login", json({ email: ctx.staff.owner.email, password: nueva }))).status).toBe(200);
  });

  it("el token del correo de verificacion no sirve como token de reset ni al reves (tablas separadas)", async () => {
    const { app, ctx } = await setup();
    const sent = captureResend();
    await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "licitaciones" }));
    const resetToken = tokenFromEmail(sent[0]!.text);
    expect((await app.request("/auth/email-verification/confirmar", json({ token: resetToken }))).status).toBe(400);
    // y el de reset sigue intacto tras el intento fallido
    expect((await app.request("/auth/password-reset/confirmar", json({ token: resetToken, newPassword: pw("vivo") }))).status).toBe(200);
  });

  it("restablecer la contrasena corta TODAS las sesiones previas (el refresh anterior deja de servir)", async () => {
    const { app, ctx } = await setup();
    const sent = captureResend();
    const login = await app.request("/auth/login", json({ email: ctx.staff.owner.email, password: ctx.staff.owner.password }));
    const { refreshToken } = (await login.json()) as { refreshToken: string };
    await new Promise((r) => setTimeout(r, 1100)); // el JWT usa segundos
    await app.request("/auth/password-reset/solicitar", json({ email: ctx.staff.owner.email, vertical: "licitaciones" }));
    await app.request("/auth/password-reset/confirmar", json({ token: tokenFromEmail(sent[0]!.text), newPassword: pw("nueva") }));
    expect((await app.request("/auth/refresh", json({ refreshToken }))).status).toBe(401);
  });

  it("el correo de verificacion vencido (+25 h) no verifica", async () => {
    const { app, ctx, core, security } = await setup();
    const sent = captureResend();
    core.addStaff({ id: "00000000-0000-0000-0000-00000000f002", email: "venc@empresa-de-prueba.mx", fullName: "V", passwordHash: null, createdVia: "registro_autoservicio", emailVerifiedAt: null });
    const { signAccessToken } = await import("@atiende/core-auth");
    const token = await signAccessToken({ sub: "00000000-0000-0000-0000-00000000f002", org_id: ctx.organizationId, vertical: "licitaciones", property_ids: null, email: "venc@empresa-de-prueba.mx" }, TEST_ENV.jwtSecret, 600);
    await app.request("/auth/email-verification/enviar", authedJson(token, { vertical: "licitaciones" }));
    const link = tokenFromEmail(sent[0]!.text);
    const real = Date.now();
    security.now = () => real + 25 * 3_600_000;
    expect((await app.request("/auth/email-verification/confirmar", json({ token: link }))).status).toBe(400);
    expect((await core.findStaffById("00000000-0000-0000-0000-00000000f002"))?.emailVerifiedAt).toBeNull();
  });

  it("enviar verificacion es honesto: sent:true con Resend, sent:false si Resend no esta configurado o rechaza", async () => {
    const { ctx, core, security } = await setup();
    core.addStaff({ id: "00000000-0000-0000-0000-00000000f003", email: "honesto@empresa-de-prueba.mx", fullName: "H", passwordHash: null, createdVia: "registro_autoservicio", emailVerifiedAt: null });
    const { signAccessToken } = await import("@atiende/core-auth");
    const token = await signAccessToken({ sub: "00000000-0000-0000-0000-00000000f003", org_id: ctx.organizationId, vertical: "licitaciones", property_ids: null, email: "honesto@empresa-de-prueba.mx" }, TEST_ENV.jwtSecret, 600);
    const conResend = buildApp({ ...ctx.deps, staffSecurityRepo: security, env: { ...TEST_ENV, resend: { apiKey: pw("re"), from: "atiende <n@atiende.ai>" } } });
    captureResend();
    expect(((await (await conResend.request("/auth/email-verification/enviar", authedJson(token, { vertical: "licitaciones" }))).json()) as { sent: boolean }).sent).toBe(true);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 422 }));
    expect(((await (await conResend.request("/auth/email-verification/enviar", authedJson(token, { vertical: "licitaciones" }))).json()) as { sent: boolean }).sent).toBe(false);
    const sinResend = buildApp({ ...ctx.deps, staffSecurityRepo: security, env: { ...TEST_ENV, resend: { apiKey: null, from: "x" } } });
    expect(((await (await sinResend.request("/auth/email-verification/enviar", authedJson(token, { vertical: "licitaciones" }))).json()) as { sent: boolean }).sent).toBe(false);
  });
});
