// Hallazgo de auditoría (severidad ALTA, "Alta de organización/staff imposible
// sin SQL") — HTTP end-to-end de admin-staff.ts (alta/gestión de cuentas de
// staff) + POST /auth/accept-invite (routes/auth.ts, lado del invitado,
// genérico de core). Port EXACTO de apps/api/tests/restaurantes-admin-staff.spec.ts
// (leído primero como plantilla) sobre `buildDespachosTestContext` y los 4
// roles de despachos (admin/contador/auditor/readonly) en vez de los de
// restaurantes -- sin la sección de "repartidores" (despachos no tiene un rol
// análogo con selector propio en otra ruta).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import type { InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";

interface InviteResponse {
  readonly id: string;
  readonly email: string;
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
  readonly status: string;
  readonly expiresAt: string;
  readonly inviteToken: string;
}

interface AcceptInviteResponse {
  readonly token: string;
  readonly refreshToken: string;
  readonly email: string;
  readonly organizations: ReadonlyArray<{ id: string; nombre: string; vertical: string; rol: string }>;
}

function authedDelete(token: string): RequestInit {
  return { method: "DELETE", headers: { authorization: `Bearer ${token}` } };
}

describe("POST /despachos/:propertyId/admin/staff/invitaciones", () => {
  it("admin invita a un nuevo 'contador' -- 201, genera un token real (nunca un insert directo silencioso), queda 'pending', acotado al property actual", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token, { email: "nuevo-contador@despacho-de-prueba.mx", verticalRole: "contador" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteResponse;
    expect(body.email).toBe("nuevo-contador@despacho-de-prueba.mx");
    expect(body.verticalRole).toBe("contador");
    expect(body.status).toBe("pending");
    expect(body.inviteToken.length).toBeGreaterThan(20);
    // El invitado se limita al MISMO property que el invitador ya tenía abierto en
    // el panel, nunca uno más amplio ni inventado.
    expect(body.propertyIds).toEqual([ctx.propertyId]);

    const listado = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token));
    expect(listado.status).toBe(200);
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.email)).toContain("nuevo-contador@despacho-de-prueba.mx");
    // El token plano NUNCA se repite en el listado -- solo se devolvió una vez, en la
    // respuesta de creación.
    expect(listadoBody.invitations[0]).not.toHaveProperty("inviteToken");
  });

  it.each(["contador", "auditor", "readonly"] as const)("%s (fuera de STAFF_INVITE_ROLES) -> 403, nunca puede invitar", async (role) => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff[role].token, { email: "x@despacho-de-prueba.mx", verticalRole: "contador" }));
    expect(res.status).toBe(403);
  });

  it("verticalRole desconocido -> 400", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token, { email: "x@despacho-de-prueba.mx", verticalRole: "gerente" }));
    expect(res.status).toBe(400);
  });

  it("email inválido -> 400", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token, { email: "no-es-un-correo", verticalRole: "contador" }));
    expect(res.status).toBe(400);
  });

  it("invitar un correo que YA es staff de esta organización -> 409, nunca genera una invitación fantasma", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token, { email: ctx.staff.contador.email, verticalRole: "contador" }));
    expect(res.status).toBe(409);
  });

  it("admin de OTRA organización -- 403 al intentar sobre un property que no es suyo (requirePropertyMembership, defensa en profundidad de siempre)", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const otraOrgId = randomUUID();
    const otroAdminId = randomUUID();
    const email = "otro-admin@otro-despacho.mx";
    const password = "correcto-caballo-batería";
    const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
    coreRepo.addOrganization({ id: otraOrgId, slug: "otro-despacho", name: "Otro Despacho SC", vertical: "despachos" });
    coreRepo.addStaff({ id: otroAdminId, email, fullName: "Otro Admin", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addMembership({ userId: otroAdminId, organizationId: otraOrgId, platformRole: "owner", verticalRole: "admin", propertyIds: null });
    (ctx.deps.engine as InMemoryTenancyEngine).seedMembership({ userId: otroAdminId, organizationId: otraOrgId, platformRole: "owner", verticalRole: "admin", propertyIds: null });

    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const { token: otroAdminToken } = (await login.json()) as { token: string };

    const res = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(otroAdminToken, { email: "x@otro-despacho.mx", verticalRole: "contador" }));
    expect(res.status).toBe(403);
  });

  it("además de devolver el token, encola el correo real de invitación (channel='email') con el enlace de activación", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token, { email: "correo-real@despacho-de-prueba.mx", verticalRole: "auditor" }));
    expect(res.status).toBe(201);
    const { inviteToken } = (await res.json()) as InviteResponse;

    const job = ctx.despachosRepo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "staff.invite");
    expect(job).toBeDefined();
    expect(job?.status).toBe("pending");
    const payload = job?.payload as { to: string; subject: string; html: string; text: string };
    expect(payload.to).toBe("correo-real@despacho-de-prueba.mx");
    expect(payload.html).toContain(encodeURIComponent(inviteToken));
    expect(payload.text).toContain(inviteToken);
  });
});

describe("POST /auth/accept-invite -- el invitado acepta y queda vinculado", () => {
  it("token real, fullName y password -> 200, crea el staff_user + membership, y devuelve sesión ya autenticada", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token, { email: "invitado-real@despacho-de-prueba.mx", verticalRole: "readonly" }));
    const { inviteToken } = (await invite.json()) as InviteResponse;

    const accept = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, fullName: "Invitado Readonly", password: "correcto-caballo-batería" }),
    });
    expect(accept.status).toBe(200);
    const session = (await accept.json()) as AcceptInviteResponse;
    expect(session.email).toBe("invitado-real@despacho-de-prueba.mx");
    const org = session.organizations.find((o) => o.id === ctx.organizationId);
    expect(org?.rol).toBe("readonly");

    // Queda REALMENTE vinculado -- puede usar su propio token para /auth/me.
    const me = await app.request("/auth/me", authedJson(session.token));
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { email: string; organizations: Array<{ rol: string }> };
    expect(meBody.email).toBe("invitado-real@despacho-de-prueba.mx");
    expect(meBody.organizations.some((o) => o.rol === "readonly")).toBe(true);

    // La invitación ya no aparece como pendiente.
    const listado = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token));
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.email)).not.toContain("invitado-real@despacho-de-prueba.mx");
  });

  it("token inexistente -> 400, nunca crea nada", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token-que-nunca-existio", fullName: "X", password: "correcto-caballo-batería" }),
    });
    expect(res.status).toBe(400);
  });

  it("un token ya usado no se puede volver a aceptar (de un solo uso, real)", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token, { email: "una-sola-vez@despacho-de-prueba.mx", verticalRole: "contador" }));
    const { inviteToken } = (await invite.json()) as InviteResponse;

    const primera = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, fullName: "Primera Vez", password: "correcto-caballo-batería" }),
    });
    expect(primera.status).toBe(200);

    const segunda = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, fullName: "Segunda Vez", password: "otra-contraseña-larga" }),
    });
    expect(segunda.status).toBe(400);
  });
});

describe("DELETE /despachos/:propertyId/admin/staff/invitaciones/:inviteId -- revocar", () => {
  it("admin revoca una invitación pending -- ya no es aceptable ni aparece en el listado", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token, { email: "revocado@despacho-de-prueba.mx", verticalRole: "contador" }));
    const created = (await invite.json()) as InviteResponse;

    const del = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones/${created.id}`, authedDelete(ctx.staff.admin.token));
    expect(del.status).toBe(200);

    const listado = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token));
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.id)).not.toContain(created.id);

    const accept = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: created.inviteToken, fullName: "Tarde", password: "correcto-caballo-batería" }),
    });
    expect(accept.status).toBe(400);
  });

  it("revocar una invitación inexistente -> 404", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const del = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones/00000000-0000-0000-0000-000000000000`, authedDelete(ctx.staff.admin.token));
    expect(del.status).toBe(404);
  });

  it.each(["contador", "auditor", "readonly"] as const)("%s no puede revocar (fuera de STAFF_INVITE_ROLES) -> 403", async (role) => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.admin.token, { email: `sin-revocar-${role}@despacho-de-prueba.mx`, verticalRole: "contador" }));
    const created = (await invite.json()) as InviteResponse;

    const del = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones/${created.id}`, authedDelete(ctx.staff[role].token));
    expect(del.status).toBe(403);
  });
});
