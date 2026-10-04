// QA restaurantes ronda 1 -- lente SEGURIDAD Y DATOS (pruebas adversariales HTTP sobre el repo en
// memoria). Cada caso fija el comportamiento ESPERADO de defensa en profundidad; los que fallan hoy
// documentan un defecto abierto del reporte de QA (ids QA-restaurantes-R1-seguridad-NN). Los que pasan
// quedan como regresion.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

describe("QA-R1 seguridad: alcance por sucursal en promociones (QA-restaurantes-R1-seguridad-04)", () => {
  it("staff acotado a la sucursal A no crea una promocion que aplica a TODAS las sucursales", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`,
      authedJson(ctx.staff.staffSucursalA.token, { code: "QAR1TODAS", name: "x", type: "percentage", value: 100 }),
    );
    // Esperado: 403, o 201 con la promocion acotada a SU sucursal (nunca org-wide).
    if (res.status === 201) {
      const body = (await res.json()) as { promotion: { propertyIds?: string[] | null } };
      expect(body.promotion.propertyIds ?? null).toEqual([ctx.propertyIdA]);
    } else {
      expect(res.status).toBe(403);
    }
  });

  it("staff acotado a la sucursal A no desactiva una promocion org-wide creada por el owner", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`,
      authedJson(ctx.staff.owner.token, { code: "QAR1OWNER", name: "Owner", type: "fixed", value: 10 }),
    );
    expect(created.status).toBe(201);
    const { promotion } = (await created.json()) as { promotion: { id: string } };
    const patch = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions/${promotion.id}`,
      authedJson(ctx.staff.staffSucursalA.token, { isActive: false }, "PATCH"),
    );
    expect(patch.status).toBe(403);
  });
});

describe("QA-R1 seguridad: control de regresion (pasa hoy)", () => {
  it("staff acotado a A no lee un pedido de la sucursal B por id (IDOR)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const pedidoB = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdB, status: "pending", total: 250 });
    ctx.restaurantesRepo.seedOrder(pedidoB);
    const orderId = pedidoB.id;
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${orderId}`, authedGet(ctx.staff.staffSucursalA.token));
    expect([403, 404]).toContain(res.status);
    // y tampoco cambia su estado
    const patch = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${orderId}/status`, authedJson(ctx.staff.staffSucursalA.token, { status: "cancelado" }, "PATCH"));
    expect([403, 404]).toContain(patch.status);
  });

  it("owner de otra organizacion no lee la bandeja de pedidos de esta (cross-tenant)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });

  it("repartidor no entra a clientes (PII) del panel", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(403);
  });

  it("rastreo publico: un token alterado o de otro pedido responde 404 sin oraculo", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const forjado = "t1.eyJvcmciOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEifQ.AAAA";
    const res = await app.request(`/v1/restaurantes/los-taquitos-de-pm/storefront/track/${forjado}`);
    expect(res.status).toBe(404);
  });
});

describe("QA-R1 seguridad: credenciales de voz invalidas sin tope (QA-restaurantes-R1-seguridad-05)", () => {
  it("una rafaga de secretos invalidos termina en 429 y no escribe filas ilimitadas en la bitacora append-only", async () => {
    const { deps, restaurantesRepo } = await buildTestDeps();
    const app = buildApp(deps);
    const intentos = 150;
    const estados: number[] = [];
    for (let i = 0; i < intentos; i++) {
      const res = await app.request(
        "/v1/restaurantes/los-taquitos-de-pm/branches/nearest",
        jsonRequestInit({ colonia: "Centro" }, { "x-atiende-tool-secret": `secreto-invalido-${i}`, "x-forwarded-for": "203.0.113.9" }),
      );
      estados.push(res.status);
    }
    // Esperado: el atacante sin credencial valida recibe 429 en algun punto y la bitacora queda acotada.
    expect(estados).toContain(429);
    const denegadas = restaurantesRepo.voiceToolAudit.filter((a) => a.outcome === "denied").length;
    expect(denegadas).toBeLessThan(intentos);
  });
});

describe("QA-R1 seguridad: storefront publico con slug inexistente (QA-restaurantes-R1-seguridad-09)", () => {
  it("una rafaga contra slugs inexistentes tambien se limita por IP (no solo los slugs validos)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const estados: number[] = [];
    for (let i = 0; i < 130; i++) {
      const res = await app.request(`/v1/restaurantes/no-existe-${i}/storefront`, { headers: { "x-forwarded-for": "203.0.113.10" } });
      estados.push(res.status);
    }
    expect(estados).toContain(429);
  });
});
