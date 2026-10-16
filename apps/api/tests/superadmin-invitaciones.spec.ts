// Alta del equipo inicial por superadmin (SA-L-26 minimo): rutas de punta a punta contra el repositorio en memoria.
// La autorizacion real, la lista blanca, los conflictos y la bitacora en SQL se verifican en scripts/verify-superadmin-alta-equipo/ (Postgres real).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryCoreRepository, InMemoryOrgEquipoRepository } from "@atiende/db";
import { hashInviteToken, totpAt } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const MOTIVO = "Alta del equipo inicial de Los Taquitos de PM para el go-live.";
const SUC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUC_OTRA_ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORG_CITAS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INEXISTENTE = "99999999-9999-4999-8999-999999999999";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function setup(opciones: { equipo?: InMemoryOrgEquipoRepository | null } = {}) {
  const s = await seguridadSetup();
  const equipo = opciones.equipo === undefined ? new InMemoryOrgEquipoRepository() : opciones.equipo;
  const org = s.base.organizationId;
  equipo?.seedOrganizacion(org, "restaurantes", [{ id: SUC_A, nombre: "Sucursal A" }, { id: SUC_B, nombre: "Sucursal B" }]);
  equipo?.seedOrganizacion(ORG_CITAS, "citas");
  const deps = { ...s.deps, ...(equipo ? { orgEquipoRepo: () => equipo } : {}) };
  const app = buildApp(deps);
  return {
    s, equipo, deps, app, org,
    async superadmin() {
      const sa = await s.superadmin();
      equipo?.seedSuperadmin(sa.id);
      return sa;
    },
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const ruta = (org: string) => `/superadmin/organizaciones/${org}/invitaciones`;
const post = (c: Ctx, org: string, body: unknown, token: string, extra: Record<string, string> = {}) => c.app.request(ruta(org), jsonRequestInit(body, bearer(token, extra)));
const delBody = (body: unknown, headers: Record<string, string>): RequestInit => ({ ...jsonRequestInit(body, headers), method: "DELETE" });
const correoDe = (c: Ctx) => c.s.base.restaurantesRepo.getOutbox().filter((o) => o.channel === "email" && o.eventType === "staff.invite");
const valido = (parche: Record<string, unknown> = {}) => ({ email: "dueno@lostaquitos.mx", verticalRole: "owner", motivo: MOTIVO, ...parche });

describe("alta de equipo -- gateo y validacion", () => {
  it("sin token 401; staff normal 403 en las cuatro rutas", async () => {
    const c = await setup();
    const st = await c.s.staff();
    expect((await c.app.request(ruta(c.org))).status).toBe(401);
    expect((await c.app.request(ruta(c.org), { headers: bearer(st.token) })).status).toBe(403);
    expect((await post(c, c.org, valido(), st.token)).status).toBe(403);
    expect((await post(c, c.org, { motivo: MOTIVO }, st.token)).status).toBe(403);
    expect((await c.app.request(`${ruta(c.org)}/${randomUUID()}`, delBody({ motivo: MOTIVO }, bearer(st.token)))).status).toBe(403);
    expect(c.equipo?.todas()).toHaveLength(0);
  });

  it("motivo obligatorio (>= 20): sin motivo o con motivo corto 400 y no se crea nada", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    expect((await post(c, c.org, { email: "a@b.mx", verticalRole: "owner" }, sa.token)).status).toBe(400);
    expect((await post(c, c.org, valido({ motivo: "corto" }), sa.token)).status).toBe(400);
    expect(c.equipo?.todas()).toHaveLength(0);
  });

  it("correo, rol y sucursales invalidos -> 400; organizacion que no es uuid -> 404", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    expect((await post(c, c.org, valido({ email: "no-es-correo" }), sa.token)).status).toBe(400);
    expect((await post(c, c.org, valido({ verticalRole: "manager" }), sa.token)).status).toBe(400);
    expect((await post(c, c.org, valido({ verticalRole: "staff", propertyIds: [] }), sa.token)).status).toBe(400);
    expect((await post(c, c.org, valido({ verticalRole: "staff", propertyIds: ["no-uuid"] }), sa.token)).status).toBe(400);
    expect((await post(c, "no-es-uuid", valido(), sa.token)).status).toBe(404);
    expect((await post(c, INEXISTENTE, valido(), sa.token)).status).toBe(404);
  });

  it("sucursal de otra organizacion -> 400; vertical sin lista blanca (citas) -> 400", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    expect((await post(c, c.org, valido({ verticalRole: "staff", propertyIds: [SUC_OTRA_ORG] }), sa.token)).status).toBe(400);
    expect((await post(c, ORG_CITAS, valido({ verticalRole: "admin" }), sa.token)).status).toBe(400);
  });
});

describe("alta de equipo -- invitar", () => {
  it("201: respuesta con token una sola vez y SIN hashes; correo enmascarado; bitacora sin correo completo", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    const res = await post(c, c.org, valido(), sa.token);
    expect(res.status).toBe(201);
    const cuerpo = (await res.json()) as Json;
    expect(cuerpo.invitacion).toMatchObject({ correo: "d***@lostaquitos.mx", verticalRole: "owner", propertyIds: null, estado: "pending" });
    expect(typeof cuerpo.inviteToken).toBe("string");
    const texto = JSON.stringify(cuerpo);
    expect(texto).not.toContain("dueno@lostaquitos.mx");
    expect(texto).not.toContain("tokenHash");
    expect(texto).not.toContain("token_hash");
    const guardada = c.equipo?.todas()[0];
    expect(guardada?.tokenHash).toBe(hashInviteToken(cuerpo.inviteToken as string));
    expect(texto).not.toContain(guardada?.tokenHash as string);
    expect(c.equipo?.bitacora).toEqual([expect.objectContaining({ evento: "org_invite_created", actor: sa.id, correo: "d***@lostaquitos.mx", motivo: MOTIVO })]);
    expect(JSON.stringify(c.equipo?.bitacora)).not.toContain("dueno@lostaquitos.mx");
  });

  it("encola el correo con el enlace de APP_BASE_URL y el token", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    const cuerpo = (await (await post(c, c.org, valido(), sa.token)).json()) as Json;
    expect(cuerpo.correoEncolado).toBe(true);
    expect(cuerpo.acceptUrl).toBe(`https://app.test.invalid/aceptar-invitacion?token=${encodeURIComponent(cuerpo.inviteToken as string)}`);
    const job = correoDe(c)[0];
    expect(job?.organizationId).toBe(c.org);
    const payload = job?.payload as { to: string; html: string; text: string };
    expect(payload.to).toBe("dueno@lostaquitos.mx");
    expect(payload.html).toContain(encodeURIComponent(cuerpo.inviteToken as string));
    expect(payload.text).toContain("https://app.test.invalid/aceptar-invitacion?token=");
  });

  it("un fallo del encolado NO revierte la invitacion: 201 con correoEncolado=false y la invitacion queda pendiente", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    const spy = vi.spyOn(c.s.base.restaurantesRepo, "enqueueMessagingOutbox").mockRejectedValue(Object.assign(new Error("boom"), { code: "40P01" }));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await post(c, c.org, valido(), sa.token);
      expect(res.status).toBe(201);
      expect(((await res.json()) as Json).correoEncolado).toBe(false);
      expect(c.equipo?.todas()).toHaveLength(1);
      expect(c.equipo?.todas()[0]?.status).toBe("pending");
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });

  it("segundo owner: sin confirmar 409 segundo_owner_requiere_confirmacion; con confirmarSegundoOwner 201", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    c.equipo?.seedMiembro(c.org, { userId: randomUUID(), email: "duenio@lostaquitos.mx", rol: "owner" });
    const sin = await post(c, c.org, valido(), sa.token);
    expect(sin.status).toBe(409);
    expect(await sin.json()).toMatchObject({ code: "segundo_owner_requiere_confirmacion" });
    expect(c.equipo?.todas()).toHaveLength(0);
    expect((await post(c, c.org, valido({ confirmarSegundoOwner: true }), sa.token)).status).toBe(201);
    expect((await post(c, c.org, valido({ email: "otro@lostaquitos.mx", verticalRole: "admin" }), sa.token)).status).toBe(201);
  });

  it("correo que ya es miembro -> 409; invitacion pendiente duplicada -> 409", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    c.equipo?.seedMiembro(c.org, { userId: randomUUID(), email: "ya@lostaquitos.mx", rol: "staff" });
    expect((await post(c, c.org, valido({ email: "YA@lostaquitos.mx", verticalRole: "staff" }), sa.token)).status).toBe(409);
    expect((await post(c, c.org, valido({ email: "nuevo@lostaquitos.mx", verticalRole: "staff" }), sa.token)).status).toBe(201);
    expect((await post(c, c.org, valido({ email: "nuevo@lostaquitos.mx", verticalRole: "staff" }), sa.token)).status).toBe(409);
  });

  it("sucursales validas de la organizacion se guardan; las del rol staff", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    const res = await post(c, c.org, valido({ verticalRole: "staff", propertyIds: [SUC_A, SUC_B] }), sa.token);
    expect(res.status).toBe(201);
    expect(c.equipo?.todas()[0]).toMatchObject({ platformRole: "member", propertyIds: [SUC_A, SUC_B] });
  });
});

describe("alta de equipo -- step-up (sensible)", () => {
  it("con MFA activa: invitar, reenviar y revocar exigen step-up (403 stepup_required) y no cambian nada; con el token pasan", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    const enr = (await (await c.app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(sa.token)))).json()) as { secreto: string };
    const ver = (await (await c.app.request("/superadmin/mfa/verificar", jsonRequestInit({ codigo: totpAt(enr.secreto, Date.now()) }, bearer(sa.token)))).json()) as { stepUpToken: string };
    const stepUp = { "x-stepup-token": ver.stepUpToken };

    const sin = await post(c, c.org, valido(), sa.token);
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "stepup_required" });
    expect(c.equipo?.todas()).toHaveLength(0);

    const creada = (await (await post(c, c.org, valido(), sa.token, stepUp)).json()) as Json;
    const id = creada.invitacion.id as string;
    const tokenViejo = c.equipo?.todas()[0]?.tokenHash;

    const reSin = await c.app.request(`${ruta(c.org)}/${id}/reenviar`, jsonRequestInit({ motivo: MOTIVO }, bearer(sa.token)));
    expect(reSin.status).toBe(403);
    expect(c.equipo?.todas()[0]?.tokenHash).toBe(tokenViejo);
    const revSin = await c.app.request(`${ruta(c.org)}/${id}`, delBody({ motivo: MOTIVO }, bearer(sa.token)));
    expect(revSin.status).toBe(403);
    expect(c.equipo?.todas()[0]?.status).toBe("pending");

    expect((await c.app.request(`${ruta(c.org)}/${id}/reenviar`, jsonRequestInit({ motivo: MOTIVO }, bearer(sa.token, stepUp)))).status).toBe(200);
    expect((await c.app.request(`${ruta(c.org)}/${id}`, delBody({ motivo: MOTIVO }, bearer(sa.token, stepUp)))).status).toBe(200);
    // la lectura NO es sensible
    expect((await c.app.request(ruta(c.org), { headers: bearer(sa.token) })).status).toBe(200);
  });
});

describe("alta de equipo -- reenviar y revocar", () => {
  it("reenviar: token nuevo (el anterior ya no coincide), correo nuevo con el enlace nuevo; exige motivo", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    const creada = (await (await post(c, c.org, valido(), sa.token)).json()) as Json;
    const id = creada.invitacion.id as string;
    expect((await c.app.request(`${ruta(c.org)}/${id}/reenviar`, jsonRequestInit({}, bearer(sa.token)))).status).toBe(400);

    const res = await c.app.request(`${ruta(c.org)}/${id}/reenviar`, jsonRequestInit({ motivo: MOTIVO }, bearer(sa.token)));
    expect(res.status).toBe(200);
    const nueva = (await res.json()) as Json;
    expect(nueva.inviteToken).not.toBe(creada.inviteToken);
    expect(c.equipo?.todas()[0]?.tokenHash).toBe(hashInviteToken(nueva.inviteToken as string));
    expect(c.equipo?.todas()[0]?.tokenHash).not.toBe(hashInviteToken(creada.inviteToken as string));
    expect(JSON.stringify(nueva)).not.toContain("dueno@lostaquitos.mx");
    expect((correoDe(c)[0]?.payload as { html: string }).html).toContain(encodeURIComponent(nueva.inviteToken as string));
    expect(c.equipo?.bitacora.map((b) => b.evento)).toEqual(["org_invite_created", "org_invite_resent"]);
  });

  it("revocar: deja de estar pendiente; reenviar o revocar de nuevo -> 404; de otra organizacion -> 404", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    const id = (((await (await post(c, c.org, valido(), sa.token)).json()) as Json).invitacion.id) as string;
    expect((await c.app.request(`${ruta(ORG_CITAS)}/${id}`, delBody({ motivo: MOTIVO }, bearer(sa.token)))).status).toBe(404);
    expect((await c.app.request(`${ruta(c.org)}/${id}`, delBody({ motivo: "corto" }, bearer(sa.token)))).status).toBe(400);
    expect((await c.app.request(`${ruta(c.org)}/${id}`, delBody({ motivo: MOTIVO }, bearer(sa.token)))).status).toBe(200);
    expect(c.equipo?.todas()[0]?.status).toBe("revoked");
    expect((await c.app.request(`${ruta(c.org)}/${id}`, delBody({ motivo: MOTIVO }, bearer(sa.token)))).status).toBe(404);
    expect((await c.app.request(`${ruta(c.org)}/${id}/reenviar`, jsonRequestInit({ motivo: MOTIVO }, bearer(sa.token)))).status).toBe(404);
    expect((await c.app.request(`${ruta(c.org)}/no-uuid`, delBody({ motivo: MOTIVO }, bearer(sa.token)))).status).toBe(404);
  });
});

describe("alta de equipo -- leer", () => {
  it("lista miembros e invitaciones pendientes con correo enmascarado, sin hashes ni tokens, y las sucursales", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    c.equipo?.seedMiembro(c.org, { userId: randomUUID(), email: "gerente@lostaquitos.mx", rol: "admin", propertyIds: [SUC_A] });
    const creada = (await (await post(c, c.org, valido(), sa.token)).json()) as Json;
    const res = await c.app.request(ruta(c.org), { headers: bearer(sa.token) });
    expect(res.status).toBe(200);
    const cuerpo = (await res.json()) as Json;
    expect(cuerpo.disponible).toBe(true);
    expect(cuerpo.miembros).toEqual([expect.objectContaining({ correo: "g***@lostaquitos.mx", rol: "admin", propertyIds: [SUC_A] })]);
    expect(cuerpo.invitaciones).toEqual([expect.objectContaining({ id: creada.invitacion.id, correo: "d***@lostaquitos.mx", rol: "owner", vencida: false })]);
    expect(cuerpo.sucursales).toEqual([{ id: SUC_A, nombre: "Sucursal A", estado: "active" }, { id: SUC_B, nombre: "Sucursal B", estado: "active" }]);
    const texto = JSON.stringify(cuerpo);
    for (const prohibido of ["gerente@lostaquitos.mx", "dueno@lostaquitos.mx", "tokenHash", "token_hash", creada.inviteToken as string]) expect(texto).not.toContain(prohibido);
  });

  it("organizacion inexistente -> 404; una invitacion revocada ya no aparece como pendiente", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    expect((await c.app.request(ruta(INEXISTENTE), { headers: bearer(sa.token) })).status).toBe(404);
    const id = (((await (await post(c, c.org, valido(), sa.token)).json()) as Json).invitacion.id) as string;
    await c.app.request(`${ruta(c.org)}/${id}`, delBody({ motivo: MOTIVO }, bearer(sa.token)));
    expect(((await (await c.app.request(ruta(c.org), { headers: bearer(sa.token) })).json()) as Json).invitaciones).toEqual([]);
  });
});

describe("alta de equipo -- base sin la migracion 0053", () => {
  it("sin el repositorio: lectura 200 disponible=false con mensaje; mutaciones 503 y nada se crea", async () => {
    const c = await setup({ equipo: null });
    const sa = await c.s.superadmin();
    const lec = await c.app.request(ruta(c.org), { headers: bearer(sa.token) });
    expect(lec.status).toBe(200);
    expect(await lec.json()).toMatchObject({ disponible: false, miembros: [], invitaciones: [] });
    expect((await post(c, c.org, valido(), sa.token)).status).toBe(503);
    expect((await c.app.request(`${ruta(c.org)}/${randomUUID()}/reenviar`, jsonRequestInit({ motivo: MOTIVO }, bearer(sa.token)))).status).toBe(503);
    expect((await c.app.request(`${ruta(c.org)}/${randomUUID()}`, delBody({ motivo: MOTIVO }, bearer(sa.token)))).status).toBe(503);
    expect(correoDe(c)).toHaveLength(0);
  });

  it("con el repositorio pero la base sin migrar (42883): lectura disponible=false, mutaciones 503", async () => {
    const equipo = new InMemoryOrgEquipoRepository();
    equipo.seedNoMigrado();
    const c = await setup({ equipo });
    const sa = await c.superadmin();
    expect(await (await c.app.request(ruta(c.org), { headers: bearer(sa.token) })).json()).toMatchObject({ disponible: false });
    expect((await post(c, c.org, valido(), sa.token)).status).toBe(503);
    expect(correoDe(c)).toHaveLength(0);
  });
});

describe("alta de equipo -- aviso al superadmin cuando se acepta", () => {
  async function aceptar(c: Ctx, deps: Ctx["deps"], tokenPlain: string) {
    const app = buildApp(deps);
    return app.request("/auth/accept-invite", jsonRequestInit({ token: tokenPlain, fullName: "Dueño PM", password: "contraseña-segura-1" }, {}));
  }

  it("invitacion creada por superadmin y aceptada: una notificacion superadmin.organizacion.miembro_aceptado, sin PII, con enlace a la ficha", async () => {
    const c = await setup();
    const sa = await c.superadmin();
    const creada = (await (await post(c, c.org, valido(), sa.token)).json()) as Json;
    const core = c.s.base.deps.coreRepo as InMemoryCoreRepository;
    // El alta real (core.accept_staff_invite) la prueba verify-superadmin-alta-equipo; aqui la invitacion queda aceptada en el doble.
    const hash = hashInviteToken(creada.inviteToken as string);
    vi.spyOn(core, "acceptStaffInvite").mockImplementation(async () => {
      c.equipo?.marcarAceptada(hash);
      return { staffId: randomUUID(), email: "dueno@lostaquitos.mx", organizationId: c.org, vertical: "restaurantes", platformRole: "owner", verticalRole: "owner", propertyIds: null };
    });
    const { deps, emisiones } = conEmisiones(c.deps);
    const res = await aceptar(c, deps, creada.inviteToken as string);
    expect(res.status).toBe(200);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({ evento: "superadmin.organizacion.miembro_aceptado", organizationId: null, categoria: "onboarding", severidad: "info", enlace: `/superadmin/organizaciones/${c.org}` });
    expect(emisiones[0]?.dedupeKey).toBe(`superadmin.organizacion.miembro_aceptado:${creada.invitacion.id}`);
    const texto = JSON.stringify(emisiones[0]);
    expect(texto).not.toContain("dueno@lostaquitos.mx");
    expect(texto).not.toContain("Dueño PM");
    vi.restoreAllMocks();
  });

  it("una invitacion que NO es de superadmin no emite aviso, y un fallo del aviso no rompe el alta", async () => {
    const c = await setup();
    const core = c.s.base.deps.coreRepo as InMemoryCoreRepository;
    vi.spyOn(core, "acceptStaffInvite").mockResolvedValue({ staffId: randomUUID(), email: "x@lostaquitos.mx", organizationId: c.org, vertical: "restaurantes", platformRole: "member", verticalRole: "staff", propertyIds: null });
    const { deps, emisiones } = conEmisiones(c.deps);
    expect((await aceptar(c, deps, "token-que-no-es-de-superadmin")).status).toBe(200);
    expect(emisiones).toHaveLength(0);

    const falla = { ...c.deps, orgEquipoRepo: () => ({ ...new InMemoryOrgEquipoRepository(), aceptacionParaSistema: async () => { throw new Error("base caida"); } }) as never };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await aceptar(c, falla, "otro-token")).status).toBe(200);
    err.mockRestore();
    vi.restoreAllMocks();
  });
});
