// "Entrar a un cliente": POST /superadmin/soporte/entrar + /soporte/{estado,elevar,salir} + guarda global, contra los repos en memoria.
// La autorización SQL real (auth.uid(), RLS, concesión temporal) se verifica en scripts/verify-superadmin-soporte/. Relojes fijos, sin TZ.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryImpersonationRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { signAccessToken, verifyAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const T0 = Date.parse("2030-03-04T10:00:00.000Z");
const MIN = 60_000;
const MOTIVO = "Revisar por qué el cliente no ve sus pedidos";

type Base = Awaited<ReturnType<typeof buildTestDeps>>;

async function escenario(opts: { esMiembro: boolean; slug?: string } = { esMiembro: true }) {
  const base = await buildTestDeps();
  const reloj = { t: T0 };
  const impersonation = new InMemoryImpersonationRepository({ now: () => reloj.t });
  const core = base.deps.coreRepo as InMemoryCoreRepository;
  const superadminId = randomUUID();
  const email = "javier@atiende.ai";
  core.addStaff({ id: superadminId, email, passwordHash: null, fullName: "Javier", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  core.addPlatformSuperadmin(superadminId);
  impersonation.seedPlatformSuperadmin(superadminId, email);

  const orgId = base.organizationId; // los-taquitos-de-pm (vertical restaurantes, cliente real)
  impersonation.seedOrganization(orgId);
  if (opts.esMiembro) {
    core.addMembership({ userId: superadminId, organizationId: orgId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
    impersonation.seedRealMembership(superadminId, orgId);
  }
  const deps = { ...base.deps, impersonationRepo: () => impersonation, relojMs: () => reloj.t };
  const app = buildApp(deps);
  const tokenSuperadmin = await signAccessToken({ sub: superadminId, org_id: "", vertical: "restaurantes", property_ids: null, email }, deps.env.jwtSecret, deps.env.accessTokenTtlSeconds);
  const entrar = (body: unknown, token = tokenSuperadmin) => app.request("/superadmin/soporte/entrar", jsonRequestInit(body, { authorization: `Bearer ${token}` }));
  return { base, deps, app, reloj, impersonation, core, superadminId, email, orgId, tokenSuperadmin, entrar };
}

async function entrarOk(e: Awaited<ReturnType<typeof escenario>>) {
  const res = await e.entrar({ organizationId: e.orgId, reason: MOTIVO });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; refreshToken: string; session: { id: string; kind: string; expiresAtMs: number; soloLectura: boolean; organizationName: string; organizationSlug: string } };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("POST /superadmin/soporte/entrar", () => {
  it("camino feliz (miembro real): sesión de 60 min en la bitácora, token con claim de solo lectura y sin refresh", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    expect(r.session.kind).toBe("soporte");
    expect(r.session.soloLectura).toBe(true);
    expect(r.session.expiresAtMs).toBe(T0 + 60 * MIN);
    expect(r.session.organizationSlug).toBe("los-taquitos-de-pm");
    expect(r.refreshToken).toBe("");
    const claims = await verifyAccessToken(r.token, e.deps.env.jwtSecret);
    expect(claims.soporte).toEqual({ sid: r.session.id, ro: true });
    expect(claims.org_id).toBe(e.orgId);
    expect(claims.sub).toBe(e.superadminId);

    // bitácora escrita ANTES de entregar el token, sin contenido visto
    const log = await e.impersonation.listAuditLog(e.superadminId);
    const inicio = log.entries.find((x) => x.eventType === "start");
    expect(inicio?.reason).toBe(MOTIVO);
    expect(inicio?.detail).toMatchObject({ kind: "soporte", soloLectura: true });
    // miembro real: no se crea ninguna concesión
    expect(e.impersonation.concesionesVigentes().size).toBe(0);
  });

  it("el motivo se recorta y exige >= 10 caracteres: vacío, null, solo espacios, número y corto -> 400, sin sesión ni token", async () => {
    const e = await escenario();
    for (const reason of ["", null, "   \n\t  ", 12345, "corto", "         x         "]) {
      const res = await e.entrar({ organizationId: e.orgId, reason });
      expect(res.status, JSON.stringify(reason)).toBe(400);
    }
    const sinReason = await e.entrar({ organizationId: e.orgId });
    expect(sinReason.status).toBe(400);
    expect((await e.impersonation.listAuditLog(e.superadminId)).entries).toHaveLength(0);
    // exactamente 10 caracteres tras recortar sí pasa
    const ok = await e.entrar({ organizationId: e.orgId, reason: "  diez cars!  " });
    expect(ok.status).toBe(201);
  });

  it("sin organizationId o con una organización inexistente -> 400 / 404", async () => {
    const e = await escenario();
    expect((await e.entrar({ reason: MOTIVO })).status).toBe(400);
    expect((await e.entrar({ organizationId: "   ", reason: MOTIVO })).status).toBe(400);
    expect((await e.entrar({ organizationId: randomUUID(), reason: MOTIVO })).status).toBe(404);
  });

  it("una organización DEMO se rechaza (esas se abren en «Ver los otros paneles»)", async () => {
    const e = await escenario();
    const demoId = randomUUID();
    e.core.addOrganization({ id: demoId, slug: "demo-restaurantes", name: "Demo — Vista previa (restaurantes)", vertical: "restaurantes" });
    e.impersonation.seedOrganization(demoId);
    const res = await e.entrar({ organizationId: demoId, reason: MOTIVO });
    expect(res.status).toBe(409);
    expect((await e.impersonation.listAuditLog(e.superadminId)).entries).toHaveLength(0);
  });

  it("un usuario que NO es superadmin recibe 403 y no queda sesión", async () => {
    const e = await escenario();
    const otro = await signAccessToken({ sub: randomUUID(), org_id: e.orgId, vertical: "restaurantes", property_ids: null, email: "otro@x.mx" }, e.deps.env.jwtSecret, 600);
    const res = await e.entrar({ organizationId: e.orgId, reason: MOTIVO }, otro);
    expect(res.status).toBe(403);
    expect((await e.impersonation.listAuditLog(e.superadminId)).entries).toHaveLength(0);
  });

  it("sin token -> 401", async () => {
    const e = await escenario();
    const res = await e.app.request("/superadmin/soporte/entrar", jsonRequestInit({ organizationId: e.orgId, reason: MOTIVO }));
    expect(res.status).toBe(401);
  });

  it("FALLA CERRADO: si la bitácora falla no se entrega token", async () => {
    const e = await escenario();
    const roto = new InMemoryImpersonationRepository({ now: () => e.reloj.t });
    roto.startSupportSession = async () => {
      throw new Error("la bitácora no respondió");
    };
    const app = buildApp({ ...e.deps, impersonationRepo: () => roto });
    const res = await app.request("/superadmin/soporte/entrar", jsonRequestInit({ organizationId: e.orgId, reason: MOTIVO }, auth(e.tokenSuperadmin)));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("token\":\"ey");
  });

  it("FALLA CERRADO: base sin migrar -> 503 honesto y sin token", async () => {
    const e = await escenario();
    const sinMigrar = new InMemoryImpersonationRepository({ now: () => e.reloj.t });
    sinMigrar.startSupportSession = async () => ({ availability: "not_migrated" as const, kind: null, session: null });
    const app = buildApp({ ...e.deps, impersonationRepo: () => sinMigrar });
    const res = await app.request("/superadmin/soporte/entrar", jsonRequestInit({ organizationId: e.orgId, reason: MOTIVO }, auth(e.tokenSuperadmin)));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("\"token\"");
  });

  it("no miembro: concesión TEMPORAL trazada; salir la revoca", async () => {
    const e = await escenario({ esMiembro: false });
    const r = await entrarOk(e);
    expect(e.impersonation.concesionesVigentes().get(r.session.id)).toBe(e.orgId);
    const salir = await e.app.request("/soporte/salir", { method: "POST", headers: auth(r.token) });
    expect(salir.status).toBe(200);
    expect(e.impersonation.concesionesVigentes().size).toBe(0);
  });

  it("no miembro y la base no tiene la concesión (0058 sin aplicar): 409 honesto, la sesión se cierra y no hay token", async () => {
    const e = await escenario({ esMiembro: false });
    const repo = new InMemoryImpersonationRepository({ now: () => e.reloj.t });
    repo.seedPlatformSuperadmin(e.superadminId, e.email);
    repo.seedOrganization(e.orgId);
    repo.grantSupportMembership = async () => ({ availability: "not_migrated" as const, granted: false });
    const app = buildApp({ ...e.deps, impersonationRepo: () => repo });
    const res = await app.request("/superadmin/soporte/entrar", jsonRequestInit({ organizationId: e.orgId, reason: MOTIVO }, auth(e.tokenSuperadmin)));
    expect(res.status).toBe(409);
    expect((await repo.getActiveSession(e.superadminId)).session).toBeNull();
  });

  it("una segunda entrada mientras hay una sesión activa se rechaza", async () => {
    const e = await escenario();
    await entrarOk(e);
    const res = await e.entrar({ organizationId: e.orgId, reason: MOTIVO });
    expect(res.status).toBe(403); // el write-guard de /superadmin/* bloquea escrituras mientras se impersona
  });
});

describe("guarda global con token de soporte", () => {
  it("GET permitido; escritura común -> 403 soporte_solo_lectura; acción sensible -> 403 soporte_accion_bloqueada", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    const get = await e.app.request("/auth/me", { headers: auth(r.token) });
    expect(get.status).toBe(200);

    const patch = await e.app.request(`/v1/restaurantes/${e.base.propertyId}/admin/products/${randomUUID()}`, { method: "PATCH", headers: { ...auth(r.token), "content-type": "application/json" }, body: "{}" });
    expect(patch.status).toBe(403);
    expect(((await patch.json()) as { code: string }).code).toBe("soporte_solo_lectura");

    const pass = await e.app.request("/auth/change-password", jsonRequestInit({ currentPassword: "x", newPassword: "yyyyyyyy" }, auth(r.token)));
    expect(pass.status).toBe(403);
    expect(((await pass.json()) as { code: string }).code).toBe("soporte_accion_bloqueada");
  });

  it("la consola de plataforma no se alcanza con un token de soporte", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    const res = await e.app.request("/superadmin/organizations", { headers: auth(r.token) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("soporte_ruta_bloqueada");
  });

  it("un token SIN claim de soporte (login normal del dueño) no se ve afectado por la guarda", async () => {
    const e = await escenario();
    const normal = await signAccessToken({ sub: e.superadminId, org_id: e.orgId, vertical: "restaurantes", property_ids: null, email: e.email }, e.deps.env.jwtSecret, 600);
    const res = await e.app.request("/auth/change-password", jsonRequestInit({ currentPassword: "x", newPassword: "yyyyyyyy" }, auth(normal)));
    const body = (await res.json()) as { code?: string };
    expect(body.code ?? "").not.toMatch(/^soporte_/);
  });

  it("caducidad: pasada la hora la sesión ya no está activa y el token deja de servir (401)", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    e.reloj.t = T0 + 59 * MIN;
    expect((await e.app.request("/auth/me", { headers: auth(r.token) })).status).toBe(200);
    e.reloj.t = T0 + 60 * MIN + 1;
    const vencida = await e.app.request("/auth/me", { headers: auth(r.token) });
    expect(vencida.status).toBe(401);
  });

  it("tras «Salir» el mismo token ya no sirve", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    expect((await e.app.request("/soporte/salir", { method: "POST", headers: auth(r.token) })).status).toBe(200);
    expect((await e.app.request("/auth/me", { headers: auth(r.token) })).status).toBe(401);
    // idempotente: salir otra vez no explota (el token ya no pasa la guarda: 401, nunca 500)
    expect((await e.app.request("/soporte/salir", { method: "POST", headers: auth(r.token) })).status).toBe(401);
  });

  it("FALLA CERRADO: si no se puede verificar la sesión en SQL -> 503", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    const roto = new InMemoryImpersonationRepository({ now: () => e.reloj.t });
    roto.getSupportState = async () => {
      throw new Error("base caída");
    };
    const app = buildApp({ ...e.deps, impersonationRepo: () => roto });
    const res = await app.request("/auth/me", { headers: auth(r.token) });
    expect(res.status).toBe(503);
  });

  it("un token con claim de soporte de otra organización (org_id manipulado) no pasa", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    const falso = await signAccessToken({ sub: e.superadminId, org_id: randomUUID(), vertical: "restaurantes", property_ids: null, email: e.email, soporte: { sid: r.session.id, ro: true } }, e.deps.env.jwtSecret, 600);
    expect((await e.app.request("/auth/me", { headers: auth(falso) })).status).toBe(401);
  });

  it("un token con ro:false pero sin elevación registrada no pasa", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    const forjado = await signAccessToken({ sub: e.superadminId, org_id: e.orgId, vertical: "restaurantes", property_ids: null, email: e.email, soporte: { sid: r.session.id, ro: false } }, e.deps.env.jwtSecret, 600);
    expect((await e.app.request("/auth/me", { headers: auth(forjado) })).status).toBe(401);
  });
});

describe("elevación («Permitir edición») y estado", () => {
  it("exige segundo motivo >= 10 (vacío, null, espacios -> 400); con motivo emite token ro:false y queda en la bitácora", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    for (const reason of ["", null, "      ", "corto"]) {
      const res = await e.app.request("/soporte/elevar", jsonRequestInit({ reason }, auth(r.token)));
      expect(res.status, JSON.stringify(reason)).toBe(400);
    }
    const ok = await e.app.request("/soporte/elevar", jsonRequestInit({ reason: "Corregir el precio mal capturado" }, auth(r.token)));
    expect(ok.status).toBe(200);
    const { token, session } = (await ok.json()) as { token: string; session: { soloLectura: boolean; expiresAtMs: number } };
    expect(session.soloLectura).toBe(false);
    expect(session.expiresAtMs).toBe(T0 + 60 * MIN);
    expect((await verifyAccessToken(token, e.deps.env.jwtSecret)).soporte?.ro).toBe(false);
    const log = await e.impersonation.listAuditLog(e.superadminId);
    expect(log.entries.find((x) => x.eventType === "elevate")?.reason).toBe("Corregir el precio mal capturado");

    // ya elevado: escritura común pasa la guarda (llega al handler real; no es 403 de soporte)
    const patch = await e.app.request(`/v1/restaurantes/${e.base.propertyId}/admin/products/${randomUUID()}`, { method: "PATCH", headers: { ...auth(token), "content-type": "application/json" }, body: "{}" });
    expect(patch.status === 403 ? ((await patch.json()) as { code: string }).code : "ok").not.toMatch(/^soporte_/);
    // pero lo sensible sigue bloqueado
    const pass = await e.app.request("/auth/change-password", jsonRequestInit({}, auth(token)));
    expect(((await pass.json()) as { code: string }).code).toBe("soporte_accion_bloqueada");
  });

  it("no se puede elevar dos veces ni con un token sin claim de soporte", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    expect((await e.app.request("/soporte/elevar", jsonRequestInit({ reason: "Primer motivo valido" }, auth(r.token)))).status).toBe(200);
    expect((await e.app.request("/soporte/elevar", jsonRequestInit({ reason: "Segundo intento valido" }, auth(r.token)))).status).toBe(409);
    expect((await e.app.request("/soporte/elevar", jsonRequestInit({ reason: "Sin claim de soporte" }, auth(e.tokenSuperadmin)))).status).toBe(403);
  });

  it("GET /soporte/estado informa activa, elevada y lo que queda", async () => {
    const e = await escenario();
    const r = await entrarOk(e);
    e.reloj.t = T0 + 10 * MIN;
    const res = await e.app.request("/soporte/estado", { headers: auth(r.token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ active: true, elevated: false, remainingMs: 50 * MIN, organizationId: e.orgId });
  });
});

describe("bitácora de terminar (impersonación existente) con sesión de soporte", () => {
  it("terminar desde la consola también revoca la concesión temporal", async () => {
    const e = await escenario({ esMiembro: false });
    const r = await entrarOk(e);
    const res = await e.app.request(`/superadmin/impersonacion/sesiones/${r.session.id}/terminar`, jsonRequestInit({}, auth(e.tokenSuperadmin)));
    expect(res.status).toBe(200);
    expect(e.impersonation.concesionesVigentes().size).toBe(0);
  });
});
