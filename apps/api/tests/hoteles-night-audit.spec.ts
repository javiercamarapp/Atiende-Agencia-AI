// Fase 6 hoteles (REQ-REV-013) — integración HTTP real de night audit: la ruta
// interna de barrido (gateada por secreto compartido, MISMO patrón que
// apps/api/tests/citas-reminders.spec.ts) y el disparo/consulta manual protegido por
// NIGHT_AUDIT_ROLES.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

interface NightAuditSummaryBody {
  fecha: string;
  cargosPosteados: { reservationId: string; folioId: string; amount: number; taxAmount: number }[];
  noShows: unknown[];
  anomalias: { reservationId: string; type: string }[];
  ocupacion: { enCasa: number };
  conciliacionAB: { estado: string };
  yaCompletado: boolean;
}

async function seedInHouseReservation(ctx: HotelesTestContext, checkInDate: string, checkOutDate: string) {
  const reservation = await ctx.hotelesRepo.insertReservation({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    roomTypeId: ctx.roomTypeId,
    guestId: null,
    checkInDate,
    checkOutDate,
    totalAmount: 1500,
  });
  await ctx.hotelesRepo.transitionReservation(ctx.propertyId, reservation.id, ["confirmada"], "check_in", null);
  await ctx.hotelesRepo.transitionReservation(ctx.propertyId, reservation.id, ["check_in"], "en_estancia", null);
  const folio = await ctx.hotelesRepo.ensurePrimaryFolio(ctx.propertyId, ctx.organizationId, reservation.id);
  return { reservation, folio };
}

describe("POST /internal/hoteles/night-audit", () => {
  it("rechaza sin el secreto interno", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/hoteles/night-audit", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("con el secreto real, recorre las properties de hoteles activas sin lanzar", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/hoteles/night-audit", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; properties_revisadas: number; corridas: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.properties_revisadas).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /hoteles/:propertyId/night-audit -- disparo manual", () => {
  it("rechaza un rol sin acceso a NIGHT_AUDIT_ROLES (housekeeping)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.housekeeping.token, { businessDate: "2026-12-01" }));
    expect(res.status).toBe(403);
  });

  it("owner/gm/accountant pueden disparar el cierre de una fecha explícita: postea el hospedaje de la reserva en casa", async () => {
    const { reservation, folio } = await seedInHouseReservation(ctx, "2026-12-01", "2026-12-03");
    const app = buildApp(ctx.deps);

    const res = await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.owner.token, { businessDate: "2026-12-01" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as NightAuditSummaryBody;

    expect(body.yaCompletado).toBe(false);
    expect(body.cargosPosteados).toHaveLength(1);
    expect(body.cargosPosteados[0]).toMatchObject({ reservationId: reservation.id, folioId: folio.id, amount: 1500 });
    expect(body.conciliacionAB).toEqual({ estado: "sin_pos_configurado" });
    expect(body.anomalias).toEqual([]);
  });

  it("una segunda corrida de la MISMA fecha devuelve el resumen ya guardado, sin duplicar el cargo", async () => {
    await seedInHouseReservation(ctx, "2026-12-01", "2026-12-03");
    const app = buildApp(ctx.deps);

    const first = await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.owner.token, { businessDate: "2026-12-01" }));
    const firstBody = (await first.json()) as NightAuditSummaryBody;
    const second = await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.accountant.token, { businessDate: "2026-12-01" }));
    const secondBody = (await second.json()) as NightAuditSummaryBody;

    expect(firstBody.cargosPosteados).toHaveLength(1);
    expect(secondBody.yaCompletado).toBe(true);
    expect(secondBody.cargosPosteados).toEqual(firstBody.cargosPosteados);
  });

  it("verificación de folio-cero: una reserva en casa sin folio se reporta como anomalía, nunca inventa el cargo", async () => {
    const reservation = await ctx.hotelesRepo.insertReservation({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      roomTypeId: ctx.roomTypeId,
      guestId: null,
      checkInDate: "2026-12-02",
      checkOutDate: "2026-12-03",
      totalAmount: 1500,
    });
    await ctx.hotelesRepo.transitionReservation(ctx.propertyId, reservation.id, ["confirmada"], "check_in", null);
    await ctx.hotelesRepo.transitionReservation(ctx.propertyId, reservation.id, ["check_in"], "en_estancia", null);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.owner.token, { businessDate: "2026-12-02" }));
    const body = (await res.json()) as NightAuditSummaryBody;

    expect(body.cargosPosteados).toEqual([]);
    expect(body.anomalias).toHaveLength(1);
    expect(body.anomalias[0]).toMatchObject({ reservationId: reservation.id, type: "folio_cero" });
  });

  it("rechaza un businessDate mal formado", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.owner.token, { businessDate: "01-12-2026" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /hoteles/:propertyId/night-audit[...] -- consulta", () => {
  it("404 si no hay corrida todavía para esa fecha", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/night-audit/2026-12-01`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(404);
  });

  it("devuelve el estado/resumen de una corrida ya hecha, y aparece en el historial", async () => {
    await seedInHouseReservation(ctx, "2026-12-01", "2026-12-03");
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.owner.token, { businessDate: "2026-12-01" }));

    const consulta = await app.request(`/hoteles/${ctx.propertyId}/night-audit/2026-12-01`, authedJson(ctx.staff.owner.token));
    expect(consulta.status).toBe(200);
    const consultaBody = (await consulta.json()) as { estado: string; completadoEn: string | null };
    expect(consultaBody.estado).toBe("completado");
    expect(consultaBody.completadoEn).not.toBeNull();

    const historial = await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.owner.token));
    expect(historial.status).toBe(200);
    const historialBody = (await historial.json()) as { fecha: string; estado: string }[];
    expect(historialBody.some((r) => r.fecha === "2026-12-01" && r.estado === "completado")).toBe(true);
  });

  it("rechaza un rol sin acceso (frontdesk no está en NIGHT_AUDIT_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(403);
  });
});
