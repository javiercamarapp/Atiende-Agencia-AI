// Regresion H45 / ac9b380 del repo original (atiende-restaurantes): un admin podia crear una cuenta con role "superadmin"
// (escalacion critica). En main el rol se valida contra un conjunto cerrado (isRestaurantesRole) ANTES de tocar nada; esta
// prueba nombra el caso "superadmin" (el generico "verticalRole desconocido" de restaurantes-admin-staff.spec.ts no lo nombra)
// y exige que no se escriba NADA (ni invitacion, ni cuenta). Casos negativos: los roles legitimos si se invitan.
import { describe, expect, it } from "vitest";
import type { InMemoryTenancyEngine } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

interface InviteResponse {
  readonly inviteToken: string;
}
interface ListadoInvitaciones {
  readonly invitations: ReadonlyArray<{ readonly email: string }>;
}

const CORREOS_PROHIBIDOS = ["superadmin@lostaquitos.mx", "super-por-admin@lostaquitos.mx"];

async function invitaciones(ctx: Awaited<ReturnType<typeof buildRestaurantesKpiTestContext>>, app: ReturnType<typeof buildApp>): Promise<string[]> {
  const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`, authedGet(ctx.staff.owner.token));
  expect(res.status).toBe(200);
  return ((await res.json()) as ListadoInvitaciones).invitations.map((i) => i.email);
}

describe("H45 / ac9b380: nadie se auto-escala a superadmin invitando staff", () => {
  it("H45 / ac9b380: un owner que invita con verticalRole 'superadmin' recibe 400/403 y no se escribe nada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = await invitaciones(ctx, app);

    for (const rol of ["superadmin", "SUPERADMIN", "super_admin", "platform_admin"]) {
      const res = await app.request(
        `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
        authedJson(ctx.staff.owner.token, { email: CORREOS_PROHIBIDOS[0], verticalRole: rol }, "POST"),
      );
      expect([400, 403], rol).toContain(res.status);
      expect(await res.text(), rol).not.toMatch(/inviteToken/);
    }

    expect(await invitaciones(ctx, app)).toEqual(antes);
    expect(await invitaciones(ctx, app)).not.toContain(CORREOS_PROHIBIDOS[0]);
  });

  it("H45 / ac9b380: un admin (el caso original) tampoco puede invitar 'superadmin', ni por verticalRole ni colando platformRole", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const inviteAdmin = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
      authedJson(ctx.staff.owner.token, { email: "admin-h45@lostaquitos.mx", verticalRole: "admin" }, "POST"),
    );
    expect(inviteAdmin.status).toBe(201);
    const { inviteToken } = (await inviteAdmin.json()) as InviteResponse;
    const accept = await app.request("/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, fullName: "Admin H45", password: "correcto-caballo-batería" }),
    });
    expect(accept.status).toBe(200);
    const adminToken = ((await accept.json()) as { token: string }).token;
    const me = await app.request("/auth/me", authedGet(adminToken));
    const adminId = ((await me.json()) as { id: string }).id;
    (ctx.deps.engine as InMemoryTenancyEngine).seedMembership({ userId: adminId, organizationId: ctx.organizationId, propertyIds: null, platformRole: "admin", verticalRole: "admin" });
    const antes = await invitaciones(ctx, app);

    for (const cuerpo of [
      { email: CORREOS_PROHIBIDOS[1], verticalRole: "superadmin" },
      { email: "colado-1@lostaquitos.mx", verticalRole: "staff", platformRole: "superadmin" },
      { email: "colado-2@lostaquitos.mx", verticalRole: "staff", role: "superadmin" },
    ]) {
      const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`, authedJson(adminToken, cuerpo, "POST"));
      if (cuerpo.verticalRole === "superadmin") {
        expect([400, 403]).toContain(res.status);
      } else {
        // Un campo extra no puede subir el rol: o se rechaza, o se ignora y el invitado queda como 'staff' normal.
        if (res.status === 201) {
          const aceptada = await app.request("/auth/accept-invite", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: ((await res.json()) as InviteResponse).inviteToken, fullName: "Colado", password: "correcto-caballo-batería" }),
          });
          const orgs = ((await aceptada.json()) as { organizations: ReadonlyArray<{ rol: string }> }).organizations;
          expect(orgs.map((o) => o.rol)).not.toContain("superadmin");
        } else {
          expect([400, 403]).toContain(res.status);
        }
      }
    }
    // Lo unico que pudo quedar escrito es el 'staff' normal de los casos con campo extra: nunca un superadmin.
    const despues = await invitaciones(ctx, app);
    expect(despues.filter((e) => !antes.includes(e)).length).toBeLessThanOrEqual(2);
    expect(despues).not.toContain(CORREOS_PROHIBIDOS[1]);
  });

  it("H45 / ac9b380 (negativo): los roles legitimos staff/repartidor/admin siguen invitandose con 201", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const rol of ["staff", "repartidor", "admin"]) {
      const res = await app.request(
        `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`,
        authedJson(ctx.staff.owner.token, { email: `${rol}-h45@lostaquitos.mx`, verticalRole: rol }, "POST"),
      );
      expect(res.status, rol).toBe(201);
    }
  });
});
