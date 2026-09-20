// FASE 3 (producto) — bitácora de auditoría del staff. Dos frentes, ambos HTTP
// real (vía app.request, sin mockear el repo -- mismo criterio que el resto de
// tests de este vertical, y que apps/api/tests/rentas-auditoria.spec.ts):
//
//   1. Cada ruta de escritura sensible (precio/disponibilidad de producto,
//      promociones, cancelar pedido, asignar repartidor, invitar/revocar/cambiar
//      rol de staff) registra la fila esperada en `ctx.restaurantesRepo.auditLog`
//      -- inspección directa del doble en memoria.
//   2. GET /v1/restaurantes/:propertyId/admin/auditoria: paginado, filtro por
//      tipo/fechas, solo owner/admin, cross-tenant siempre rechazado.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

describe("FASE 3 — registro de auditoría en las rutas de escritura reales", () => {
  it("PATCH .../products/:productId con price registra producto.precio_actualizado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Agua de Horchata", price: 35 }));
    const productId = ((await created.json()) as { product: { id: string } }).product.id;
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(ctx.staff.owner.token, { price: 45 }, "PATCH"));
    expect(res.status).toBe(200);

    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "producto", action: "producto.precio_actualizado", entityId: productId, actorUserId: ctx.staff.owner.id, antes: "35", despues: "45" });
  });

  it("PATCH .../products/:productId sin tocar price/isAvailable -- nunca registra (fuera de alcance de esta fase)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Agua de Horchata", price: 35 }));
    const productId = ((await created.json()) as { product: { id: string } }).product.id;
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(ctx.staff.owner.token, { name: "Agua de Horchata Grande" }, "PATCH"));
    expect(res.status).toBe(200);
    expect(ctx.restaurantesRepo.auditLog.slice(antes)).toHaveLength(0);
  });

  it("PATCH .../products/:productId con isAvailable registra producto.disponibilidad_actualizada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Agua de Horchata", price: 35, isAvailable: true }));
    const productId = ((await created.json()) as { product: { id: string } }).product.id;
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(ctx.staff.owner.token, { isAvailable: false }, "PATCH"));
    expect(res.status).toBe(200);
    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "producto", action: "producto.disponibilidad_actualizada", entityId: productId, antes: "true", despues: "false" });
  });

  it("PATCH .../products/:productId/branch-availability registra producto.disponibilidad_sucursal_actualizada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Agua de Horchata", price: 35 }));
    const productId = ((await created.json()) as { product: { id: string } }).product.id;
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}/branch-availability`,
      authedJson(ctx.staff.owner.token, { price: 40, isAvailable: true }, "PATCH"),
    );
    expect(res.status).toBe(200);
    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "producto", action: "producto.disponibilidad_sucursal_actualizada", entityId: productId, actorUserId: ctx.staff.owner.id });
    expect(nuevas[0]!.despues).toContain(`price=40 isAvailable=true`);
  });

  it("POST .../promotions registra promocion.creada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(ctx.staff.owner.token, { code: "BIENVENIDA10", name: "Bienvenida", type: "percentage", value: 10 }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { promotion: { id: string } };

    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "promocion", action: "promocion.creada", entityId: created.promotion.id, actorUserId: ctx.staff.owner.id });
    expect(nuevas[0]!.despues).toContain("BIENVENIDA10");
  });

  it("PATCH .../promotions/:id con isActive:false registra promocion.desactivada (no 'actualizada')", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(ctx.staff.owner.token, { code: "TEMP", name: "Temporal", type: "fixed", value: 20, isActive: true }));
    const promotionId = ((await created.json()) as { promotion: { id: string } }).promotion.id;
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions/${promotionId}`, authedJson(ctx.staff.owner.token, { isActive: false }, "PATCH"));
    expect(res.status).toBe(200);
    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "promocion", action: "promocion.desactivada", entityId: promotionId });
  });

  it("PATCH .../promotions/:id sin tocar isActive registra promocion.actualizada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(ctx.staff.owner.token, { code: "TEMP2", name: "Temporal", type: "fixed", value: 20 }));
    const promotionId = ((await created.json()) as { promotion: { id: string } }).promotion.id;
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions/${promotionId}`, authedJson(ctx.staff.owner.token, { value: 30 }, "PATCH"));
    expect(res.status).toBe(200);
    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "promocion", action: "promocion.actualizada", entityId: promotionId });
  });

  it("PATCH .../orders/:orderId/status a 'cancelado' registra pedido.cancelado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status: "cancelado" }, "PATCH"));
    expect(res.status).toBe(200);
    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "pedido", action: "pedido.cancelado", entityId: order.id, antes: "pending", despues: "cancelado", actorUserId: ctx.staff.owner.id });
  });

  it("PATCH .../orders/:orderId/status a 'preparando' (transición normal, no cancelación) -- nunca registra", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status: "preparando" }, "PATCH"));
    expect(res.status).toBe(200);
    expect(ctx.restaurantesRepo.auditLog.slice(antes)).toHaveLength(0);
  });

  it("PATCH .../orders/:orderId/assign-repartidor registra repartidor.asignado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/assign-repartidor`,
      authedJson(ctx.staff.owner.token, { repartidorId: ctx.staff.repartidor.id }, "PATCH"),
    );
    expect(res.status).toBe(200);
    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "repartidor", action: "repartidor.asignado", entityId: order.id, antes: null, despues: ctx.staff.repartidor.id });
  });

  it("reasignar un pedido ya despachado registra repartidor.reasignado (no 'asignado')", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    // `assignedRepartidorId` ya viene poblado desde el seed (equivalente a un
    // dispatch previo real) -- el PATCH de abajo es la SEGUNDA asignación de
    // este mismo pedido, así que debe leerse como reasignación, no como alta.
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100, assignedRepartidorId: ctx.staff.repartidor.id });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/assign-repartidor`,
      authedJson(ctx.staff.owner.token, { repartidorId: ctx.staff.repartidor.id }, "PATCH"),
    );
    expect(res.status).toBe(200);
    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "repartidor", action: "repartidor.reasignado", entityId: order.id, antes: ctx.staff.repartidor.id, despues: ctx.staff.repartidor.id });
  });

  it("POST .../staff/invitaciones registra staff.invitado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "nuevo@lostaquitos.mx", verticalRole: "staff" }));
    expect(res.status).toBe(201);
    const invite = (await res.json()) as { id: string };

    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "staff", action: "staff.invitado", entityId: invite.id, actorUserId: ctx.staff.owner.id });
    // Correo ENMASCARADO en la bitácora (append-only, imborrable) -- hallazgo no
    // bloqueante del revisor del PR #183 -- nunca el correo completo.
    expect(nuevas[0]!.despues).toContain("n***@lostaquitos.mx");
    expect(nuevas[0]!.despues).not.toContain("nuevo@lostaquitos.mx");
  });

  it("DELETE .../staff/invitaciones/:id registra staff.invitacion_revocada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "revocar@lostaquitos.mx", verticalRole: "staff" }));
    const inviteId = ((await created.json()) as { id: string }).id;
    const antes = ctx.restaurantesRepo.auditLog.length;

    const del = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/invitaciones/${inviteId}`, { method: "DELETE", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(del.status).toBe(200);

    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "staff", action: "staff.invitacion_revocada", entityId: inviteId });
  });

  it("PATCH .../staff/miembros/:userId registra staff.rol_actualizado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.restaurantesRepo.auditLog.length;

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.staffSucursalA.id}`, authedJson(ctx.staff.owner.token, { verticalRole: "admin" }, "PATCH"));
    expect(res.status).toBe(200);

    const nuevas = ctx.restaurantesRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "staff", action: "staff.rol_actualizado", entityId: ctx.staff.staffSucursalA.id, antes: "staff", despues: "admin", actorUserId: ctx.staff.owner.id });
  });
});

describe("FASE 3 — GET /v1/restaurantes/:propertyId/admin/auditoria", () => {
  it("exige un token (401)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria`);
    expect(res.status).toBe(401);
  });

  it("staff (MANAGER_ROLES, pero no owner/admin) -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria`, authedGet(ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(403);
  });

  it("repartidor -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(403);
  });

  it("staff de OTRA organización -> 403 (cross-tenant, requirePropertyMembership)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });

  it("owner lee su propia bitácora, paginada, más reciente primero", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Agua", price: 20 }));
    const productId = ((await created.json()) as { product: { id: string } }).product.id;
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(ctx.staff.owner.token, { price: 22 }, "PATCH"));
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(ctx.staff.owner.token, { price: 24 }, "PATCH"));

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; total: number; items: Array<{ action: string; despues: string | null }> };
    expect(body.disponible).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(2);
    // Más reciente primero: el último precio (24) debe aparecer antes que el
    // penúltimo (22) entre las filas de este producto.
    const precios = body.items.filter((i) => i.action === "producto.precio_actualizado").map((i) => i.despues);
    expect(precios[0]).toBe("24");
    expect(precios[1]).toBe("22");
  });

  it("admin (no solo owner) también puede leer", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria`, authedGet(ctx.staff.admin.token));
    expect(res.status).toBe(200);
  });

  it("filtro ?tipo= solo trae ese entityType", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(ctx.staff.owner.token, { code: "FILTRO1", name: "x", type: "fixed", value: 10 }));
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 50 });
    ctx.restaurantesRepo.seedOrder(order);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status: "cancelado" }, "PATCH"));

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?tipo=promocion`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ entityType: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.entityType === "promocion")).toBe(true);
  });

  it("tipo inválido -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?tipo=no-existe`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  // Regresión (revisor independiente del PR #183, no bloqueante #4): antes de este
  // fix, "desde"/"hasta" solo validaban la FORMA (YYYY-MM-DD), así que una fecha de
  // calendario inválida llegaba tal cual al `::timestamptz` de
  // PostgresRestaurantesRepository.listAuditoria (SQLSTATE 22008, no recuperable
  // por runWithSavepointFallback) y terminaba en 500 en vez de 400.
  it("desde con fecha de calendario inválida (mes/día fuera de rango) -> 400, nunca 500", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?desde=2026-13-45`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("hasta con 29 de febrero de un año NO bisiesto -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?hasta=2026-02-29`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  // Regresión (no bloqueante #4): `Number.parseInt("12abc", 10)` devuelve 12 --
  // antes de este fix, limit/offset aceptaban basura al final en vez de rechazarla.
  it("limit con basura al final ('12abc') -> 400, no se trunca en 12", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?limit=12abc`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("offset negativo -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?offset=-1`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("paginación real: limit=1 dos veces trae 2 filas distintas y nextOffset avanza", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Agua", price: 20 }));
    const productId = ((await created.json()) as { product: { id: string } }).product.id;
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(ctx.staff.owner.token, { price: 21 }, "PATCH"));
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(ctx.staff.owner.token, { price: 22 }, "PATCH"));

    const pagina1 = (await (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?limit=1`, authedGet(ctx.staff.owner.token))).json()) as {
      items: Array<{ id: string }>;
      nextOffset: number | null;
    };
    expect(pagina1.items).toHaveLength(1);
    expect(pagina1.nextOffset).toBe(1);

    const pagina2 = (await (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?limit=1&offset=${pagina1.nextOffset}`, authedGet(ctx.staff.owner.token))).json()) as {
      items: Array<{ id: string }>;
    };
    expect(pagina2.items).toHaveLength(1);
    expect(pagina2.items[0]!.id).not.toBe(pagina1.items[0]!.id);
  });

  it("cross-tenant: la bitácora de una organización nunca mezcla filas de otra", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // Genera actividad en AMBAS organizaciones.
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(ctx.staff.owner.token, { code: "ORGA", name: "x", type: "fixed", value: 10 }));
    await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/promotions`, authedJson(ctx.staff.otroOrgOwner.token, { code: "ORGB", name: "y", type: "fixed", value: 10 }));

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { items: Array<{ despues: string | null }> };
    expect(body.items.some((i) => i.despues?.includes("ORGB"))).toBe(false);
  });
});
