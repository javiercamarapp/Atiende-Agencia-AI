// Modelo PM (migracion 023) — HTTP end-to-end de admin-modelo-pm.ts: politica por sucursal
// (horario / minimo por canal / propina), cobertura de entrega, WhatsApp por sucursal y marcas
// no_domicilio. Reusa el fixture de KPIs de restaurantes (dos sucursales + otra organizacion).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RestaurantesConfigUnavailableError } from "@atiende/domain-restaurantes";
import type { RestaurantesRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const POLITICA_PM = {
  horario: [
    { dias: [1, 2, 3, 4, 5], abre: "12:00", cierra: "16:00" },
    { dias: [1, 2, 3, 4, 5], abre: "18:00", cierra: "01:00" },
  ],
  pedidoMinimoDomicilio: 200,
  pedidoMinimoRecoger: null,
  propinaPolitica: "solo_tarjeta",
};

/** Valores por omision de la migracion 057 que el API siempre devuelve. */
const DEFAULTS_057 = { visibleEnDirectorio: null, aceptaDomicilio: true, diasDomicilio: null, deTemporada: false };

describe("politica por sucursal — GET/PUT .../admin/config/sucursales/:branchId/politica", () => {
  it("sin configurar: politica vacia; owner guarda y se lee de vuelta; queda en la bitacora", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdB}/politica`;

    const vacia = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(vacia.status).toBe(200);
    expect(await vacia.json()).toEqual({ horario: null, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null, ...DEFAULTS_057 });

    const put = await app.request(url, authedJson(ctx.staff.owner.token, POLITICA_PM, "PUT"));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ...POLITICA_PM, ...DEFAULTS_057 });
    expect(await (await app.request(url, authedGet(ctx.staff.owner.token))).json()).toEqual({ ...POLITICA_PM, ...DEFAULTS_057 });

    // La sucursal A no se toca: la politica es POR sucursal.
    const otra = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/politica`, authedGet(ctx.staff.owner.token));
    expect(await otra.json()).toEqual({ horario: null, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null, ...DEFAULTS_057 });

    const entrada = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.politica_sucursal_actualizada");
    expect(entrada?.entityId).toBe(ctx.propertyIdB);
  });

  it("la politica guardada la aplican las reglas de pedido (minimo a domicilio de esa sucursal)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/politica`, authedJson(ctx.staff.admin.token, { ...POLITICA_PM, horario: null }, "PUT"));
    const politica = await ctx.restaurantesRepo.findBranchPolicy(ctx.propertyIdA);
    expect(politica.pedidoMinimoDomicilio).toBe(200);
    expect(politica.propinaPolitica).toBe("solo_tarjeta");
  });

  it.each([
    ["horario con hora invalida", { ...POLITICA_PM, horario: [{ dias: [1], abre: "25:00", cierra: "01:00" }] }],
    ["horario con abre == cierra", { ...POLITICA_PM, horario: [{ dias: [1], abre: "12:00", cierra: "12:00" }] }],
    ["minimo negativo", { ...POLITICA_PM, pedidoMinimoDomicilio: -1 }],
    ["minimo no numerico", { ...POLITICA_PM, pedidoMinimoRecoger: "cien" }],
    ["propina fuera del catalogo", { ...POLITICA_PM, propinaPolitica: "siempre_y_mas" }],
    ["campo omitido (reemplazo completo: nada se borra por omision)", { horario: null, pedidoMinimoDomicilio: 200, propinaPolitica: null }],
  ])("400: %s", async (_nombre, body) => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/politica`, authedJson(ctx.staff.owner.token, body, "PUT"));
    expect(res.status).toBe(400);
  });

  it("solo owner/admin: staff y repartidor -> 403 en GET y PUT", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/politica`;
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token]) {
      expect((await app.request(url, authedGet(token))).status).toBe(403);
      expect((await app.request(url, authedJson(token, POLITICA_PM, "PUT"))).status).toBe(403);
    }
    expect(await ctx.restaurantesRepo.findBranchPolicy(ctx.propertyIdA)).toMatchObject({ pedidoMinimoDomicilio: null });
  });

  it("cross-tenant: owner de OTRA organizacion -> 403/404; una sucursal ajena nombrada por un owner propio -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ajeno = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/politica`, authedJson(ctx.staff.otroOrgOwner.token, POLITICA_PM, "PUT"));
    expect([403, 404]).toContain(ajeno.status);

    const sucursalAjena = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.otherPropertyId}/politica`, authedJson(ctx.staff.owner.token, POLITICA_PM, "PUT"));
    expect(sucursalAjena.status).toBe(404);
    expect(await ctx.restaurantesRepo.findBranchPolicy(ctx.otherPropertyId)).toMatchObject({ pedidoMinimoDomicilio: null });
  });

  it("base sin migrar: el PUT responde 503 honesto (nunca 500) y el GET sigue devolviendo politica vacia", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const base = ctx.restaurantesRepo;
    const sinMigrar = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "upsertBranchPolicy") {
          return async () => {
            throw new RestaurantesConfigUnavailableError();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as RestaurantesRepository;
    const app = buildApp({ ...ctx.deps, restaurantesRepo: () => sinMigrar });
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/politica`;
    expect((await app.request(url, authedJson(ctx.staff.owner.token, POLITICA_PM, "PUT"))).status).toBe(503);
    expect((await app.request(url, authedGet(ctx.staff.owner.token))).status).toBe(200);
  });
});

describe("cobertura de entrega — .../sucursales/:branchId/zonas-reparto", () => {
  it("owner reemplaza la cobertura de la sucursal con zonas de su organizacion; se lee de vuelta", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const z1 = await ctx.restaurantesRepo.createKnownZone(ctx.organizationId, { name: "Altabrisa", lat: 21.06, lng: -89.62 });
    const z2 = await ctx.restaurantesRepo.createKnownZone(ctx.organizationId, { name: "Pensiones", lat: 20.96, lng: -89.66 });
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/zonas-reparto`;

    expect(await (await app.request(url, authedGet(ctx.staff.owner.token))).json()).toEqual({ zoneIds: [] });
    const put = await app.request(url, authedJson(ctx.staff.owner.token, { zoneIds: [z1.id, z2.id, z1.id] }, "PUT"));
    expect(put.status).toBe(200);
    expect((await put.json()) as { zoneIds: string[] }).toEqual({ zoneIds: [z1.id, z2.id].sort() });
    const reemplazo = await app.request(url, authedJson(ctx.staff.owner.token, { zoneIds: [z2.id] }, "PUT"));
    expect(await reemplazo.json()).toEqual({ zoneIds: [z2.id] });
    expect(await ctx.restaurantesRepo.listBranchDeliveryZoneIds(ctx.propertyIdA)).toEqual([z2.id]);
  });

  it("una zona de OTRA organizacion o inexistente -> 400 y no cambia nada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const propia = await ctx.restaurantesRepo.createKnownZone(ctx.organizationId, { name: "Propia", lat: 1, lng: 1 });
    const ajena = await ctx.restaurantesRepo.createKnownZone(ctx.otherOrganizationId, { name: "Ajena", lat: 2, lng: 2 });
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/zonas-reparto`;
    await app.request(url, authedJson(ctx.staff.owner.token, { zoneIds: [propia.id] }, "PUT"));

    expect((await app.request(url, authedJson(ctx.staff.owner.token, { zoneIds: [propia.id, ajena.id] }, "PUT"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { zoneIds: [randomUUID()] }, "PUT"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { zoneIds: "todas" }, "PUT"))).status).toBe(400);
    expect(await ctx.restaurantesRepo.listBranchDeliveryZoneIds(ctx.propertyIdA)).toEqual([propia.id]);
  });

  it("staff -> 403; sucursal de otra organizacion -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/zonas-reparto`;
    expect((await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { zoneIds: [] }, "PUT"))).status).toBe(403);
    const ajena = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.otherPropertyId}/zonas-reparto`, authedJson(ctx.staff.owner.token, { zoneIds: [] }, "PUT"));
    expect(ajena.status).toBe(404);
  });
});

describe("WhatsApp por sucursal — .../sucursales/:branchId/whatsapp", () => {
  it("conectar, leer, rotar y desconectar el numero de una sucursal; el webhook lo resuelve", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdB}/whatsapp`;

    expect(await (await app.request(url, authedGet(ctx.staff.owner.token))).json()).toEqual({ phoneNumberId: null });
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { phoneNumberId: "111111111111" }, "PUT"))).status).toBe(200);
    expect(await ctx.restaurantesRepo.resolveWhatsAppChannel("111111111111")).toEqual({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdB });

    await app.request(url, authedJson(ctx.staff.owner.token, { phoneNumberId: "222222222222" }, "PUT"));
    expect(await (await app.request(url, authedGet(ctx.staff.owner.token))).json()).toEqual({ phoneNumberId: "222222222222" });
    expect(await ctx.restaurantesRepo.resolveWhatsAppChannel("111111111111")).toBeNull();

    expect((await app.request(url, authedJson(ctx.staff.owner.token, undefined, "DELETE"))).status).toBe(200);
    expect(await ctx.restaurantesRepo.resolveWhatsAppChannel("222222222222")).toBeNull();
    expect((await app.request(url, authedJson(ctx.staff.owner.token, undefined, "DELETE"))).status).toBe(404);
  });

  it("un numero que ya rutea a otra organizacion -> 409; formato invalido -> 400; staff -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.restaurantesRepo.upsertWhatsappBranchChannel(ctx.otherOrganizationId, ctx.otherPropertyId, "999999999999");
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/whatsapp`;

    expect((await app.request(url, authedJson(ctx.staff.owner.token, { phoneNumberId: "999999999999" }, "PUT"))).status).toBe(409);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { phoneNumberId: "abc" }, "PUT"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { phoneNumberId: "333333333333" }, "PUT"))).status).toBe(403);
    // el numero de la otra organizacion sigue intacto
    expect(await ctx.restaurantesRepo.resolveWhatsAppChannel("999999999999")).toEqual({ organizationId: ctx.otherOrganizationId, propertyId: ctx.otherPropertyId });
  });
});

describe("marcas no_domicilio — .../admin/config/no-domicilio", () => {
  it("owner/admin marcan un producto y una categoria; las marcas se leen y se desmarcan; el staff las lee pero no las escribe (403, 065)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const categoryId = randomUUID();
    const productId = randomUUID();
    ctx.restaurantesRepo.seedCategory({ id: categoryId, organizationId: ctx.organizationId, name: "Cervezas" });
    ctx.restaurantesRepo.seedProduct({ id: productId, organizationId: ctx.organizationId, categoryId, name: "Sol", description: null, searchKeywords: [] });
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/no-domicilio`;
    const token = ctx.staff.admin.token;

    const staffToken = ctx.staff.staffSucursalA.token;
    for (const ruta of [`categorias/${categoryId}`, `productos/${productId}`]) {
      const denegado = await app.request(`${base}/${ruta}`, authedJson(staffToken, { noDomicilio: true }, "PUT"));
      expect(denegado.status).toBe(403);
    }
    expect(await (await app.request(base, authedGet(staffToken))).json()).toEqual({ productIds: [], categoryIds: [] });

    expect((await app.request(`${base}/categorias/${categoryId}`, authedJson(token, { noDomicilio: true }, "PUT"))).status).toBe(200);
    expect((await app.request(`${base}/productos/${productId}`, authedJson(token, { noDomicilio: true }, "PUT"))).status).toBe(200);
    expect(await (await app.request(base, authedGet(token))).json()).toEqual({ productIds: [productId], categoryIds: [categoryId] });

    await app.request(`${base}/productos/${productId}`, authedJson(token, { noDomicilio: false }, "PUT"));
    expect(await (await app.request(base, authedGet(token))).json()).toEqual({ productIds: [], categoryIds: [categoryId] });
  });

  it("404 con producto/categoria inexistente o de OTRA organizacion; 400 con valor no booleano; repartidor 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ajeno = randomUUID();
    ctx.restaurantesRepo.seedProduct({ id: ajeno, organizationId: ctx.otherOrganizationId, categoryId: null, name: "Ajeno", description: null, searchKeywords: [] });
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/no-domicilio`;
    const token = ctx.staff.owner.token;

    expect((await app.request(`${base}/productos/${ajeno}`, authedJson(token, { noDomicilio: true }, "PUT"))).status).toBe(404);
    expect((await app.request(`${base}/productos/${randomUUID()}`, authedJson(token, { noDomicilio: true }, "PUT"))).status).toBe(404);
    expect((await app.request(`${base}/categorias/${randomUUID()}`, authedJson(token, { noDomicilio: true }, "PUT"))).status).toBe(404);
    expect((await app.request(`${base}/productos/${ajeno}`, authedJson(token, { noDomicilio: "si" }, "PUT"))).status).toBe(400);
    expect((await app.request(base, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await ctx.restaurantesRepo.listNoDomicilioMarks(ctx.otherOrganizationId)).productIds).toEqual([]);
  });
});

describe("reporte de colonias ambiguas — GET .../admin/config/colonias-ambiguas (X42)", () => {
  async function conColonias() {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const zonaAmbigua = randomUUID();
    const zonaClara = randomUUID();
    ctx.restaurantesRepo.seedKnownZone({
      id: zonaAmbigua,
      organizationId: ctx.organizationId,
      name: "Temozón Norte",
      lat: null,
      lng: null,
      fuente: "chats_t7",
      asignacionFuente: "chats_t7",
      refSucursalSlug: "centro",
      refKm: 1.7,
      ref2SucursalSlug: "fco-montejo",
      ref2Km: 1.8,
    });
    ctx.restaurantesRepo.seedKnownZone({ id: zonaClara, organizationId: ctx.organizationId, name: "Colonia Clara", lat: null, lng: null, fuente: "piloto_original_merida_colonias", asignacionFuente: "distancia_piloto", refSucursalSlug: "centro", refKm: 0.4, ref2SucursalSlug: "fco-montejo", ref2Km: 3.2 });
    ctx.restaurantesRepo.seedBranchDeliveryZones(ctx.propertyIdB, [zonaAmbigua, zonaClara]);
    // Colonia de OTRA organizacion: nunca aparece.
    ctx.restaurantesRepo.seedKnownZone({ organizationId: ctx.otherOrganizationId, name: "Colonia Ajena", lat: null, lng: null, fuente: "chats_t7", refSucursalSlug: "unica", refKm: 1, ref2SucursalSlug: "unica", ref2Km: 1.1 });
    return ctx;
  }
  const url = (propertyId: string) => `/v1/restaurantes/${propertyId}/admin/config/colonias-ambiguas`;

  it("owner y admin ven el reporte: colonia, sucursal asignada, km, segunda sucursal, diferencia y marca 'revisar'; solo de su organizacion", async () => {
    const ctx = await conColonias();
    const app = buildApp(ctx.deps);
    for (const token of [ctx.staff.owner.token, ctx.staff.admin.token]) {
      const res = await app.request(url(ctx.propertyIdA), authedGet(token));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disponible: boolean; total: number; paraRevisar: number; filas: Array<{ colonia: string; sucursalAsignada: { slug: string } | null; kmAsignada: number | null; segundaSucursal: { slug: string } | null; diferenciaKm: number | null; revisar: boolean; motivos: string[] }> };
      expect(body.disponible).toBe(true);
      expect(body.total).toBe(2);
      expect(body.filas.map((f) => f.colonia)).toEqual(["Temozón Norte", "Colonia Clara"]);
      expect(body.filas[0]).toMatchObject({ sucursalAsignada: { slug: "centro" }, kmAsignada: 1.7, segundaSucursal: { slug: "fco-montejo" }, diferenciaKm: 0.1, revisar: true });
      expect(body.filas[0]!.motivos).toContain("ambigua");
      expect(body.filas[1]).toMatchObject({ revisar: false, motivos: [] });
      expect(body.paraRevisar).toBe(1);
      expect(JSON.stringify(body)).not.toContain("Colonia Ajena");
    }
  });

  it("403: rol sin permiso (repartidor), staff acotado a una sucursal y staff de otra organizacion; 401 sin token", async () => {
    const ctx = await conColonias();
    const app = buildApp(ctx.deps);
    for (const token of [ctx.staff.repartidor.token, ctx.staff.staffSucursalA.token]) {
      expect((await app.request(url(ctx.propertyIdA), authedGet(token))).status).toBe(403);
    }
    expect((await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.otroOrgOwner.token))).status).toBe(403);
    expect((await app.request(url(ctx.propertyIdA))).status).toBe(401);
  });

  it("es de solo lectura: no hay POST/PUT/DELETE", async () => {
    const ctx = await conColonias();
    const app = buildApp(ctx.deps);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await app.request(url(ctx.propertyIdA), authedJson(ctx.staff.owner.token, {}, method as "PUT"));
      expect([404, 405]).toContain(res.status);
    }
  });

  it("base sin la migracion 056: 200 con disponible=false y lista vacia (nunca 500)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const sinMigrar = Object.assign(Object.create(ctx.restaurantesRepo), { listColoniasReferencia: async () => ({ disponible: false, zonas: [] }) }) as RestaurantesRepository;
    const app = buildApp({ ...ctx.deps, restaurantesRepo: () => sinMigrar });
    const res = await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disponible: false, total: 0, paraRevisar: 0, sinAsignar: 0, ambiguas: 0, filas: [] });
  });
});

describe("domicilio y directorio por sucursal (migracion 057) — PUT .../politica y GET storefront/directorio", () => {
  it("guarda dias de domicilio, solo recoger, directorio y temporada; PUT sin esos campos los conserva", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdB}/politica`;
    const put = await app.request(url, authedJson(ctx.staff.owner.token, { ...POLITICA_PM, diasDomicilio: [6, 0, 5, 5], visibleEnDirectorio: true, deTemporada: true }, "PUT"));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ diasDomicilio: [0, 5, 6], visibleEnDirectorio: true, deTemporada: true, aceptaDomicilio: true });
    // Un PUT que solo cambia el minimo no borra la restriccion de domicilio.
    const put2 = await app.request(url, authedJson(ctx.staff.owner.token, { ...POLITICA_PM, pedidoMinimoDomicilio: 250 }, "PUT"));
    expect(await put2.json()).toMatchObject({ pedidoMinimoDomicilio: 250, diasDomicilio: [0, 5, 6], visibleEnDirectorio: true, deTemporada: true });
    // null explicito = todos los dias.
    const put3 = await app.request(url, authedJson(ctx.staff.owner.token, { ...POLITICA_PM, diasDomicilio: null, aceptaDomicilio: false }, "PUT"));
    expect(await put3.json()).toMatchObject({ diasDomicilio: null, aceptaDomicilio: false });
  });

  it.each([
    ["dia fuera de rango", { diasDomicilio: [7] }],
    ["lista vacia", { diasDomicilio: [] }],
    ["dia no entero", { diasDomicilio: [1.5] }],
    ["aceptaDomicilio no booleano", { aceptaDomicilio: "si" }],
    ["deTemporada no booleano", { deTemporada: 1 }],
  ])("400: %s", async (_n, extra) => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/politica`, authedJson(ctx.staff.owner.token, { ...POLITICA_PM, ...extra }, "PUT"));
    expect(res.status).toBe(400);
  });

  it("staff (no owner/admin) no puede cambiar el domicilio: 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/politica`, authedJson(ctx.staff.staffSucursalA.token, { ...POLITICA_PM, aceptaDomicilio: false }, "PUT"));
    expect(res.status).toBe(403);
  });
});
