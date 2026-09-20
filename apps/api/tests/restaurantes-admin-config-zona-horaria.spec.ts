// FASE 3 (producto) — HTTP end-to-end de admin-config.ts::GET/PATCH
// .../admin/config/zona-horaria (migración 022, `restaurantes.branch_detail.
// zona_horaria`). Mismo fixture/patrón EXACTO que
// restaurantes-admin-config.spec.ts (whatsapp/zonas conocidas), leído primero
// como plantilla.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

interface ZonaHorariaResponse {
  readonly zonaHoraria: string | null;
}

describe("GET/PATCH /v1/restaurantes/:propertyId/admin/config/zona-horaria", () => {
  it("owner: sin configurar todavía -> zonaHoraria null; PATCH configura -> se lee de vuelta correctamente", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const antes = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedGet(ctx.staff.owner.token));
    expect(antes.status).toBe(200);
    expect((await antes.json()) as ZonaHorariaResponse).toEqual({ zonaHoraria: null });

    const patch = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedJson(ctx.staff.owner.token, { zona_horaria: "America/Chihuahua" }, "PATCH"));
    expect(patch.status).toBe(200);
    expect((await patch.json()) as ZonaHorariaResponse).toEqual({ zonaHoraria: "America/Chihuahua" });

    const despues = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedGet(ctx.staff.owner.token));
    expect((await despues.json()) as ZonaHorariaResponse).toEqual({ zonaHoraria: "America/Chihuahua" });

    const entrada = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.zona_horaria_actualizada");
    expect(entrada).toBeDefined();
    expect(entrada?.antes).toBeNull();
    expect(entrada?.despues).toBe("America/Chihuahua");
  });

  it("admin (no solo owner) también puede configurar -- STAFF_INVITE_ROLES incluye ambos", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedJson(ctx.staff.admin.token, { zona_horaria: "America/Mazatlan" }, "PATCH"));
    expect(res.status).toBe(200);
  });

  it("staff de sucursal / repartidor NUNCA pueden leer ni escribir -- reservado a owner/admin (mandato 'owner/gm')", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    for (const rol of ["staffSucursalA", "repartidor"] as const) {
      const get = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedGet(ctx.staff[rol].token));
      expect(get.status).toBe(403);
      const patch = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedJson(ctx.staff[rol].token, { zona_horaria: "America/Cancun" }, "PATCH"));
      expect(patch.status).toBe(403);
    }
  });

  it("timezone IANA inválido -- 400, nunca escribe (mismo criterio que citas/admin.ts::optionalTimeZone)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedJson(ctx.staff.owner.token, { zona_horaria: "Marte/Cráter" }, "PATCH"));
    expect(res.status).toBe(400);
    const get = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedGet(ctx.staff.owner.token));
    expect((await get.json()) as ZonaHorariaResponse).toEqual({ zonaHoraria: null });
  });

  it("zona_horaria: null explícito -- borra la configuración, vuelve al default de plataforma", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedJson(ctx.staff.owner.token, { zona_horaria: "America/Cancun" }, "PATCH"));
    const patch = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedJson(ctx.staff.owner.token, { zona_horaria: null }, "PATCH"));
    expect(patch.status).toBe(200);
    expect((await patch.json()) as ZonaHorariaResponse).toEqual({ zonaHoraria: null });
  });

  it("campo ausente -- 400 (zona_horaria es requerido: string IANA o null explícito)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedJson(ctx.staff.owner.token, {}, "PATCH"));
    expect(res.status).toBe(400);
  });

  it("una sucursal B distinta de la misma organización tiene su propia configuración, independiente de la sucursal A", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zona-horaria`, authedJson(ctx.staff.owner.token, { zona_horaria: "America/Hermosillo" }, "PATCH"));

    const zonaB = await app.request(`/v1/restaurantes/${ctx.propertyIdB}/admin/config/zona-horaria`, authedGet(ctx.staff.owner.token));
    expect((await zonaB.json()) as ZonaHorariaResponse).toEqual({ zonaHoraria: null });
  });
});
