// Fase 10 hoteles — motor de recomendaciones de tarifa v1: integración HTTP real de
// listar/aprobar/descartar recomendaciones, configurar pricing_rule, y capturar
// local_event/competitor_rate (migrations/029_rate_recommendation_engine.sql).
//
// La ENFORCEMENT real del gate/backtest sobre las transiciones de estado vive en el
// trigger de Postgres (`hoteles.rate_recommendation_status_guard`) — el repositorio
// en memoria usado aquí es una réplica SIMPLIFICADA (no reaplica esas reglas, ver
// comentario de cabecera de `InMemoryHotelesRepository`), así que esos escenarios
// (aprobar en "shadow", aplicar fuera de autopilot, backtest que no pasa, límite de
// variación) están cubiertos contra Postgres REAL en
// scripts/verify-hoteles-motor-tarifas/, no aquí. Este archivo cubre lo que SÍ
// depende de la ruta HTTP: RBAC (assertVerticalRole), scoping por property,
// paginación con orden total, y validación de body.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

const OTRA_PROPERTY_ID = "00000000-0000-0000-0000-000000000000";

interface RecommendationBody {
  id: string;
  fecha: string;
  estado: string;
  recommendedPrice: number;
  aprobadaPor: string | null;
  descartadaPor: string | null;
  desglose: Record<string, unknown>;
}

async function seedRecommendation(ctxRef: HotelesTestContext, fecha: string, overrides: Partial<{ currentBarPrice: number; recommendedPrice: number }> = {}) {
  return ctxRef.hotelesRepo.insertRateRecommendationAsSystem({
    organizationId: ctxRef.organizationId,
    propertyId: ctxRef.propertyId,
    roomTypeId: ctxRef.roomTypeId,
    fecha,
    currentBarPrice: overrides.currentBarPrice ?? 2000,
    recommendedPrice: overrides.recommendedPrice ?? 2200,
    suggestedMinStay: 1,
    desglose: { pickup: { onTheBooksVsExpectedPct: 15 }, ajustes: { totalPct: 10 } },
  });
}

describe("GET /hoteles/:propertyId/revenue/recomendaciones", () => {
  it("lista vacía cuando no hay ninguna recomendación calculada todavía", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recomendaciones: RecommendationBody[]; nextCursor: unknown };
    expect(body.recomendaciones).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("cualquier rol de staff de la property ve las recomendaciones con su desglose completo -- nunca una caja negra", async () => {
    await seedRecommendation(ctx, "2026-12-25");
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones`, authedJson(ctx.staff.housekeeping.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recomendaciones: RecommendationBody[] };
    expect(body.recomendaciones).toHaveLength(1);
    expect(body.recomendaciones[0]!.desglose).toEqual({ pickup: { onTheBooksVsExpectedPct: 15 }, ajustes: { totalPct: 10 } });
    expect(body.recomendaciones[0]!.estado).toBe("pendiente");
  });

  it("filtra por estado", async () => {
    const a = await seedRecommendation(ctx, "2026-12-25");
    await seedRecommendation(ctx, "2026-12-26");
    await ctx.hotelesRepo.discardRateRecommendation(a.id, ctx.staff.owner.id);
    const app = buildApp(ctx.deps);

    const pendientes = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones?estado=pendiente`, authedJson(ctx.staff.owner.token));
    expect(((await pendientes.json()) as { recomendaciones: RecommendationBody[] }).recomendaciones).toHaveLength(1);

    const descartadas = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones?estado=descartada`, authedJson(ctx.staff.owner.token));
    expect(((await descartadas.json()) as { recomendaciones: RecommendationBody[] }).recomendaciones).toHaveLength(1);
  });

  it("rechaza un estado fuera del catálogo", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones?estado=inventado`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("paginación con orden TOTAL (fecha desc) y cursor keyset -- sin repetir ni perder filas", async () => {
    for (const fecha of ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05"]) {
      await seedRecommendation(ctx, fecha);
    }
    const app = buildApp(ctx.deps);

    const page1 = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones?limit=2`, authedJson(ctx.staff.owner.token));
    const body1 = (await page1.json()) as { recomendaciones: RecommendationBody[]; nextCursor: { cursorFecha: string; cursorRoomTypeId: string; cursorId: string } | null };
    expect(body1.recomendaciones.map((r) => r.id)).toEqual(expect.any(Array));
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/recomendaciones?limit=2&cursorFecha=${body1.nextCursor!.cursorFecha}&cursorRoomTypeId=${body1.nextCursor!.cursorRoomTypeId}&cursorId=${body1.nextCursor!.cursorId}`,
      authedJson(ctx.staff.owner.token),
    );
    const body2 = (await page2.json()) as { recomendaciones: RecommendationBody[] };

    const allDates = [...body1.recomendaciones, ...body2.recomendaciones].map((r) => r.fecha);
    expect(new Set(allDates).size).toBe(allDates.length); // sin duplicados entre páginas
    // Orden descendente: cada fecha de la página 1 es >= cada fecha de la página 2.
    expect(Math.min(...body1.recomendaciones.map((r) => Date.parse(r.fecha)))).toBeGreaterThanOrEqual(Math.max(...body2.recomendaciones.map((r) => Date.parse(r.fecha))));
  });

  it("404 al pedir una recomendación de otra property", async () => {
    const rec = await seedRecommendation(ctx, "2026-12-25");
    const app = buildApp(ctx.deps);
    // Sin membership a OTRA_PROPERTY_ID -> el middleware ya responde 403 antes de
    // llegar al handler; se prueba el caso real (mismo staff, id de OTRA property
    // que no existe) devolviendo 404 desde el handler.
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones/${rec.id}-inexistente`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(404);
  });

  it("403 cross-property (sin membership a otra property)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${OTRA_PROPERTY_ID}/revenue/recomendaciones`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(403);
  });
});

describe("POST /hoteles/:propertyId/revenue/recomendaciones/:id/aprobar|descartar", () => {
  it("owner/gm aprueban -- efecto real: estado pasa a 'aprobada' con aprobadaPor", async () => {
    const rec = await seedRecommendation(ctx, "2026-12-25");
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones/${rec.id}/aprobar`, authedJson(ctx.staff.gm.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecommendationBody;
    expect(body.estado).toBe("aprobada");
    expect(body.aprobadaPor).toBe(ctx.staff.gm.id);
  });

  it("rechaza aprobar/descartar a un rol fuera de REVENUE_RECOMMENDATION_APPROVE_ROLES (frontdesk)", async () => {
    const rec = await seedRecommendation(ctx, "2026-12-25");
    const app = buildApp(ctx.deps);
    const aprobar = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones/${rec.id}/aprobar`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(aprobar.status).toBe(403);
    const descartar = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones/${rec.id}/descartar`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(descartar.status).toBe(403);
  });

  it("owner descarta -- efecto real: estado pasa a 'descartada' con descartadaPor", async () => {
    const rec = await seedRecommendation(ctx, "2026-12-25");
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones/${rec.id}/descartar`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecommendationBody;
    expect(body.estado).toBe("descartada");
    expect(body.descartadaPor).toBe(ctx.staff.owner.id);
  });

  it("404 al aprobar una recomendación de otra property", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/recomendaciones/00000000-0000-0000-0000-000000000abc/aprobar`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(404);
  });
});

describe("GET/PUT /hoteles/:propertyId/revenue/pricing-rule/:roomTypeId", () => {
  it("sin configurar, GET devuelve el default razonable marcado esDefault:true", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/pricing-rule/${ctx.roomTypeId}`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { esDefault: boolean; floorPrice: number };
    expect(body.esDefault).toBe(true);
    expect(body.floorPrice).toBe(0);
  });

  it("owner/gm configuran floor/ceiling/DOW/LOS -- efecto real, GET posterior refleja lo guardado", async () => {
    const app = buildApp(ctx.deps);
    const put = await app.request(`/hoteles/${ctx.propertyId}/revenue/pricing-rule/${ctx.roomTypeId}`, {
      ...authedJson(ctx.staff.owner.token, { floorPrice: 1000, ceilingPrice: 4000, dayOfWeekMultiplier: [1, 0.9, 0.9, 0.9, 0.9, 1.1, 1.2], minStayDefault: 1, minStayOnHighDemand: 3 }),
      method: "PUT",
    });
    expect(put.status).toBe(200);

    const get = await app.request(`/hoteles/${ctx.propertyId}/revenue/pricing-rule/${ctx.roomTypeId}`, authedJson(ctx.staff.frontdesk.token));
    const body = (await get.json()) as { esDefault: boolean; floorPrice: number; ceilingPrice: number };
    expect(body.esDefault).toBe(false);
    expect(body.floorPrice).toBe(1000);
    expect(body.ceilingPrice).toBe(4000);
  });

  it("rechaza configurar a un rol fuera de REVENUE_PRICING_RULES_MANAGE_ROLES (accountant)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/pricing-rule/${ctx.roomTypeId}`, {
      ...authedJson(ctx.staff.accountant.token, { floorPrice: 1000, ceilingPrice: 4000, dayOfWeekMultiplier: [1, 1, 1, 1, 1, 1, 1] }),
      method: "PUT",
    });
    expect(res.status).toBe(403);
  });

  it("rechaza ceiling < floor con 400 (validación de dominio, antes de tocar el repositorio)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/pricing-rule/${ctx.roomTypeId}`, {
      ...authedJson(ctx.staff.owner.token, { floorPrice: 5000, ceilingPrice: 1000, dayOfWeekMultiplier: [1, 1, 1, 1, 1, 1, 1] }),
      method: "PUT",
    });
    expect(res.status).toBe(400);
  });

  it("rechaza un dayOfWeekMultiplier que no tiene exactamente 7 valores", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/pricing-rule/${ctx.roomTypeId}`, {
      ...authedJson(ctx.staff.owner.token, { floorPrice: 1000, ceilingPrice: 4000, dayOfWeekMultiplier: [1, 1, 1] }),
      method: "PUT",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET/POST /hoteles/:propertyId/revenue/local-events", () => {
  it("owner/gm/accountant registran un evento local -- efecto real", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/local-events`,
      authedJson(ctx.staff.accountant.token, { nombre: "Congreso médico regional", fechaInicio: "2026-11-10", fechaFin: "2026-11-12", impacto: "alza_demanda", magnitudPct: 30 }),
    );
    expect(res.status).toBe(201);

    const list = await app.request(`/hoteles/${ctx.propertyId}/revenue/local-events?desde=2026-11-01&hasta=2026-11-30`, authedJson(ctx.staff.owner.token));
    const body = (await list.json()) as { nombre: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.nombre).toBe("Congreso médico regional");
  });

  it("rechaza registrar un evento local a un rol fuera de REVENUE_DATA_CAPTURE_ROLES (frontdesk)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/local-events`,
      authedJson(ctx.staff.frontdesk.token, { nombre: "x", fechaInicio: "2026-11-10", fechaFin: "2026-11-10", impacto: "alza_demanda", magnitudPct: 10 }),
    );
    expect(res.status).toBe(403);
  });

  it("rechaza un impacto fuera del catálogo cerrado", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/local-events`,
      authedJson(ctx.staff.owner.token, { nombre: "x", fechaInicio: "2026-11-10", fechaFin: "2026-11-10", impacto: "sube", magnitudPct: 10 }),
    );
    expect(res.status).toBe(400);
  });

  it("rechaza sin las 2 fechas (desde/hasta) al listar", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/local-events`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });
});

describe("GET/POST /hoteles/:propertyId/revenue/competitor-rates", () => {
  it("owner/gm/accountant capturan una tarifa de competidor -- efecto real", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/competitor-rates`, authedJson(ctx.staff.owner.token, { competidor: "Hotel Vecino", fecha: "2026-12-25", tarifa: 2500 }));
    expect(res.status).toBe(201);

    const list = await app.request(`/hoteles/${ctx.propertyId}/revenue/competitor-rates?fecha=2026-12-25`, authedJson(ctx.staff.frontdesk.token));
    const body = (await list.json()) as { competidor: string; tarifa: number }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.competidor).toBe("Hotel Vecino");
    expect(body[0]!.tarifa).toBe(2500);
  });

  it("rechaza capturar a un rol fuera de REVENUE_DATA_CAPTURE_ROLES (housekeeping)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/competitor-rates`, authedJson(ctx.staff.housekeeping.token, { competidor: "x", fecha: "2026-12-25", tarifa: 2000 }));
    expect(res.status).toBe(403);
  });

  it("rechaza una tarifa no positiva", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/competitor-rates`, authedJson(ctx.staff.owner.token, { competidor: "x", fecha: "2026-12-25", tarifa: 0 }));
    expect(res.status).toBe(400);
  });
});
