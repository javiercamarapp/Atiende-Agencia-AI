// Fix hallazgo auditoría (rubro 1, "completitud funcional" — "alta de cliente
// pagando de principio a fin: organización + property + staff + primera venta"):
// hoteles era la única de las 6 verticales sin ningún camino de producto para dar
// de alta staff ADICIONAL una vez creado el primer owner/gm. HTTP end-to-end de
// admin-staff.ts + POST /auth/accept-invite (routes/auth.ts, lado del invitado,
// genérico de core) — mismo patrón/mismas aserciones que
// apps/api/tests/restaurantes-admin-staff.spec.ts, adaptado a los 8 roles finos
// de hoteles (HOTEL_ROLES) en vez de los 4 de restaurantes.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

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

let ctx: HotelesTestContext;

describe("POST /v1/hoteles/:propertyId/admin/staff/invitaciones", () => {
  it("owner invita a un nuevo 'frontdesk' -- 201, genera un token real, queda 'pending'", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "nuevo-frontdesk@hotel-de-prueba.mx", verticalRole: "frontdesk" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteResponse;
    expect(body.email).toBe("nuevo-frontdesk@hotel-de-prueba.mx");
    expect(body.verticalRole).toBe("frontdesk");
    expect(body.status).toBe("pending");
    expect(body.inviteToken.length).toBeGreaterThan(20);
    // El owner tiene propertyIds:null (org-wide) -- el invitado hereda ese MISMO
    // alcance, nunca uno más amplio ni inventado.
    expect(body.propertyIds).toBeNull();

    const listado = await app.request(`/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token));
    expect(listado.status).toBe(200);
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.email)).toContain("nuevo-frontdesk@hotel-de-prueba.mx");
    // El token plano NUNCA se repite en el listado -- solo se devolvió una vez, en la
    // respuesta de creación.
    expect(listadoBody.invitations[0]).not.toHaveProperty("inviteToken");
  });

  it("un rol operativo (frontdesk, fuera de STAFF_INVITE_ROLES) -> 403, nunca puede invitar", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.frontdesk.token, { email: "x@hotel-de-prueba.mx", verticalRole: "frontdesk" }),
    );
    expect(res.status).toBe(403);
  });

  it("accountant -> 403, nunca puede invitar (solo owner/gm, ADMIN_ROLES)", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.accountant.token, { email: "x@hotel-de-prueba.mx", verticalRole: "frontdesk" }),
    );
    expect(res.status).toBe(403);
  });

  it("verticalRole desconocido -> 400", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "x@hotel-de-prueba.mx", verticalRole: "conserje" }),
    );
    expect(res.status).toBe(400);
  });

  it("email inválido -> 400", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "no-es-un-correo", verticalRole: "frontdesk" }),
    );
    expect(res.status).toBe(400);
  });

  it("invitar un correo que YA es staff de esta organización -> 409, nunca genera una invitación fantasma", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: ctx.staff.frontdesk.email, verticalRole: "frontdesk" }),
    );
    expect(res.status).toBe(409);
  });

  it("owner de OTRA organización -- 403 al intentar sobre una property que no es suya (requirePropertyMembership, defensa en profundidad de siempre)", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const otraOrg = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(otraOrg.staff.owner.token, { email: "x@otro-hotel.mx", verticalRole: "frontdesk" }),
    );
    expect(res.status).toBe(403);
  });

  it("además de devolver el token, encola el correo real de invitación (channel='email') con el enlace de activación", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "correo-real@hotel-de-prueba.mx", verticalRole: "frontdesk" }),
    );
    expect(res.status).toBe(201);
    const { inviteToken } = (await res.json()) as InviteResponse;

    const job = ctx.hotelesRepo.getOutbox().find((o) => o.channel === "email" && o.eventType === "staff.invite");
    expect(job).toBeDefined();
    expect(job?.status).toBe("pending");
    const payload = job?.payload as { to: string; subject: string; html: string; text: string };
    expect(payload.to).toBe("correo-real@hotel-de-prueba.mx");
    expect(payload.html).toContain(encodeURIComponent(inviteToken));
    expect(payload.text).toContain(inviteToken);
  });
});

describe("POST /auth/accept-invite -- el invitado acepta y queda vinculado (hoteles)", () => {
  it("token real, fullName y password -> 200, crea el staff_user + membership, y devuelve sesión ya autenticada", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "invitado-real@hotel-de-prueba.mx", verticalRole: "housekeeping" }),
    );
    const { inviteToken } = (await invite.json()) as InviteResponse;

    const accept = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, fullName: "Housekeeping Invitado", password: "correcto-caballo-batería" }),
    });
    expect(accept.status).toBe(200);
    const session = (await accept.json()) as AcceptInviteResponse;
    expect(session.email).toBe("invitado-real@hotel-de-prueba.mx");
    const org = session.organizations.find((o) => o.id === ctx.organizationId);
    expect(org?.rol).toBe("housekeeping");

    // Queda REALMENTE vinculado -- puede usar su propio token para /auth/me.
    const me = await app.request("/auth/me", authedJson(session.token));
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { email: string; organizations: Array<{ rol: string }> };
    expect(meBody.email).toBe("invitado-real@hotel-de-prueba.mx");
    expect(meBody.organizations.some((o) => o.rol === "housekeeping")).toBe(true);

    // La invitación ya no aparece como pendiente.
    const listado = await app.request(`/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token));
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.email)).not.toContain("invitado-real@hotel-de-prueba.mx");
  });

  it("token inexistente -> 400, nunca crea nada", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token-que-nunca-existio", fullName: "X", password: "correcto-caballo-batería" }),
    });
    expect(res.status).toBe(400);
  });

  it("un token ya usado no se puede volver a aceptar (de un solo uso, real)", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "una-sola-vez@hotel-de-prueba.mx", verticalRole: "frontdesk" }),
    );
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

describe("DELETE /v1/hoteles/:propertyId/admin/staff/invitaciones/:inviteId -- revocar", () => {
  it("owner revoca una invitación pending -- ya no es aceptable ni aparece en el listado", async () => {
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(
      `/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "revocado@hotel-de-prueba.mx", verticalRole: "frontdesk" }),
    );
    const created = (await invite.json()) as InviteResponse;

    const del = await app.request(`/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones/${created.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(del.status).toBe(200);

    const listado = await app.request(`/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token));
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
    ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const del = await app.request(`/v1/hoteles/${ctx.propertyId}/admin/staff/invitaciones/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(del.status).toBe(404);
  });
});
