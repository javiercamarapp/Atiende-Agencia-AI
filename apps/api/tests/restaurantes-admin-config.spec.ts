// FASE 3 (producto) — HTTP end-to-end de admin-config.ts: configuración editable
// del panel (owner/admin) para WhatsApp y zonas conocidas. Ambas tablas YA
// EXISTÍAN (migrations/001/005) sin ninguna ruta de escritura -- ver el comentario
// de cabecera de packages/domain-restaurantes/migrations/
// 021_restaurantes_config_editable_y_search_path_fix.sql. Reusa
// `buildRestaurantesKpiTestContext` (mismo fixture que admin-staff/admin-kpis).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

interface WhatsappConfigResponse {
  readonly phoneNumberId: string | null;
}

interface KnownZoneResponse {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly createdAt: string;
}

describe("GET/PUT /v1/restaurantes/:propertyId/admin/config/whatsapp", () => {
  it("owner: sin configurar todavía -> phoneNumberId null; PUT conecta un número -> se lee de vuelta correctamente", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const antes = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedGet(ctx.staff.owner.token));
    expect(antes.status).toBe(200);
    expect((await antes.json()) as WhatsappConfigResponse).toEqual({ phoneNumberId: null });

    const put = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`,
      authedJson(ctx.staff.owner.token, { phoneNumberId: "109876543210123" }, "PUT"),
    );
    expect(put.status).toBe(200);
    expect((await put.json()) as WhatsappConfigResponse).toEqual({ phoneNumberId: "109876543210123" });

    // Config actualizada se lee de vuelta correctamente -- otra llamada GET, no solo
    // la respuesta del PUT.
    const despues = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedGet(ctx.staff.owner.token));
    expect((await despues.json()) as WhatsappConfigResponse).toEqual({ phoneNumberId: "109876543210123" });

    const entrada = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.whatsapp_actualizada");
    expect(entrada).toBeDefined();
    expect(entrada?.antes).toBeNull();
    expect(entrada?.despues).toBe("109876543210123");
  });

  it("PUT reemplaza un número ya conectado (un solo número por organización)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedJson(ctx.staff.owner.token, { phoneNumberId: "111111111111" }, "PUT"));
    const put2 = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedJson(ctx.staff.owner.token, { phoneNumberId: "222222222222" }, "PUT"));
    expect(put2.status).toBe(200);

    const get = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedGet(ctx.staff.owner.token));
    expect((await get.json()) as WhatsappConfigResponse).toEqual({ phoneNumberId: "222222222222" });
  });

  it("phoneNumberId inválido (no numérico) -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedJson(ctx.staff.owner.token, { phoneNumberId: "no-es-un-id" }, "PUT"));
    expect(res.status).toBe(400);
  });

  it("staff (fuera de STAFF_INVITE_ROLES) -- 403 tanto en GET como en PUT", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const get = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedGet(ctx.staff.staffSucursalA.token));
    expect(get.status).toBe(403);

    const put = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`,
      authedJson(ctx.staff.staffSucursalA.token, { phoneNumberId: "111111111111" }, "PUT"),
    );
    expect(put.status).toBe(403);
  });

  it("owner de OTRA organización -- 403 (requirePropertyMembership)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });
});

describe("GET/POST/DELETE /v1/restaurantes/:propertyId/admin/config/zonas", () => {
  it("owner crea una zona -> aparece en el listado; DELETE la quita -- ya no aparece", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const vacio = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas`, authedGet(ctx.staff.owner.token));
    expect((await vacio.json()) as { zonas: KnownZoneResponse[] }).toEqual({ zonas: [] });

    const crear = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas`,
      authedJson(ctx.staff.owner.token, { name: "Altabrisa", lat: 21.0619, lng: -89.6216 }, "POST"),
    );
    expect(crear.status).toBe(201);
    const creada = (await crear.json()) as KnownZoneResponse;
    expect(creada.name).toBe("Altabrisa");

    const listado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas`, authedGet(ctx.staff.owner.token));
    const listadoBody = (await listado.json()) as { zonas: KnownZoneResponse[] };
    expect(listadoBody.zonas.map((z) => z.id)).toContain(creada.id);

    const entradaCreacion = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.zona_creada" && r.entityId === creada.id);
    expect(entradaCreacion).toBeDefined();

    const borrar = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas/${creada.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(borrar.status).toBe(200);

    const listadoDespues = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas`, authedGet(ctx.staff.owner.token));
    const listadoDespuesBody = (await listadoDespues.json()) as { zonas: KnownZoneResponse[] };
    expect(listadoDespuesBody.zonas.map((z) => z.id)).not.toContain(creada.id);

    const entradaBorrado = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.zona_eliminada" && r.entityId === creada.id);
    expect(entradaBorrado).toBeDefined();
  });

  it("lat/lng fuera de rango -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas`,
      authedJson(ctx.staff.owner.token, { name: "Zona Imposible", lat: 200, lng: -89.6216 }, "POST"),
    );
    expect(res.status).toBe(400);
  });

  it("borrar una zona inexistente -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("borrar una zona de OTRA organización -- 404 (nunca se filtra su existencia)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const crear = await app.request(
      `/v1/restaurantes/${ctx.otherPropertyId}/admin/config/zonas`,
      authedJson(ctx.staff.otroOrgOwner.token, { name: "Zona de otra org", lat: 20.5, lng: -100.3 }, "POST"),
    );
    const creada = (await crear.json()) as KnownZoneResponse;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas/${creada.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("staff (fuera de STAFF_INVITE_ROLES) -- 403 en GET/POST", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const get = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas`, authedGet(ctx.staff.staffSucursalA.token));
    expect(get.status).toBe(403);

    const post = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/config/zonas`,
      authedJson(ctx.staff.staffSucursalA.token, { name: "Zona", lat: 21, lng: -89 }, "POST"),
    );
    expect(post.status).toBe(403);
  });
});
