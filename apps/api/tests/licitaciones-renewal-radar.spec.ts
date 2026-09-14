// Fase 6 pieza 5 (REQ-055) -- test de integración HTTP real del radar de
// renovaciones: escaneo idempotente, bandeja de alertas, y reconocimiento.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

async function createContractWithEndDate(app: ReturnType<typeof buildApp>, propertyId: string, tenderId: string, ownerToken: string, writerToken: string, endDate: string) {
  await app.request(`/licitaciones/${propertyId}/tenders/${tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}` } });
  const raw = JSON.stringify({ endDate });
  await app.request(`/licitaciones/${propertyId}/tenders/${tenderId}/contract`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${writerToken}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) },
    body: raw,
  });
}

describe("Fase 6 pieza 5 (REQ-055) -- radar de renovaciones", () => {
  it("viewer no puede escanear (403); writer sí -- un contrato con fin próximo genera alertas para los 3 umbrales por defecto", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const today = new Date();
    const endDate = new Date(today.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // faltan 20 días -- cruza 90/60/30.
    await createContractWithEndDate(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token, ctx.staff.writer.token, endDate);

    const forbidden = await app.request(`/licitaciones/${ctx.propertyId}/renewals/scan`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.viewer.token}` } });
    expect(forbidden.status).toBe(403);

    const scan = await app.request(`/licitaciones/${ctx.propertyId}/renewals/scan`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.writer.token}` } });
    expect(scan.status).toBe(200);
    const scanBody = (await scan.json()) as { evaluatedContracts: number; alertsCreated: number };
    expect(scanBody.evaluatedContracts).toBe(1);
    expect(scanBody.alertsCreated).toBe(3);
  });

  it("reescanear no duplica alertas ya emitidas para el mismo umbral (idempotente)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const endDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await createContractWithEndDate(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token, ctx.staff.writer.token, endDate);

    const first = await app.request(`/licitaciones/${ctx.propertyId}/renewals/scan`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.writer.token}` } });
    expect(((await first.json()) as { alertsCreated: number }).alertsCreated).toBe(3);

    const second = await app.request(`/licitaciones/${ctx.propertyId}/renewals/scan`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.writer.token}` } });
    expect(((await second.json()) as { alertsCreated: number }).alertsCreated).toBe(0);

    const alerts = await app.request(`/licitaciones/${ctx.propertyId}/renewals/alerts`, authedJson(ctx.staff.viewer.token));
    expect(((await alerts.json()) as { alerts: unknown[] }).alerts).toHaveLength(3);
  });

  it("un contrato sin endDate declarada no genera ninguna alerta", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });

    const scan = await app.request(`/licitaciones/${ctx.propertyId}/renewals/scan`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.writer.token}` } });
    const body = (await scan.json()) as { evaluatedContracts: number; alertsCreated: number };
    expect(body.evaluatedContracts).toBe(0);
    expect(body.alertsCreated).toBe(0);
  });

  it("reconocer una alerta -- writer puede, y una alerta inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const endDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await createContractWithEndDate(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token, ctx.staff.writer.token, endDate);
    await app.request(`/licitaciones/${ctx.propertyId}/renewals/scan`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.writer.token}` } });

    const alerts = await app.request(`/licitaciones/${ctx.propertyId}/renewals/alerts`, authedJson(ctx.staff.viewer.token));
    const alertId = ((await alerts.json()) as { alerts: { id: string }[] }).alerts[0]!.id;

    const notFound = await app.request(`/licitaciones/${ctx.propertyId}/renewals/alerts/00000000-0000-0000-0000-000000000000/acknowledge`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.writer.token}` },
    });
    expect(notFound.status).toBe(404);

    const acked = await app.request(`/licitaciones/${ctx.propertyId}/renewals/alerts/${alertId}/acknowledge`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.writer.token}` } });
    expect(acked.status).toBe(200);
    expect(((await acked.json()) as { status: string }).status).toBe("reconocida");
  });

  it("leadDaysThresholds personalizado -- solo genera alertas para los umbrales pedidos", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const endDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // faltan 5 días.
    await createContractWithEndDate(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token, ctx.staff.writer.token, endDate);

    const scan = await app.request(`/licitaciones/${ctx.propertyId}/renewals/scan`, authedJson(ctx.staff.writer.token, { leadDaysThresholds: [10] }));
    expect(((await scan.json()) as { alertsCreated: number }).alertsCreated).toBe(1);
  });
});
