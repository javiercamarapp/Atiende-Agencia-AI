// Fase 12 citas — hallazgo de auditoría (CRÍTICO/ALTO, "citas define 3 roles de
// plataforma pero no los aplica en NINGUNA capa"): HTTP end-to-end de
// admin-staff.ts (alta/gestión de cuentas de staff) + POST /auth/accept-invite
// (routes/auth.ts, lado del invitado, genérico de core). Mismo patrón exacto que
// apps/api/tests/restaurantes-admin-staff.spec.ts (único vertical con esto ya
// probado antes de esta rama), sin la superficie de "repartidores" (citas no tiene
// ese concepto — ver domain-citas/src/roles.ts: solo owner/admin/staff).
import { describe, expect, it } from "vitest";
import type { InMemoryTenancyEngine } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildCitasTestContext } from "./citas-fixtures.ts";

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

describe("POST /v1/citas/properties/:propertyId/admin/staff/invitaciones", () => {
  it("owner invita a un nuevo 'staff' -- 201, genera un token real (nunca un insert directo silencioso), queda 'pending'", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "nuevo-staff@clinica-dental-sonrisas.mx", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteResponse;
    expect(body.email).toBe("nuevo-staff@clinica-dental-sonrisas.mx");
    expect(body.verticalRole).toBe("staff");
    expect(body.status).toBe("pending");
    expect(body.inviteToken.length).toBeGreaterThan(20);
    // El owner tiene propertyIds:null (org-wide) -- el invitado hereda ese MISMO
    // alcance, nunca uno más amplio ni inventado.
    expect(body.propertyIds).toBeNull();

    const listado = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`, authedGet(ctx.staff.owner.token));
    expect(listado.status).toBe(200);
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.email)).toContain("nuevo-staff@clinica-dental-sonrisas.mx");
    // El token plano NUNCA se repite en el listado -- solo se devolvió una vez, en la
    // respuesta de creación.
    expect(listadoBody.invitations[0]).not.toHaveProperty("inviteToken");
  });

  it("staff (verticalRole 'staff', fuera de STAFF_INVITE_ROLES) -> 403, nunca puede invitar", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.staffMember.token, { email: "x@clinica-dental-sonrisas.mx", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(403);
  });

  it("verticalRole desconocido -> 400", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "x@clinica-dental-sonrisas.mx", verticalRole: "repartidor" }, "POST"),
    );
    expect(res.status).toBe(400);
  });

  it("email inválido -> 400", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "no-es-un-correo", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(400);
  });

  it("invitar un correo que YA es staff de esta organización -> 409, nunca genera una invitación fantasma", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: ctx.staff.staffMember.email, verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(409);
  });

  // Hallazgo de auditoría cerrado en esta misma pasada: hasta ahora el token solo se
  // devolvía en la respuesta HTTP, sin ningún canal de envío real -- ver el comentario
  // de cabecera de admin-staff.ts. Verifica el encolado REAL en
  // `citas.messaging_outbox` (channel='email'), nunca solo que la respuesta HTTP
  // siga trayendo el token (eso ya lo cubre el primer test de este describe).
  it("además de devolver el token, encola el correo real de invitación (channel='email') con el enlace de activación", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "correo-real@clinica-dental-sonrisas.mx", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(201);
    const { inviteToken } = (await res.json()) as InviteResponse;

    const job = ctx.citasRepo.getOutbox().find((o) => o.channel === "email" && o.eventType === "staff.invite");
    expect(job).toBeDefined();
    expect(job?.status).toBe("pending");
    const payload = job?.payload as { to: string; subject: string; html: string; text: string };
    expect(payload.to).toBe("correo-real@clinica-dental-sonrisas.mx");
    expect(payload.html).toContain(encodeURIComponent(inviteToken));
    expect(payload.text).toContain(inviteToken);
  });
});

describe("POST /auth/accept-invite -- el invitado acepta y queda vinculado", () => {
  it("token real, fullName y password -> 200, crea el staff_user + membership, y devuelve sesión ya autenticada", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "invitado-real@clinica-dental-sonrisas.mx", verticalRole: "admin" }, "POST"),
    );
    const { inviteToken } = (await invite.json()) as InviteResponse;

    const accept = await app.request("/auth/accept-invite", authedJson("", { token: inviteToken, fullName: "Invitado Real", password: "correcto-caballo-batería" }, "POST"));
    expect(accept.status).toBe(200);
    const session = (await accept.json()) as AcceptInviteResponse;
    expect(session.email).toBe("invitado-real@clinica-dental-sonrisas.mx");
    const org = session.organizations.find((o) => o.id === ctx.organizationId);
    expect(org?.rol).toBe("admin");

    // Queda REALMENTE vinculado -- puede usar su propio token para /auth/me.
    const me = await app.request("/auth/me", authedGet(session.token));
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { email: string; organizations: Array<{ rol: string }> };
    expect(meBody.email).toBe("invitado-real@clinica-dental-sonrisas.mx");
    expect(meBody.organizations.some((o) => o.rol === "admin")).toBe(true);

    // La invitación ya no aparece como pendiente.
    const listado = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`, authedGet(ctx.staff.owner.token));
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.email)).not.toContain("invitado-real@clinica-dental-sonrisas.mx");
  });

  it("un token ya usado no se puede volver a aceptar (de un solo uso, real)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "una-sola-vez@clinica-dental-sonrisas.mx", verticalRole: "staff" }, "POST"),
    );
    const { inviteToken } = (await invite.json()) as InviteResponse;

    const primera = await app.request("/auth/accept-invite", authedJson("", { token: inviteToken, fullName: "Primera Vez", password: "correcto-caballo-batería" }, "POST"));
    expect(primera.status).toBe(200);

    const segunda = await app.request("/auth/accept-invite", authedJson("", { token: inviteToken, fullName: "Segunda Vez", password: "otra-contraseña-larga" }, "POST"));
    expect(segunda.status).toBe(400);
  });
});

describe("DELETE /v1/citas/properties/:propertyId/admin/staff/invitaciones/:inviteId -- revocar", () => {
  it("owner revoca una invitación pending -- ya no es aceptable ni aparece en el listado", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "revocado@clinica-dental-sonrisas.mx", verticalRole: "staff" }, "POST"),
    );
    const created = (await invite.json()) as InviteResponse;

    const del = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones/${created.id}`, authedJson(ctx.staff.owner.token, undefined, "DELETE"));
    expect(del.status).toBe(200);

    const listado = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`, authedGet(ctx.staff.owner.token));
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.id)).not.toContain(created.id);

    const accept = await app.request("/auth/accept-invite", authedJson("", { token: created.inviteToken, fullName: "Tarde", password: "correcto-caballo-batería" }, "POST"));
    expect(accept.status).toBe(400);
  });

  it("revocar una invitación inexistente -> 404", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const del = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones/00000000-0000-0000-0000-000000000000`,
      authedJson(ctx.staff.owner.token, undefined, "DELETE"),
    );
    expect(del.status).toBe(404);
  });
});

describe("Jerarquía real (canInviteStaff, @atiende/core-authz) -- un admin nunca da de alta a otro owner", () => {
  it("owner invita a un 'admin'; ese admin SÍ puede invitar 'staff' pero NUNCA 'owner'", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const inviteAdmin = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "admin-nuevo@clinica-dental-sonrisas.mx", verticalRole: "admin" }, "POST"),
    );
    expect(inviteAdmin.status).toBe(201);
    const { inviteToken } = (await inviteAdmin.json()) as InviteResponse;

    const accept = await app.request("/auth/accept-invite", authedJson("", { token: inviteToken, fullName: "Admin Nuevo", password: "correcto-caballo-batería" }, "POST"));
    expect(accept.status).toBe(200);
    const adminToken = ((await accept.json()) as AcceptInviteResponse).token;

    // `acceptStaffInvite` escribe la membership real en `core.membership` (en
    // producción, la MISMA tabla que consulta `requirePropertyMembership`) -- pero en
    // tests, `InMemoryTenancyEngine` es un doble aparte de `InMemoryCoreRepository`
    // (dos Maps en memoria distintos) -- mismo seed manual que ya hace
    // citas-fixtures.ts para el staff sembrado de antemano. Esto NO es necesario en
    // producción real (una sola tabla), solo en el doble de pruebas.
    const me = await app.request("/auth/me", authedGet(adminToken));
    const adminId = ((await me.json()) as { id: string }).id;
    (ctx.deps.engine as InMemoryTenancyEngine).seedMembership({ userId: adminId, organizationId: ctx.organizationId, propertyIds: null, platformRole: "admin", verticalRole: "admin" });

    // El admin SÍ puede invitar a otro "staff" (su propio techo hacia abajo).
    const adminInvitaStaff = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(adminToken, { email: "staff-por-admin@clinica-dental-sonrisas.mx", verticalRole: "staff" }, "POST"),
    );
    expect(adminInvitaStaff.status).toBe(201);

    // El admin NUNCA puede invitar a un "owner" (jerarquía mayor que la suya) --
    // aunque "admin" SÍ está en STAFF_INVITE_ROLES, `canInviteStaff` lo bloquea.
    const adminInvitaOwner = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`,
      authedJson(adminToken, { email: "otro-owner@clinica-dental-sonrisas.mx", verticalRole: "owner" }, "POST"),
    );
    expect(adminInvitaOwner.status).toBe(403);
  });
});
