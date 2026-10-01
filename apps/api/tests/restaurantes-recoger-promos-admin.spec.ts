// PM PR-3 / PR-4 -- HTTP end-to-end de lo que expone la API admin: promociones automaticas y combo de cortesia
// (validacion de forma y aislamiento), estados de recoger con aviso opcional, canal/propina en los pedidos y
// puentes (excepciones de horario por fecha). Mismo fixture de staff/roles reales que los demas specs admin.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import type { RestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

function seedProduct(ctx: RestaurantesKpiTestContext, organizationId = ctx.organizationId, name = "Producto") {
  const id = randomUUID();
  ctx.restaurantesRepo.seedProduct({ id, organizationId, categoryId: randomUUID(), name, description: null, searchKeywords: [] });
  return id;
}

describe("promociones automaticas y combo de cortesia (admin-promotions)", () => {
  async function setup() {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const post = (body: object, token = ctx.staff.owner.token) => app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(token, body));
    const patch = (id: string, body: object) => app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions/${id}`, authedJson(ctx.staff.owner.token, body, "PATCH"));
    return { ctx, app, post, patch, nachos: seedProduct(ctx, ctx.organizationId, "Nachos"), agua1: seedProduct(ctx, ctx.organizationId, "Agua 1"), agua2: seedProduct(ctx, ctx.organizationId, "Agua 2") };
  }

  it("crea el combo del martes: cortesia, automatico, solo recoger, 2 aguas por nachos; value se fija en 1", async () => {
    const { post, nachos, agua1, agua2 } = await setup();
    const res = await post({ code: "MARTESNACHOS", name: "Martes nachos", type: "cortesia", daysOfWeek: [2], channels: ["recoger"], autoApply: true, productIds: [nachos], courtesyProductIds: [agua1, agua2], courtesyQuantity: 2 });
    expect(res.status).toBe(201);
    const { promotion } = (await res.json()) as { promotion: Record<string, unknown> };
    expect(promotion).toMatchObject({ type: "cortesia", value: 1, autoApply: true, channels: ["recoger"], courtesyQuantity: 2, productIds: [nachos], courtesyProductIds: [agua1, agua2] });
  });

  it("una promocion automatica sin canales explicitos es 400 (nunca queda sin restriccion de canal)", async () => {
    const { post } = await setup();
    expect((await post({ code: "AUTOSINCANAL", name: "x", type: "bogo", autoApply: true })).status).toBe(400);
    expect((await post({ code: "AUTOCANALNULL", name: "x", type: "bogo", autoApply: true, channels: null })).status).toBe(400);
    expect((await post({ code: "AUTOOK", name: "x", type: "bogo", autoApply: true, channels: ["recoger"] })).status).toBe(201);
  });

  it("forma del combo: faltan listas o cantidad, listas que se traslapan, cantidad fuera de 1..10 -> 400", async () => {
    const { post, nachos, agua1 } = await setup();
    const base = { name: "x", type: "cortesia", channels: ["recoger"] };
    expect((await post({ ...base, code: "SINLISTAS" })).status).toBe(400);
    expect((await post({ ...base, code: "SINCORT", productIds: [nachos], courtesyQuantity: 2 })).status).toBe(400);
    expect((await post({ ...base, code: "SINCANT", productIds: [nachos], courtesyProductIds: [agua1] })).status).toBe(400);
    expect((await post({ ...base, code: "TRASLAPA", productIds: [nachos], courtesyProductIds: [nachos], courtesyQuantity: 1 })).status).toBe(400);
    expect((await post({ ...base, code: "CANT11", productIds: [nachos], courtesyProductIds: [agua1], courtesyQuantity: 11 })).status).toBe(400);
    expect((await post({ ...base, code: "CANT0", productIds: [nachos], courtesyProductIds: [agua1], courtesyQuantity: 0 })).status).toBe(400);
    expect((await post({ ...base, code: "VALOR2", value: 2, productIds: [nachos], courtesyProductIds: [agua1], courtesyQuantity: 1 })).status).toBe(400);
  });

  it("courtesyProductIds/courtesyQuantity en una promocion que no es cortesia -> 400", async () => {
    const { post, agua1 } = await setup();
    expect((await post({ code: "NOCORT", name: "x", type: "bogo", courtesyProductIds: [agua1] })).status).toBe(400);
    expect((await post({ code: "NOCORT2", name: "x", type: "percentage", value: 10, courtesyQuantity: 2 })).status).toBe(400);
  });

  it("un producto de OTRA organizacion en las listas del combo es 400 (aislamiento)", async () => {
    const { ctx, post, nachos } = await setup();
    const ajeno = seedProduct(ctx, ctx.otherOrganizationId, "Agua ajena");
    const res = await post({ code: "AJENO", name: "x", type: "cortesia", channels: ["recoger"], productIds: [nachos], courtesyProductIds: [ajeno], courtesyQuantity: 1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/courtesyProductIds/);
  });

  it("PATCH valida la forma FINAL: activar autoApply sin canales o quitar los canales a una automatica es 400", async () => {
    const { post, patch } = await setup();
    const sin = await post({ code: "SOLOCODIGO", name: "x", type: "bogo" });
    const { promotion: p1 } = (await sin.json()) as { promotion: { id: string } };
    expect((await patch(p1.id, { autoApply: true })).status).toBe(400);
    expect((await patch(p1.id, { autoApply: true, channels: ["recoger"] })).status).toBe(200);
    expect((await patch(p1.id, { channels: null })).status).toBe(400);
    expect((await patch(p1.id, { autoApply: false, channels: null })).status).toBe(200);
  });

  it("un repartidor no crea promociones automaticas (403) y otra organizacion no las edita (404)", async () => {
    const { ctx, app, post } = await setup();
    expect((await post({ code: "REPA", name: "x", type: "bogo", autoApply: true, channels: ["recoger"] }, ctx.staff.repartidor.token)).status).toBe(403);
    const ok = await post({ code: "PROPIA2", name: "x", type: "bogo", autoApply: true, channels: ["recoger"] });
    const { promotion } = (await ok.json()) as { promotion: { id: string } };
    const res = await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/promotions/${promotion.id}`, authedJson(ctx.staff.otroOrgOwner.token, { autoApply: false }, "PATCH"));
    expect(res.status).toBe(404);
  });
});

describe("estados de recoger y datos del pedido (admin-orders)", () => {
  async function seedOrder(ctx: RestaurantesKpiTestContext, canal: "recoger" | "domicilio" | null, status: "preparando" | "pending" = "preparando") {
    const order = await ctx.restaurantesRepo.createOrderIdempotent(
      {
        organizationId: ctx.organizationId,
        propertyId: ctx.propertyIdA,
        customerId: null,
        customerName: "Ana",
        customerPhone: "+5219990001111",
        customerAddress: null,
        customerEmail: null,
        branch: "Francisco de Montejo",
        total: 120,
        items: [],
        source: "whatsapp",
        notes: canal === "recoger" ? "Canal: recoger en sucursal." : null,
        paymentMethod: "tarjeta",
        callTranscript: null,
        callRecordingUrl: null,
        canal,
        propina: canal === "recoger" ? 12 : null,
        horaRecogida: canal === "recoger" ? "2026-09-30T20:30:00-06:00" : null,
      },
      randomUUID().replaceAll("-", "").padEnd(64, "a"),
      null,
    );
    if (status === "preparando") await ctx.restaurantesRepo.updateOrderStatus(ctx.organizationId, order.id, "pending", "preparando");
    return order;
  }

  it("el listado y el detalle traen canal, propina y hora de recogida", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const order = await seedOrder(ctx, "recoger");
    const list = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders`, authedGet(ctx.staff.owner.token));
    const { orders } = (await list.json()) as { orders: Array<{ id: string; canal: string | null; propina: number | null; horaRecogida: string | null }> };
    expect(orders.find((o) => o.id === order.id)).toMatchObject({ canal: "recoger", propina: 12, horaRecogida: "2026-09-30T20:30:00-06:00" });
    const detail = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}`, authedGet(ctx.staff.owner.token));
    expect(((await detail.json()) as { order: { canal: string } }).order.canal).toBe("recoger");
  });

  it("un pedido sin canal registrado (historico) sale con canal/propina/hora en null", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const order = await seedOrder(ctx, null);
    const detail = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}`, authedGet(ctx.staff.owner.token));
    expect(((await detail.json()) as { order: Record<string, unknown> }).order).toMatchObject({ canal: null, propina: null, horaRecogida: null });
  });

  it("ciclo de recoger por la API: listo_para_recoger -> no_recogido -> vuelve a cocina (preparando)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const order = await seedOrder(ctx, "recoger");
    const setStatus = (status: string, extra: object = {}) =>
      app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status, ...extra }, "PATCH"));
    for (const status of ["listo_para_recoger", "no_recogido", "preparando"]) {
      const res = await setStatus(status);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { order: { status: string } }).order.status).toBe(status);
    }
  });

  it("aviso opcional: notifyCustomer:false no encola WhatsApp; por defecto si", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "PN-REC");
    const app = buildApp(ctx.deps);
    const sinAviso = await seedOrder(ctx, "recoger");
    const conAviso = await seedOrder(ctx, "recoger");
    const mover = (id: string, extra: object) => app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${id}/status`, authedJson(ctx.staff.owner.token, { status: "listo_para_recoger", ...extra }, "PATCH"));
    await ctx.restaurantesRepo.claimMessagingOutboxBatch(50, 60);
    expect((await mover(sinAviso.id, { notifyCustomer: false })).status).toBe(200);
    expect(await ctx.restaurantesRepo.claimMessagingOutboxBatch(50, 60)).toHaveLength(0);
    expect((await mover(conAviso.id, {})).status).toBe(200);
    const avisos = await ctx.restaurantesRepo.claimMessagingOutboxBatch(50, 60);
    expect(avisos.some((r) => String((r.payload as { body?: string }).body).includes("listo para recoger"))).toBe(true);
  });

  it("notifyCustomer que no es booleano -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const order = await seedOrder(ctx, "recoger");
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status: "listo_para_recoger", notifyCustomer: "no" }, "PATCH"));
    expect(res.status).toBe(400);
  });

  it("un pedido a domicilio no pasa a listo_para_recoger (409) y uno de recoger no sale en_camino (409)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const dom = await seedOrder(ctx, "domicilio");
    const rec = await seedOrder(ctx, "recoger");
    const patch = (id: string, status: string) => app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${id}/status`, authedJson(ctx.staff.owner.token, { status }, "PATCH"));
    expect((await patch(dom.id, "listo_para_recoger")).status).toBe(409);
    expect((await patch(rec.id, "en_camino")).status).toBe(409);
  });

  it("un staff de otra organizacion no mueve el pedido (404) y un repartidor no tiene acceso (403)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const order = await seedOrder(ctx, "recoger");
    const ajeno = await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/orders/${order.id}/status`, authedJson(ctx.staff.otroOrgOwner.token, { status: "listo_para_recoger" }, "PATCH"));
    expect(ajeno.status).toBe(404);
    const repa = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, { status: "listo_para_recoger" }, "PATCH"));
    expect(repa.status).toBe(403);
  });
});

describe("puentes: excepciones de horario por fecha", () => {
  const url = (ctx: RestaurantesKpiTestContext, suffix = "") => `/v1/restaurantes/${ctx.propertyIdA}/admin/config/puentes${suffix}`;
  const turnos = [{ abre: "12:00", cierra: "16:00" }, { abre: "18:00", cierra: "01:00" }];

  it("owner crea el mismo puente para dos sucursales con los dos turnos (parametrizables) y lo lista", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(url(ctx), authedJson(ctx.staff.owner.token, { branchIds: [ctx.propertyIdA, ctx.propertyIdB], fechaDesde: "2099-05-01", fechaHasta: "2099-05-03", turnos, motivo: "Puente 1 de mayo" }));
    expect(res.status).toBe(201);
    const { puentes } = (await res.json()) as { puentes: Array<{ branchId: string; horario: Array<{ dias: number[]; abre: string; cierra: string }>; motivo: string }> };
    expect(puentes.map((p) => p.branchId).sort()).toEqual([ctx.propertyIdA, ctx.propertyIdB].sort());
    expect(puentes[0]!.horario).toEqual([
      { dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "16:00" },
      { dias: [0, 1, 2, 3, 4, 5, 6], abre: "18:00", cierra: "01:00" },
    ]);
    const list = await app.request(url(ctx), authedGet(ctx.staff.owner.token));
    expect(((await list.json()) as { puentes: unknown[] }).puentes).toHaveLength(2);
  });

  it("validacion: fechas imposibles, rango > 31 dias, sin turnos y turnos+horario a la vez -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const post = (body: object) => app.request(url(ctx), authedJson(ctx.staff.owner.token, { branchIds: [ctx.propertyIdA], fechaDesde: "2099-05-01", fechaHasta: "2099-05-03", turnos, ...body }));
    expect((await post({ fechaDesde: "2099-02-30" })).status).toBe(400);
    expect((await post({ fechaHasta: "2099-09-01" })).status).toBe(400);
    expect((await post({ turnos: [] })).status).toBe(400);
    expect((await post({ turnos: [{ abre: "12:00", cierra: "12:00" }] })).status).toBe(400);
    expect((await post({ horario: [{ dias: [1], abre: "12:00", cierra: "16:00" }] })).status).toBe(400);
    expect((await post({ branchIds: [] })).status).toBe(400);
    expect((await post({ branchIds: ["no-uuid"] })).status).toBe(400);
  });

  it("solo owner/admin: staff de sucursal y repartidor -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const body = { branchIds: [ctx.propertyIdA], fechaDesde: "2099-05-01", fechaHasta: "2099-05-03", turnos };
    expect((await app.request(url(ctx), authedJson(ctx.staff.staffSucursalA.token, body))).status).toBe(403);
    expect((await app.request(url(ctx), authedJson(ctx.staff.repartidor.token, body))).status).toBe(403);
    expect((await app.request(url(ctx), authedJson(ctx.staff.admin.token, body))).status).toBe(201);
  });

  it("aislamiento: otra organizacion no crea puentes en mis sucursales (404) y no los ve ni los borra", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creado = await app.request(url(ctx), authedJson(ctx.staff.owner.token, { branchIds: [ctx.propertyIdA], fechaDesde: "2099-05-01", fechaHasta: "2099-05-03", turnos }));
    const { puentes } = (await creado.json()) as { puentes: Array<{ id: string }> };
    const otraUrl = `/v1/restaurantes/${ctx.otherPropertyId}/admin/config/puentes`;
    const intento = await app.request(otraUrl, authedJson(ctx.staff.otroOrgOwner.token, { branchIds: [ctx.propertyIdA], fechaDesde: "2099-06-01", fechaHasta: "2099-06-02", turnos }));
    expect(intento.status).toBe(404);
    const lista = await app.request(otraUrl, authedGet(ctx.staff.otroOrgOwner.token));
    expect(((await lista.json()) as { puentes: unknown[] }).puentes).toEqual([]);
    const borrar = await app.request(`${otraUrl}/${puentes[0]!.id}`, authedJson(ctx.staff.otroOrgOwner.token, undefined, "DELETE"));
    expect(borrar.status).toBe(404);
  });

  it("borrar un puente: 204 y deja de listarse; un id inexistente es 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creado = await app.request(url(ctx), authedJson(ctx.staff.owner.token, { branchIds: [ctx.propertyIdA], fechaDesde: "2099-05-01", fechaHasta: "2099-05-03", turnos }));
    const { puentes } = (await creado.json()) as { puentes: Array<{ id: string }> };
    expect((await app.request(url(ctx, `/${puentes[0]!.id}`), authedJson(ctx.staff.owner.token, undefined, "DELETE"))).status).toBe(204);
    expect(((await (await app.request(url(ctx), authedGet(ctx.staff.owner.token))).json()) as { puentes: unknown[] }).puentes).toEqual([]);
    expect((await app.request(url(ctx, `/${randomUUID()}`), authedJson(ctx.staff.owner.token, undefined, "DELETE"))).status).toBe(404);
  });
});

describe("cotizar_pedido por HTTP (voz): doble porcion de salsa y tortilla mixta", () => {
  const SECRETO = { "x-atiende-tool-secret": "test-voice-tool-secret" };

  it("tortilla mixta se acepta en la cotizacion", async () => {
    const { buildTestDeps, jsonRequestInit } = await import("./fixtures.ts");
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders/quote",
      jsonRequestInit({ branch_slug: "fco-montejo", items: [{ product_id: products.tacosPastor, requested_quantity: 3, tortilla: "mixta" }] }, SECRETO),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quote: { total: number; lines: Array<{ tortilla: string | null }> } };
    expect(body.quote.lines[0]!.tortilla).toBe("mixta");
    expect(body.quote.total).toBe(164);
  });

  it("doble porcion de salsa sin el producto 'Extra salsa' en el catalogo: 400 accionable, nunca un precio inventado", async () => {
    const { buildTestDeps, jsonRequestInit } = await import("./fixtures.ts");
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders/quote",
      jsonRequestInit({ branch_slug: "fco-montejo", items: [{ product_id: products.cocaCola, requested_quantity: 1 }], doble_salsas: ["salsa_roja"] }, SECRETO),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/todavía no tiene precio/);
  });
});
