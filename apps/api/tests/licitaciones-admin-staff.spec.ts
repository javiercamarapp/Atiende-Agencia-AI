// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): verificado contra el
// código real que `admin-staff.ts` de licitaciones (POST/GET/DELETE invitaciones,
// construido desde el hallazgo original "alta de organización/staff imposible sin
// SQL") nunca tuvo NINGÚN test HTTP end-to-end -- a diferencia de
// restaurantes/despachos/citas (que ya tenían su propio *-admin-staff.spec.ts),
// esta vertical no traía ni siquiera este archivo. Este archivo cierra ambos
// huecos: cobertura HTTP real del CRUD de invitaciones que ya existía, y de las
// dos rutas nuevas de esta pasada (GET/PATCH miembros) — mismo patrón exacto que
// apps/api/tests/restaurantes-admin-staff.spec.ts (leído primero como plantilla)
// sobre los 6 roles de licitaciones.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";

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

interface MemberWithRoleResponse {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
}

function authedDelete(token: string): RequestInit {
  return { method: "DELETE", headers: { authorization: `Bearer ${token}` } };
}

function authedPatch(token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) }, body: raw };
}

describe("POST /v1/licitaciones/:propertyId/admin/staff/invitaciones", () => {
  it("owner invita a un nuevo 'analyst' -- 201, genera un token real, queda 'pending'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "nuevo-analyst@empresa-de-prueba.mx", verticalRole: "analyst" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteResponse;
    expect(body.email).toBe("nuevo-analyst@empresa-de-prueba.mx");
    expect(body.verticalRole).toBe("analyst");
    expect(body.status).toBe("pending");
    expect(body.inviteToken.length).toBeGreaterThan(20);

    const listado = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token));
    expect(listado.status).toBe(200);
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.email)).toContain("nuevo-analyst@empresa-de-prueba.mx");
    expect(listadoBody.invitations[0]).not.toHaveProperty("inviteToken");
  });

  it.each(["analyst", "writer", "reviewer", "viewer"] as const)("%s (fuera de STAFF_INVITE_ROLES) -> 403, nunca puede invitar", async (role) => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff[role].token, { email: "x@empresa-de-prueba.mx", verticalRole: "analyst" }));
    expect(res.status).toBe(403);
  });

  it("verticalRole desconocido -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "x@empresa-de-prueba.mx", verticalRole: "gerente" }));
    expect(res.status).toBe(400);
  });

  it("email inválido -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "no-es-un-correo", verticalRole: "analyst" }));
    expect(res.status).toBe(400);
  });

  it("invitar un correo que YA es staff de esta organización -> 409, nunca genera una invitación fantasma", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: ctx.staff.analyst.email, verticalRole: "analyst" }));
    expect(res.status).toBe(409);
  });
});

describe("POST /auth/accept-invite -- el invitado acepta y queda vinculado", () => {
  it("token real, fullName y password -> 200, crea el staff_user + membership, y devuelve sesión ya autenticada", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "invitado-real@empresa-de-prueba.mx", verticalRole: "writer" }));
    const { inviteToken } = (await invite.json()) as InviteResponse;

    const accept = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, fullName: "Invitado Real", password: "correcto-caballo-batería" }),
    });
    expect(accept.status).toBe(200);
    const session = (await accept.json()) as AcceptInviteResponse;
    expect(session.email).toBe("invitado-real@empresa-de-prueba.mx");
    const org = session.organizations.find((o) => o.id === ctx.organizationId);
    expect(org?.rol).toBe("writer");
  });

  it("token inexistente -> 400, nunca crea nada", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token-que-nunca-existio", fullName: "X", password: "correcto-caballo-batería" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/licitaciones/:propertyId/admin/staff/invitaciones/:inviteId -- revocar", () => {
  it("owner revoca una invitación pending -- ya no es aceptable ni aparece en el listado", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "revocado@empresa-de-prueba.mx", verticalRole: "analyst" }));
    const created = (await invite.json()) as InviteResponse;

    const del = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones/${created.id}`, authedDelete(ctx.staff.owner.token));
    expect(del.status).toBe(200);

    const listado = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token));
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.id)).not.toContain(created.id);
  });

  it("revocar una invitación inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const del = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones/00000000-0000-0000-0000-000000000000`, authedDelete(ctx.staff.owner.token));
    expect(del.status).toBe(404);
  });
});

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA): las dos
// rutas nuevas de esta pasada.
describe("GET /v1/licitaciones/:propertyId/admin/staff/miembros y PATCH .../miembros/:userId", () => {
  it("owner ve a TODOS los miembros ya aceptados con su rol actual", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/miembros`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { miembros: MemberWithRoleResponse[] };
    const byId = new Map(body.miembros.map((m) => [m.id, m]));
    expect(byId.get(ctx.staff.owner.id)?.verticalRole).toBe("owner");
    expect(byId.get(ctx.staff.analyst.id)?.verticalRole).toBe("analyst");
  });

  it("analyst (fuera de STAFF_INVITE_ROLES) -> 403 al listar o cambiar roles", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const listRes = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/miembros`, authedJson(ctx.staff.analyst.token));
    expect(listRes.status).toBe(403);

    const patchRes = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/miembros/${ctx.staff.viewer.id}`, authedPatch(ctx.staff.analyst.token, { verticalRole: "writer" }));
    expect(patchRes.status).toBe(403);
  });

  it("owner cambia a un analyst a 'reviewer' -- 200, el cambio persiste en el listado", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/miembros/${ctx.staff.analyst.id}`, authedPatch(ctx.staff.owner.token, { verticalRole: "reviewer" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemberWithRoleResponse;
    expect(body.verticalRole).toBe("reviewer");

    const listado = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/miembros`, authedJson(ctx.staff.owner.token));
    const listadoBody = (await listado.json()) as { miembros: MemberWithRoleResponse[] };
    expect(listadoBody.miembros.find((m) => m.id === ctx.staff.analyst.id)?.verticalRole).toBe("reviewer");
  });

  it("verticalRole desconocido -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/miembros/${ctx.staff.analyst.id}`, authedPatch(ctx.staff.owner.token, { verticalRole: "gerente" }));
    expect(res.status).toBe(400);
  });

  it("un owner nunca puede cambiar SU PROPIO rol -- 400, bloqueado antes de tocar la base de datos", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/miembros/${ctx.staff.owner.id}`, authedPatch(ctx.staff.owner.token, { verticalRole: "admin" }));
    expect(res.status).toBe(400);
  });
});
