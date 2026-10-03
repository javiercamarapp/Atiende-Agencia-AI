// L-02 -- vincular Google a la cuenta YA autenticada (`POST /auth/google/vincular/iniciar` ->
// autorizacion -> `GET /auth/google/callback` con state purpose=link) contra el servidor OAuth de
// Google FALSO local, sin red. Cubre: camino feliz, que NUNCA inicia sesion ni emite codigo de
// intercambio, Google ya vinculado a otra cuenta, state de login reutilizado/alterado, org ajena,
// Google sin configurar y regreso a Seguridad sin redireccion abierta.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signOAuthState } from "@atiende/core-auth";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";
import { startFakeGoogleOAuthServer, type FakeGoogleOAuthServer } from "./support/fakeGoogleOAuth.ts";

let fakeGoogle: FakeGoogleOAuthServer;
beforeEach(async () => {
  fakeGoogle = await startFakeGoogleOAuthServer();
});
afterEach(async () => {
  await fakeGoogle.close();
});

async function setup(googleConfigured = true) {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const core = ctx.deps.coreRepo as InMemoryCoreRepository;
  const security = new InMemoryStaffSecurityRepository(core);
  const env = {
    ...TEST_ENV,
    googleOAuth: googleConfigured ? { clientId: fakeGoogle.clientId, clientSecret: fakeGoogle.clientSecret, redirectBaseUrl: TEST_ENV.appBaseUrl } : null,
    googleStaffAuth: { authBaseUrl: fakeGoogle.baseUrl, tokenUrl: fakeGoogle.tokenUrl, jwksUrl: fakeGoogle.jwksUrl, issuer: fakeGoogle.issuer },
  };
  const deps = { ...ctx.deps, staffSecurityRepo: security, env };
  return { ctx, core, security, deps, app: buildApp(deps) };
}

/** Inicia el vinculo y recorre el authorize del servidor falso: devuelve code+state del callback. */
async function autorizar(app: ReturnType<typeof buildApp>, token: string, orgSlug = "empresa-de-prueba") {
  const res = await app.request("/auth/google/vincular/iniciar", authedJson(token, { orgSlug }));
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const authorized = await fetch(url, { redirect: "manual" });
  const cb = new URL(authorized.headers.get("location")!);
  return { code: cb.searchParams.get("code")!, state: cb.searchParams.get("state")! };
}

describe("vincular Google desde la cuenta", () => {
  it("camino feliz: vincula, regresa a Seguridad con google_link=ok, NO emite codigo de intercambio ni sesion", async () => {
    const { app, ctx, security } = await setup();
    fakeGoogle.setNextUser({ sub: "g-sub-nuevo", email: "Dueña.Personal@gmail.com", emailVerified: true });
    const { code, state } = await autorizar(app, ctx.staff.owner.token);
    const cb = await app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(cb.status).toBe(302);
    const dest = new URL(cb.headers.get("location")!);
    expect(dest.pathname).toBe("/licitaciones/empresa-de-prueba/seguridad");
    expect(dest.searchParams.get("google_link")).toBe("ok");
    expect(dest.searchParams.get("code")).toBeNull();
    expect(dest.searchParams.get("token")).toBeNull();
    const ids = await security.listGoogleIdentities(ctx.staff.owner.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.email).toBe("dueña.personal@gmail.com");
  });

  it("el correo de Google puede ser distinto al de la cuenta (es el usuario autenticado quien elige)", async () => {
    const { app, ctx, security } = await setup();
    fakeGoogle.setNextUser({ sub: "g-otro-correo", email: "otro-correo@gmail.com", emailVerified: true });
    const { code, state } = await autorizar(app, ctx.staff.owner.token);
    await app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(await security.listGoogleIdentities(ctx.staff.owner.id)).toHaveLength(1);
  });

  it("Google ya vinculado a OTRA cuenta -> google_ya_vinculada y NO se reasigna", async () => {
    const { app, ctx, core, security } = await setup();
    await core.linkGoogleIdentity({ staffId: ctx.staff.analyst.id, sub: "g-compartido", email: "x@gmail.com" });
    fakeGoogle.setNextUser({ sub: "g-compartido", email: "x@gmail.com", emailVerified: true });
    const { code, state } = await autorizar(app, ctx.staff.owner.token);
    const cb = await app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(new URL(cb.headers.get("location")!).searchParams.get("google_link")).toBe("google_ya_vinculada");
    expect(await security.listGoogleIdentities(ctx.staff.owner.id)).toHaveLength(0);
    expect(await security.listGoogleIdentities(ctx.staff.analyst.id)).toHaveLength(1);
  });

  it("vincular el mismo Google dos veces a la misma cuenta es idempotente", async () => {
    const { app, ctx, security } = await setup();
    for (let i = 0; i < 2; i += 1) {
      fakeGoogle.setNextUser({ sub: "g-repetido", email: "r@gmail.com", emailVerified: true });
      const { code, state } = await autorizar(app, ctx.staff.owner.token);
      const cb = await app.request(`/auth/google/callback?code=${code}&state=${state}`);
      expect(new URL(cb.headers.get("location")!).searchParams.get("google_link")).toBe("ok");
    }
    expect(await security.listGoogleIdentities(ctx.staff.owner.id)).toHaveLength(1);
  });

  it("correo de Google sin verificar -> error y no vincula", async () => {
    const { app, ctx, security } = await setup();
    fakeGoogle.setNextUser({ sub: "g-sin-verificar", email: "s@gmail.com", emailVerified: false });
    const { code, state } = await autorizar(app, ctx.staff.owner.token);
    const cb = await app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(new URL(cb.headers.get("location")!).searchParams.get("google_link")).toBe("correo_no_verificado");
    expect(await security.listGoogleIdentities(ctx.staff.owner.id)).toHaveLength(0);
  });

  it("iniciar exige sesion, una org propia valida y Google configurado", async () => {
    const { app, ctx } = await setup();
    const sinSesion = await app.request("/auth/google/vincular/iniciar", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(sinSesion.status).toBe(401);
    expect((await app.request("/auth/google/vincular/iniciar", authedJson(ctx.staff.owner.token, { orgSlug: "../../evil" }))).status).toBe(400);
    expect((await app.request("/auth/google/vincular/iniciar", authedJson(ctx.staff.owner.token, {}))).status).toBe(400);
    expect((await app.request("/auth/google/vincular/iniciar", authedJson(ctx.staff.owner.token, { orgSlug: "org-ajena" }))).status).toBe(403);
    const sinGoogle = await setup(false);
    expect((await sinGoogle.app.request("/auth/google/vincular/iniciar", authedJson(sinGoogle.ctx.staff.owner.token, { orgSlug: "empresa-de-prueba" }))).status).toBe(503);
  });

  it("un state de purpose=link sin staffId (alterado) no vincula nada", async () => {
    const { app, ctx, deps, security } = await setup();
    fakeGoogle.setNextUser({ sub: "g-state", email: "st@gmail.com", emailVerified: true });
    // state de link SIN staffId (alterado): no hay cuenta destino (el servidor lo firma siempre con staffId)
    const sinCuenta = await signOAuthState({ purpose: "link", vertical: "licitaciones", nonce: "n", codeVerifier: "v", redirectUri: "r", orgSlug: "empresa-de-prueba" }, deps.env.jwtSecret);
    const cb = await app.request(`/auth/google/callback?code=cualquiera&state=${sinCuenta}`);
    // el intercambio del codigo falla (codigo/verifier inventados): el resultado es un error, jamas "ok"
    expect(new URL(cb.headers.get("location")!).searchParams.get("google_link")).not.toBe("ok");
    expect(await security.listGoogleIdentities(ctx.staff.owner.id)).toHaveLength(0);
  });

  it("el state de link de una cuenta no sirve con otro secreto (firma) ni vencido", async () => {
    const { app, ctx, security } = await setup();
    const falso = await signOAuthState({ purpose: "link", vertical: "licitaciones", nonce: "n", codeVerifier: "v", redirectUri: "r", staffId: ctx.staff.owner.id, orgSlug: "empresa-de-prueba" }, `otro-${randomUUID()}`);
    const cb = await app.request(`/auth/google/callback?code=x&state=${falso}`);
    expect(new URL(cb.headers.get("location")!).searchParams.get("google_error")).toBe("state_invalido");
    expect(await security.listGoogleIdentities(ctx.staff.owner.id)).toHaveLength(0);
  });

  it("el flujo link jamas inicia sesion, aunque el correo de Google coincida con una cuenta existente", async () => {
    const { app, ctx } = await setup();
    fakeGoogle.setNextUser({ sub: "g-login-vs-link", email: ctx.staff.owner.email, emailVerified: true });
    const { code, state } = await autorizar(app, ctx.staff.owner.token);
    const cb = await app.request(`/auth/google/callback?code=${code}&state=${state}`);
    const dest = new URL(cb.headers.get("location")!);
    // aunque el correo de Google coincide con una cuenta existente, el flujo link jamas emite sesion
    expect(dest.pathname).not.toMatch(/auth\/google\/callback$/);
    const exchange = dest.searchParams.get("code");
    expect(exchange).toBeNull();
  });

  describe("PL-21: las 6 verticales vinculan desde su Seguridad de la cuenta", () => {
    async function conOrgDe(vertical: string) {
      const base = await setup();
      const core = base.core;
      const orgId = randomUUID();
      core.addOrganization({ id: orgId, slug: `org-${vertical}`, name: `Org ${vertical}`, vertical });
      core.addMembership({ userId: base.ctx.staff.owner.id, organizationId: orgId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
      return base;
    }

    it.each(["hoteles", "restaurantes", "rentas", "citas", "despachos"])("%s: el regreso va a su /<org>/seguridad (no a licitaciones) y vincula", async (vertical) => {
      const { app, ctx, security } = await conOrgDe(vertical);
      fakeGoogle.setNextUser({ sub: `g-${vertical}`, email: `${vertical}@gmail.com`, emailVerified: true });
      const res = await app.request("/auth/google/vincular/iniciar", authedJson(ctx.staff.owner.token, { orgSlug: `org-${vertical}`, vertical }));
      expect(res.status).toBe(200);
      const { url } = (await res.json()) as { url: string };
      const cb = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
      const dest = await app.request(`/auth/google/callback?code=${cb.searchParams.get("code")}&state=${cb.searchParams.get("state")}`);
      const to = new URL(dest.headers.get("location")!);
      expect(to.pathname).toBe(`/${vertical}/org-${vertical}/seguridad`);
      expect(to.searchParams.get("google_link")).toBe("ok");
      expect(await security.listGoogleIdentities(ctx.staff.owner.id)).toHaveLength(1);
    });

    it("la membresia se valida contra la vertical pedida: un slug de licitaciones no sirve como 'citas'", async () => {
      const { app, ctx } = await setup();
      const res = await app.request("/auth/google/vincular/iniciar", authedJson(ctx.staff.owner.token, { orgSlug: "empresa-de-prueba", vertical: "citas" }));
      expect(res.status).toBe(403);
    });

    it("vertical fuera de la lista cerrada -> 400; sin vertical se conserva licitaciones", async () => {
      const { app, ctx } = await setup();
      expect((await app.request("/auth/google/vincular/iniciar", authedJson(ctx.staff.owner.token, { orgSlug: "empresa-de-prueba", vertical: "../x" }))).status).toBe(400);
      const sin = await app.request("/auth/google/vincular/iniciar", authedJson(ctx.staff.owner.token, { orgSlug: "empresa-de-prueba" }));
      expect(sin.status).toBe(200);
    });
  });
});
