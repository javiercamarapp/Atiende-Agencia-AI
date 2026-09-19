// r5 -- bitácora de auditoría del staff. Dos frentes, ambos HTTP real (vía
// app.request, sin mockear el repo -- mismo criterio que el resto de tests de este
// vertical):
//
//   1. Cada ruta de escritura sensible (pricing, reservas, payouts, owner statement,
//      ical-sync) registra la fila esperada en `ctx.rentasRepo.auditLog` -- inspección
//      directa del doble en memoria (más barato y más preciso que re-verificar cada
//      flujo de negocio completo, que ya tiene su propio spec).
//   2. GET /v1/rentas/:orgSlug/admin/auditoria: paginado, filtro por tipo/fechas,
//      solo admin_gestora, cross-tenant siempre rechazado.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";

describe("r5 — registro de auditoría en las rutas de escritura reales", () => {
  it("POST .../tarifa-base registra una fila de auditoría entityType=pricing", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.rentasRepo.auditLog.length;

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 250000, moneda: "MXN" }));
    expect(res.status).toBe(201);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "pricing", action: "pricing.tarifa_base.actualizada", entityId: ctx.unidadId, actorUserId: ctx.staff.adminGestora.id });
    expect(nuevas[0]!.despues).toContain("250000 MXN");
  });

  it("POST .../reservas/:id/cancelar registra una fila de auditoría entityType=reserva con antes/despues del estado", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };

    const antes = ctx.rentasRepo.auditLog.length;
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(res.status).toBe(200);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "reserva", action: "reserva.cancelada", entityId: id, campo: "estado", antes: "confirmado", despues: "cancelado" });
  });

  it("POST .../payouts registra una fila de auditoría entityType=payout", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.rentasRepo.auditLog.length;

    const res = await app.request(
      `/rentas/${ctx.propertyId}/payouts`,
      authedJson(ctx.staff.adminGestora.token, { canalCodigo: "manual", moneda: "MXN", fechaPayout: "2026-06-10", lineas: [{ referenciaExternaReserva: null, montoCentavos: 1000 }] }),
    );
    expect(res.status).toBe(201);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "payout", action: "payout.registrado" });
  });

  it("POST .../canales/:canal/ical-sync (conectar) y DELETE (desconectar) registran ambas filas entityType=canal", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`;
    const antes = ctx.rentasRepo.auditLog.length;

    const conectar = await app.request(base, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));
    expect(conectar.status).toBe(201);
    const desconectar = await app.request(base, { method: "DELETE", headers: { authorization: `Bearer ${ctx.staff.adminGestora.token}` } });
    expect(desconectar.status).toBe(200);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(2);
    expect(nuevas[0]).toMatchObject({ entityType: "canal", action: "canal.ical_conectado" });
    expect(nuevas[1]).toMatchObject({ entityType: "canal", action: "canal.ical_desconectado" });
  });
});

describe("GET /v1/rentas/:orgSlug/admin/auditoria", () => {
  it("admin_gestora lee la bitácora paginada, más reciente primero", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100000, moneda: "MXN" }));
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 200000, moneda: "MXN", vigenteDesde: "2026-07-01" }));

    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; total: number; items: { action: string; despues: string | null }[] };
    expect(body.disponible).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(2);
    // más reciente primero -- la última tarifa creada (200000) debe aparecer antes.
    expect(body.items[0]!.despues).toContain("200000");
  });

  it("filtra por tipo (?tipo=pricing) y por fechas", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100000, moneda: "MXN" }));
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));

    const soloPricing = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria?tipo=pricing", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    const bodyPricing = (await soloPricing.json()) as { items: { entityType: string }[] };
    expect(bodyPricing.items.length).toBeGreaterThan(0);
    expect(bodyPricing.items.every((i) => i.entityType === "pricing")).toBe(true);

    const futuro = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria?desde=2099-01-01", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    const bodyFuturo = (await futuro.json()) as { items: unknown[]; total: number };
    expect(bodyFuturo.total).toBe(0);
  });

  it("un tipo inválido en el query -- 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria?tipo=lo-que-sea", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(400);
  });

  it("un staff sin rol admin_gestora (contador) recibe 403, nunca una lista vacía silenciosa", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100000, moneda: "MXN" }));

    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", authedJson(ctx.staff.contador.token, undefined, {}, "GET"));
    expect(res.status).toBe(403);
  });

  it("operador (acceso total, pero sin admin_gestora) también recibe 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", authedJson(ctx.staff.operadorAccesoTotal.token, undefined, {}, "GET"));
    expect(res.status).toBe(403);
  });

  it("cross-tenant: un staff con token de OTRO contexto (sin membership conocida aquí) nunca ve esta bitácora -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const otherCtx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100000, moneda: "MXN" }));

    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", authedJson(otherCtx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(403);
  });

  it("sin token -- 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria");
    expect(res.status).toBe(401);
  });

  it("slug inexistente -- 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/esta-gestora-no-existe/admin/auditoria", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(404);
  });
});
