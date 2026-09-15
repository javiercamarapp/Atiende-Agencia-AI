// Fase 10 restaurantes — HTTP end-to-end de admin-staff.ts (alta/gestión de cuentas
// de staff) + POST /auth/accept-invite (routes/auth.ts, lado del invitado, genérico
// de core). Reusa `buildRestaurantesKpiTestContext` (owner org-wide, staffSucursalA
// acotado SOLO a propertyIdA, repartidor, otroOrgOwner de OTRA organización) — mismo
// fixture que ya usan admin-branches/admin-orders/repartidor-orders.
import { describe, expect, it } from "vitest";
import type { InMemoryTenancyEngine } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

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

describe("POST /v1/restaurantes/:propertyId/admin/staff/invitaciones", () => {
  it("owner invita a un nuevo 'staff' -- 201, genera un token real (nunca un insert directo silencioso), queda 'pending'", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "nuevo-staff@lostaquitos.mx", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteResponse;
    expect(body.email).toBe("nuevo-staff@lostaquitos.mx");
    expect(body.verticalRole).toBe("staff");
    expect(body.status).toBe("pending");
    expect(body.inviteToken.length).toBeGreaterThan(20);
    // El owner tiene propertyIds:null (org-wide) -- el invitado hereda ese MISMO
    // alcance, nunca uno más amplio ni inventado.
    expect(body.propertyIds).toBeNull();

    const listado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`, authedGet(ctx.staff.owner.token));
    expect(listado.status).toBe(200);
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.email)).toContain("nuevo-staff@lostaquitos.mx");
    // El token plano NUNCA se repite en el listado -- solo se devolvió una vez, en la
    // respuesta de creación.
    expect(listadoBody.invitations[0]).not.toHaveProperty("inviteToken");
  });

  it("staff (verticalRole 'staff', fuera de STAFF_INVITE_ROLES) -> 403, nunca puede invitar", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.staffSucursalA.token, { email: "x@lostaquitos.mx", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(403);
  });

  it("repartidor -> 403, nunca puede invitar", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.repartidor.token, { email: "x@lostaquitos.mx", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(403);
  });

  it("verticalRole desconocido -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "x@lostaquitos.mx", verticalRole: "gerente" }, "POST"),
    );
    expect(res.status).toBe(400);
  });

  it("email inválido -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "no-es-un-correo", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(400);
  });

  it("invitar un correo que YA es staff de esta organización -> 409, nunca genera una invitación fantasma", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: ctx.staff.staffSucursalA.email, verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(409);
  });

  it("owner de OTRA organización -- 403 al intentar sobre una property que no es suya (requirePropertyMembership, defensa en profundidad de siempre)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.otroOrgOwner.token, { email: "x@otro.mx", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(403);
  });

  // Hallazgo de auditoría cerrado en esta misma pasada: hasta ahora el token solo se
  // devolvía en la respuesta HTTP, sin ningún canal de envío real -- ver el comentario
  // de cabecera de admin-staff.ts. Verifica el encolado REAL en
  // `restaurantes.messaging_outbox` (channel='email'), nunca solo que la respuesta
  // HTTP siga trayendo el token (eso ya lo cubre el primer test de este describe).
  it("además de devolver el token, encola el correo real de invitación (channel='email') con el enlace de activación", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "correo-real@lostaquitos.mx", verticalRole: "staff" }, "POST"),
    );
    expect(res.status).toBe(201);
    const { inviteToken } = (await res.json()) as InviteResponse;

    const job = ctx.restaurantesRepo.getOutbox().find((o) => o.channel === "email" && o.eventType === "staff.invite");
    expect(job).toBeDefined();
    expect(job?.status).toBe("pending");
    const payload = job?.payload as { to: string; subject: string; html: string; text: string };
    expect(payload.to).toBe("correo-real@lostaquitos.mx");
    expect(payload.html).toContain(encodeURIComponent(inviteToken));
    expect(payload.text).toContain(inviteToken);
  });
});

describe("POST /auth/accept-invite -- el invitado acepta y queda vinculado", () => {
  it("token real, fullName y password -> 200, crea el staff_user + membership, y devuelve sesión ya autenticada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "invitado-real@lostaquitos.mx", verticalRole: "repartidor" }, "POST"),
    );
    const { inviteToken } = (await invite.json()) as InviteResponse;

    const accept = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, fullName: "Repartidor Invitado", password: "correcto-caballo-batería" }),
    });
    expect(accept.status).toBe(200);
    const session = (await accept.json()) as AcceptInviteResponse;
    expect(session.email).toBe("invitado-real@lostaquitos.mx");
    const org = session.organizations.find((o) => o.id === ctx.organizationId);
    expect(org?.rol).toBe("repartidor");

    // Queda REALMENTE vinculado -- puede usar su propio token para /auth/me.
    const me = await app.request("/auth/me", authedGet(session.token));
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { email: string; organizations: Array<{ rol: string }> };
    expect(meBody.email).toBe("invitado-real@lostaquitos.mx");
    expect(meBody.organizations.some((o) => o.rol === "repartidor")).toBe(true);

    // La invitación ya no aparece como pendiente.
    const listado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`, authedGet(ctx.staff.owner.token));
    const listadoBody = (await listado.json()) as { invitations: InviteResponse[] };
    expect(listadoBody.invitations.map((i) => i.email)).not.toContain("invitado-real@lostaquitos.mx");
  });

  it("token inexistente -> 400, nunca crea nada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token-que-nunca-existio", fullName: "X", password: "correcto-caballo-batería" }),
    });
    expect(res.status).toBe(400);
  });

  it("un token ya usado no se puede volver a aceptar (de un solo uso, real)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "una-sola-vez@lostaquitos.mx", verticalRole: "staff" }, "POST"),
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

  it("password menor a 8 caracteres -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "cualquiera", fullName: "X", password: "corta" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/restaurantes/:propertyId/admin/staff/invitaciones/:inviteId -- revocar", () => {
  it("owner revoca una invitación pending -- ya no es aceptable ni aparece en el listado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invite = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "revocado@lostaquitos.mx", verticalRole: "staff" }, "POST"),
    );
    const created = (await invite.json()) as InviteResponse;

    const del = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones/${created.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(del.status).toBe(200);

    const listado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`, authedGet(ctx.staff.owner.token));
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
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const del = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(del.status).toBe(404);
  });
});

// Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido no
// tiene UI: el panel de repartidor siempre estará vacío"): a diferencia del describe de
// arriba (invitaciones PENDIENTES), este endpoint lista miembros YA ACEPTADOS -- el
// selector real que necesita `PATCH .../admin/orders/:orderId/assign-repartidor`
// (ver restaurantes-repartidor-orders.spec.ts para el HTTP end-to-end de ese PATCH,
// que ahora usa el MISMO mecanismo -- `coreStaffRepo.listMembersByVerticalRole` --
// para su propia validación).
describe("GET /v1/restaurantes/:propertyId/admin/staff/repartidores", () => {
  it("owner ve al repartidor ya sembrado por el fixture, nunca al staff de gestión", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/repartidores`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repartidores: Array<{ id: string; email: string; fullName: string }> };
    expect(body.repartidores).toHaveLength(1);
    expect(body.repartidores[0]?.id).toBe(ctx.staff.repartidor.id);
    expect(body.repartidores.map((r) => r.id)).not.toContain(ctx.staff.staffSucursalA.id);
  });

  it("staff (verticalRole 'staff', SÍ pasa MANAGER_ROLES) también puede listar -- es quien despacha día a día", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/repartidores`, authedGet(ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repartidores: Array<{ id: string }> };
    expect(body.repartidores.map((r) => r.id)).toContain(ctx.staff.repartidor.id);
  });

  it("repartidor -- 403, esta es una ruta de gestión (MANAGER_ROLES)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/repartidores`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(403);
  });

  it("owner de OTRA organización nunca ve al repartidor de esta -- 403 (requirePropertyMembership)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/repartidores`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });

  it("una invitación de repartidor todavía PENDIENTE (nunca aceptada) no aparece en este listado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "repartidor-pendiente@lostaquitos.mx", verticalRole: "repartidor" }, "POST"),
    );

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/repartidores`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { repartidores: Array<{ email: string }> };
    expect(body.repartidores.map((r) => r.email)).not.toContain("repartidor-pendiente@lostaquitos.mx");
  });
});

describe("Jerarquía real (canInviteStaff, @atiende/core-authz) -- un admin nunca da de alta a otro owner", () => {
  it("owner invita a un 'admin'; ese admin SÍ puede invitar 'staff' pero NUNCA 'owner'", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const inviteAdmin = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "admin-nuevo@lostaquitos.mx", verticalRole: "admin" }, "POST"),
    );
    expect(inviteAdmin.status).toBe(201);
    const { inviteToken } = (await inviteAdmin.json()) as InviteResponse;

    const accept = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, fullName: "Admin Nuevo", password: "correcto-caballo-batería" }),
    });
    expect(accept.status).toBe(200);
    const adminToken = ((await accept.json()) as AcceptInviteResponse).token;

    // `acceptStaffInvite` escribe la membership real en `core.membership` (en
    // producción, la MISMA tabla que consulta `requirePropertyMembership`) -- pero en
    // tests, `InMemoryTenancyEngine` es un doble aparte de `InMemoryCoreRepository`
    // (dos Maps en memoria distintos, ver el comentario de cabecera de
    // `in-memory-tenancy-engine.ts` y de `restaurantes-admin-kpis-fixtures.ts`:
    // "siembra membership en AMBOS lados"), así que un membership creado en runtime
    // vía `coreRepo`/`coreStaffRepo` no aparece solo por eso en el store del engine.
    // Reflejamos aquí el mismo seed manual que el fixture ya hace para el staff
    // sembrado de antemano -- esto NO es necesario en producción real (una sola
    // tabla), solo en el doble de pruebas.
    const me = await app.request("/auth/me", authedGet(adminToken));
    const adminId = ((await me.json()) as { id: string }).id;
    (ctx.deps.engine as InMemoryTenancyEngine).seedMembership({ userId: adminId, organizationId: ctx.organizationId, propertyIds: null, platformRole: "admin", verticalRole: "admin" });

    // El admin SÍ puede invitar a otro "staff" (su propio techo hacia abajo).
    const adminInvitaStaff = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(adminToken, { email: "staff-por-admin@lostaquitos.mx", verticalRole: "staff" }, "POST"),
    );
    expect(adminInvitaStaff.status).toBe(201);

    // El admin NUNCA puede invitar a un "owner" (jerarquía mayor que la suya) --
    // aunque "admin" SÍ está en STAFF_INVITE_ROLES, `canInviteStaff` lo bloquea.
    const adminInvitaOwner = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(adminToken, { email: "otro-owner@lostaquitos.mx", verticalRole: "owner" }, "POST"),
    );
    expect(adminInvitaOwner.status).toBe(403);
  });
});

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): verificado contra el
// código real que ni siquiera restaurantes podía cambiar el rol de un staff YA
// ACEPTADO -- todo el describe de arriba ("Invitar a alguien nuevo") solo fija el
// rol AL INVITAR, nunca después. Estos dos endpoints (`GET`/`PATCH .../miembros`)
// cierran ese hueco -- mismo `STAFF_INVITE_ROLES` que invitar, más la jerarquía real
// de `canInviteStaff` aplicada DOS veces (al rol actual del target y al rol nuevo).
interface MemberWithRoleResponse {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
}

describe("GET /v1/restaurantes/:propertyId/admin/staff/miembros", () => {
  it("owner ve a TODOS los miembros ya aceptados (staff de gestión Y repartidor), con su rol actual", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { miembros: MemberWithRoleResponse[] };
    const byId = new Map(body.miembros.map((m) => [m.id, m]));
    expect(byId.get(ctx.staff.owner.id)?.verticalRole).toBe("owner");
    expect(byId.get(ctx.staff.staffSucursalA.id)?.verticalRole).toBe("staff");
    expect(byId.get(ctx.staff.repartidor.id)?.verticalRole).toBe("repartidor");
    // Nunca al staff de OTRA organización.
    expect(byId.has(ctx.staff.otroOrgOwner.id)).toBe(false);
  });

  it("staff (fuera de STAFF_INVITE_ROLES) -> 403, mismo umbral que invitar", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros`, authedGet(ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(403);
  });

  it("owner de OTRA organización -> 403 (requirePropertyMembership)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });
});

describe("PATCH /v1/restaurantes/:propertyId/admin/staff/miembros/:userId -- cambiar el rol de un staff ya aceptado", () => {
  it("owner cambia a staff (verticalRole 'staff') a 'admin' -- 200, el cambio persiste en el listado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.staffSucursalA.id}`,
      authedJson(ctx.staff.owner.token, { verticalRole: "admin" }, "PATCH"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemberWithRoleResponse;
    expect(body.verticalRole).toBe("admin");

    const listado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros`, authedGet(ctx.staff.owner.token));
    const listadoBody = (await listado.json()) as { miembros: MemberWithRoleResponse[] };
    expect(listadoBody.miembros.find((m) => m.id === ctx.staff.staffSucursalA.id)?.verticalRole).toBe("admin");
  });

  it("staff (fuera de STAFF_INVITE_ROLES) intenta cambiar el rol de otro -- 403, mismo umbral que invitar", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.repartidor.id}`,
      authedJson(ctx.staff.staffSucursalA.token, { verticalRole: "staff" }, "PATCH"),
    );
    expect(res.status).toBe(403);
  });

  it("verticalRole desconocido -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.staffSucursalA.id}`,
      authedJson(ctx.staff.owner.token, { verticalRole: "gerente" }, "PATCH"),
    );
    expect(res.status).toBe(400);
  });

  it("target que no pertenece a esta organización -- 404, nunca se filtra información de otra organización", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.otroOrgOwner.id}`,
      authedJson(ctx.staff.owner.token, { verticalRole: "staff" }, "PATCH"),
    );
    expect(res.status).toBe(404);
  });

  it("un owner nunca puede cambiar SU PROPIO rol -- 400, bloqueado ANTES de tocar la base de datos", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.owner.id}`,
      authedJson(ctx.staff.owner.token, { verticalRole: "admin" }, "PATCH"),
    );
    expect(res.status).toBe(400);

    // Su rol sigue siendo "owner" -- el bloqueo de verdad impidió la escritura.
    const listado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros`, authedGet(ctx.staff.owner.token));
    const listadoBody = (await listado.json()) as { miembros: MemberWithRoleResponse[] };
    expect(listadoBody.miembros.find((m) => m.id === ctx.staff.owner.id)?.verticalRole).toBe("owner");
  });

  it("un admin NUNCA puede tocar el rol de un owner (jerarquía real, canInviteStaff) -- 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Sembrar un admin real vía invitación + aceptación (mismo patrón que el describe
    // de jerarquía de arriba: seedMembership manual en el engine, ver su comentario).
    const inviteAdmin = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "admin-que-cambia-roles@lostaquitos.mx", verticalRole: "admin" }, "POST"),
    );
    const { inviteToken } = (await inviteAdmin.json()) as InviteResponse;
    const accept = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, fullName: "Admin Que Cambia Roles", password: "correcto-caballo-batería" }),
    });
    const adminToken = ((await accept.json()) as AcceptInviteResponse).token;
    const me = await app.request("/auth/me", authedGet(adminToken));
    const adminId = ((await me.json()) as { id: string }).id;
    (ctx.deps.engine as InMemoryTenancyEngine).seedMembership({ userId: adminId, organizationId: ctx.organizationId, propertyIds: null, platformRole: "admin", verticalRole: "admin" });

    // El admin NUNCA puede tocar al owner (rango mayor).
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.owner.id}`,
      authedJson(adminToken, { verticalRole: "staff" }, "PATCH"),
    );
    expect(res.status).toBe(403);

    // Tampoco puede ASCENDER a nadie por encima de su propio rango ("owner"), aunque
    // el target sea de rango menor.
    const asciende = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.staffSucursalA.id}`,
      authedJson(adminToken, { verticalRole: "owner" }, "PATCH"),
    );
    expect(asciende.status).toBe(403);

    // Pero SÍ puede cambiar a alguien de rango menor a otro rol de rango menor.
    const permitido = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.staffSucursalA.id}`,
      authedJson(adminToken, { verticalRole: "admin" }, "PATCH"),
    );
    expect(permitido.status).toBe(200);
  });
});
