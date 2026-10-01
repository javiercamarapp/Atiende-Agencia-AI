// Rn-20 -- HTTP end-to-end de admin-staff.ts de rentas (invitar, cambiar rol, baja) + POST /auth/accept-invite (generico de
// core). Mismo patron que restaurantes-admin-staff.spec.ts sobre el fixture de rentas (admin_gestora org-wide, operadores,
// contador, limpieza).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import type { InMemoryRentasTenancyEngine } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import type { RentasTestContext } from "./rentas-fixtures.ts";

interface InviteResponse {
  readonly id: string;
  readonly email: string;
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
  readonly status: string;
  readonly inviteToken: string;
}
interface MemberResponse {
  readonly id: string;
  readonly email: string;
  readonly verticalRole: string;
}

const base = (ctx: RentasTestContext) => `/v1/rentas/${ctx.propertyId}/admin/staff`;
const get = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const del = (token: string) => ({ method: "DELETE", headers: { authorization: `Bearer ${token}` } });

async function invitar(app: ReturnType<typeof buildApp>, ctx: RentasTestContext, token: string, body: unknown) {
  return app.request(`${base(ctx)}/invitaciones`, authedJson(token, body, {}, "POST"));
}

describe("POST /v1/rentas/:propertyId/admin/staff/invitaciones", () => {
  it("admin_gestora invita a un rol de limpieza -- 201, token real, queda pending con el alcance de quien invita", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await invitar(app, ctx, ctx.staff.adminGestora.token, { email: "Limpieza.Nueva@Rentas.mx", verticalRole: "limpieza" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteResponse;
    expect(body).toMatchObject({ email: "limpieza.nueva@rentas.mx", verticalRole: "limpieza", status: "pending", propertyIds: null });
    expect(body.inviteToken.length).toBeGreaterThan(20);

    const listado = await app.request(`${base(ctx)}/invitaciones`, get(ctx.staff.adminGestora.token));
    const lista = (await listado.json()) as { invitations: InviteResponse[] };
    expect(lista.invitations.map((i) => i.email)).toContain("limpieza.nueva@rentas.mx");
    expect(lista.invitations[0]).not.toHaveProperty("inviteToken");
  });

  it("se pueden invitar los 3 roles pedidos: limpieza, contador y los operadores", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const [i, rol] of (["limpieza", "contador", "operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario"] as const).entries()) {
      const res = await invitar(app, ctx, ctx.staff.adminGestora.token, { email: `persona${i}@rentas.mx`, verticalRole: rol });
      expect(res.status, rol).toBe(201);
    }
  });

  it("roles que NO son admin_gestora (operador, contador, limpieza) -> 403, nunca pueden invitar", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const rol of ["operadorAccesoTotal", "operadorSoloCalendario", "contador", "limpieza"] as const) {
      const res = await invitar(app, ctx, ctx.staff[rol].token, { email: "x@rentas.mx", verticalRole: "limpieza" });
      expect(res.status, rol).toBe(403);
    }
  });

  it("verticalRole desconocido o de otra vertical -> 400; correo invalido -> 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const verticalRole of ["owner", "frontdesk", "repartidor", ""]) {
      expect((await invitar(app, ctx, ctx.staff.adminGestora.token, { email: "x@rentas.mx", verticalRole })).status, verticalRole).toBe(400);
    }
    expect((await invitar(app, ctx, ctx.staff.adminGestora.token, { email: "sin-arroba", verticalRole: "limpieza" })).status).toBe(400);
  });

  it("invitar un correo que ya es staff de la organizacion -> 409", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await invitar(app, ctx, ctx.staff.adminGestora.token, { email: ctx.staff.contador.email, verticalRole: "contador" });
    expect(res.status).toBe(409);
  });

  it("encola el correo de invitacion en el outbox de rentas con el enlace de activacion", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await invitar(app, ctx, ctx.staff.adminGestora.token, { email: "correo-real@rentas.mx", verticalRole: "contador" });
    const { inviteToken } = (await res.json()) as InviteResponse;
    const job = ctx.rentasRepo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "staff.invite");
    expect(job?.status).toBe("pending");
    const payload = job?.payload as { to: string; html: string; text: string };
    expect(payload.to).toBe("correo-real@rentas.mx");
    expect(payload.html).toContain(encodeURIComponent(inviteToken));
    expect(payload.text).toContain(inviteToken);
  });

  it("queda en la bitacora de membership con el correo ENMASCARADO (nunca completo en una tabla append-only)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await invitar(app, ctx, ctx.staff.adminGestora.token, { email: "maria.lopez@rentas.mx", verticalRole: "limpieza" });
    const { id } = (await res.json()) as InviteResponse;
    const fila = ctx.rentasRepo.auditLog.find((r) => r.action === "staff.invitado");
    expect(fila).toMatchObject({ entityType: "membership", entityId: id, despues: "m***@rentas.mx (limpieza)" });
    expect(JSON.stringify(ctx.rentasRepo.auditLog)).not.toContain("maria.lopez");
  });

  it("un admin_gestora de OTRA organizacion no invita sobre esta propiedad (requirePropertyMembership) -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const otra = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/rentas/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(otra.staff.adminGestora.token, { email: "x@rentas.mx", verticalRole: "limpieza" }, {}, "POST"));
    expect(res.status).toBe(403);
    expect(ctx.rentasRepo.auditLog).toHaveLength(0);
  });

  it("sin sesion -> 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`${base(ctx)}/invitaciones`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/accept-invite con una invitacion de rentas", () => {
  it("el invitado de limpieza acepta y queda vinculado con su rol; el token ya no se puede reutilizar", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const invite = await invitar(app, ctx, ctx.staff.adminGestora.token, { email: "limpieza-invitada@rentas.mx", verticalRole: "limpieza" });
    const { inviteToken } = (await invite.json()) as InviteResponse;

    const aceptar = () =>
      app.request("/auth/accept-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inviteToken, fullName: "Limpieza Invitada", password: "correcto-caballo-batería" }) });
    const ok = await aceptar();
    expect(ok.status).toBe(200);
    const sesion = (await ok.json()) as { organizations: { id: string; rol: string }[] };
    expect(sesion.organizations.find((o) => o.id === ctx.organizationId)?.rol).toBe("limpieza");
    expect((await aceptar()).status).toBe(400);
  });
});

describe("DELETE .../invitaciones/:inviteId", () => {
  it("revoca una invitacion pendiente, deja bitacora y ya no se puede aceptar; una inexistente -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { id, inviteToken } = (await (await invitar(app, ctx, ctx.staff.adminGestora.token, { email: "revocada@rentas.mx", verticalRole: "contador" })).json()) as InviteResponse;

    expect((await app.request(`${base(ctx)}/invitaciones/${id}`, del(ctx.staff.contador.token))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/invitaciones/${id}`, del(ctx.staff.adminGestora.token))).status).toBe(200);
    expect(ctx.rentasRepo.auditLog.some((r) => r.action === "staff.invitacion_revocada" && r.entityId === id)).toBe(true);
    const aceptar = await app.request("/auth/accept-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inviteToken, fullName: "X Y", password: "correcto-caballo-batería" }) });
    expect(aceptar.status).toBe(400);
    expect((await app.request(`${base(ctx)}/invitaciones/00000000-0000-4000-8000-000000000000`, del(ctx.staff.adminGestora.token))).status).toBe(404);
  });
});

describe("GET .../miembros", () => {
  it("admin_gestora ve a todo el staff con su rol; los demas roles -> 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`${base(ctx)}/miembros`, get(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const { miembros } = (await res.json()) as { miembros: MemberResponse[] };
    expect(miembros.map((m) => m.verticalRole).sort()).toEqual(["admin_gestora", "contador", "limpieza", "operador:acceso_total", "operador:solo_calendario"]);
    for (const rol of ["operadorAccesoTotal", "contador", "limpieza"] as const) {
      expect((await app.request(`${base(ctx)}/miembros`, get(ctx.staff[rol].token))).status, rol).toBe(403);
    }
  });
});

describe("PATCH .../miembros/:userId -- cambiar el rol", () => {
  it("admin_gestora cambia a un operador de solo calendario a acceso total: persiste y deja bitacora antes/despues", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = ctx.staff.operadorSoloCalendario.id;
    const res = await app.request(`${base(ctx)}/miembros/${id}`, authedJson(ctx.staff.adminGestora.token, { verticalRole: "operador:acceso_total" }, {}, "PATCH"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, verticalRole: "operador:acceso_total" });
    const fila = ctx.rentasRepo.auditLog.find((r) => r.action === "staff.rol_actualizado");
    expect(fila).toMatchObject({ entityType: "membership", entityId: id, antes: "operador:solo_calendario", despues: "operador:acceso_total" });
    expect(fila?.despues).not.toContain("@");
  });

  it("nunca el propio rol (400), rol invalido (400), target ajeno (404), y roles sin permiso (403)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const patch = (token: string, id: string, body: unknown) => app.request(`${base(ctx)}/miembros/${id}`, authedJson(token, body, {}, "PATCH"));
    expect((await patch(ctx.staff.adminGestora.token, ctx.staff.adminGestora.id, { verticalRole: "contador" })).status).toBe(400);
    expect((await patch(ctx.staff.adminGestora.token, ctx.staff.contador.id, { verticalRole: "owner" })).status).toBe(400);
    expect((await patch(ctx.staff.adminGestora.token, "00000000-0000-4000-8000-000000000000", { verticalRole: "contador" })).status).toBe(404);
    expect((await patch(ctx.staff.operadorAccesoTotal.token, ctx.staff.contador.id, { verticalRole: "limpieza" })).status).toBe(403);
    expect((await patch(ctx.staff.contador.token, ctx.staff.limpieza.id, { verticalRole: "contador" })).status).toBe(403);
  });
});

describe("DELETE .../miembros/:userId -- baja", () => {
  it("admin_gestora da de baja a un contador: desaparece del listado y queda en la bitacora con el rol que tenia", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = ctx.staff.contador.id;
    const res = await app.request(`${base(ctx)}/miembros/${id}`, del(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const lista = (await (await app.request(`${base(ctx)}/miembros`, get(ctx.staff.adminGestora.token))).json()) as { miembros: MemberResponse[] };
    expect(lista.miembros.map((m) => m.id)).not.toContain(id);
    expect(ctx.rentasRepo.auditLog.find((r) => r.action === "staff.baja")).toMatchObject({ entityType: "membership", entityId: id, antes: "contador", despues: null });
  });

  it("nunca auto-baja (400); un ajeno (404); roles sin permiso (403)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(`${base(ctx)}/miembros/${ctx.staff.adminGestora.id}`, del(ctx.staff.adminGestora.token))).status).toBe(400);
    expect((await app.request(`${base(ctx)}/miembros/00000000-0000-4000-8000-000000000000`, del(ctx.staff.adminGestora.token))).status).toBe(404);
    expect((await app.request(`${base(ctx)}/miembros/${ctx.staff.contador.id}`, del(ctx.staff.operadorAccesoTotal.token))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/miembros/${ctx.staff.limpieza.id}`, del(ctx.staff.limpieza.token))).status).toBe(403);
  });

  it("nunca deja la organizacion sin admin_gestora: con otro admin SI se puede dar de baja a uno, con uno solo no", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // Un segundo admin_gestora con membership real en el motor (el fixture solo siembra uno).
    const core = ctx.deps.coreRepo as InMemoryCoreRepository;
    const segundoId = randomUUID();
    const password = "correcto-caballo-batería";
    core.addStaff({ id: segundoId, email: "segundo-admin@rentas.mx", fullName: "Segundo Admin", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    core.addMembership({ userId: segundoId, organizationId: ctx.organizationId, platformRole: "owner", verticalRole: "admin_gestora", propertyIds: null });
    (ctx.engine as InMemoryRentasTenancyEngine).seedMembership({ userId: segundoId, organizationId: ctx.organizationId, platformRole: "owner", verticalRole: "admin_gestora", propertyIds: null });
    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "segundo-admin@rentas.mx", password }) });
    const segundo = (await login.json()) as { token: string };

    // El segundo admin da de baja al primero (hay dos): permitido. Ahora queda uno solo: nadie puede quitarlo.
    expect((await app.request(`${base(ctx)}/miembros/${ctx.staff.adminGestora.id}`, del(segundo.token))).status).toBe(200);
    expect((await app.request(`${base(ctx)}/miembros/${segundoId}`, del(segundo.token))).status).toBe(400);
  });
});
