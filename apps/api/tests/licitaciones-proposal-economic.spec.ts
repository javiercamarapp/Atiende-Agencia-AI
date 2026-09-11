// Test de integración HTTP real del Flujo 2 -- regla dura A8/REQ-LIC-006: un
// concepto sin tarifa aprobada/vigente bloquea el TOTAL COMPLETO, nunca un
// total parcial silencioso.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

describe("POST /licitaciones/:propertyId/tenders/:tenderId/proposal/economic/generate", () => {
  it("todos los conceptos con tarifa aprobada y vigente -> totales calculados y persistidos", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.repo.seedApprovedRates(ctx.organizationId, [{ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);

    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`,
      authedJson(ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 4 }] }, { "idempotency-key": "e1" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: { economicTotals: { total: string } }; economic: { totals: { total: string; iva: string } } };
    expect(body.economic.totals!.total).toBe("2320.00"); // 4*500=2000 + 16% IVA=320
    expect(body.proposal.economicTotals).toMatchObject({ total: "2320.00" });
  });

  it("un concepto SIN tarifa registrada bloquea el TOTAL COMPLETO -- respuesta 200 con totals=null, nunca un total parcial ni un error genérico", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.repo.seedApprovedRates(ctx.organizationId, [{ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);

    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`,
      authedJson(ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 4 }, { concept: "sin_tarifa", quantity: 1 }] }, { "idempotency-key": "e2" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { economic: { totals: null; blockedLineItems: { concept: string }[] } };
    expect(body.economic.totals).toBeNull();
    expect(body.economic.blockedLineItems).toEqual([{ concept: "sin_tarifa", status: "missing", detail: 'No hay tarifa registrada para "sin_tarifa".' }]);

    // El bloqueo NUNCA persiste un total parcial en la propuesta.
    const proposalRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const proposalBody = (await proposalRes.json()) as { economicTotals: unknown };
    expect(proposalBody.economicTotals).toBeNull();
  });

  it("una convocatoria sin submissionDeadline -> 422, nunca calcula con 'ahora'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: null });
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`,
      authedJson(ctx.staff.writer.token, { lineItems: [{ concept: "x", quantity: 1 }] }, { "idempotency-key": "e3" }),
    );
    expect(res.status).toBe(422);
  });

  it("lineItems vacío -> 400 de validación (nunca un total de $0 fabricado)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`, authedJson(ctx.staff.writer.token, { lineItems: [] }, { "idempotency-key": "e4" }));
    expect(res.status).toBe(400);
  });

  it("un viewer no puede generar la propuesta económica", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`,
      authedJson(ctx.staff.viewer.token, { lineItems: [{ concept: "x", quantity: 1 }] }, { "idempotency-key": "e5" }),
    );
    expect(res.status).toBe(403);
  });

  it("GET /proposal crea la propuesta de forma perezosa (lazy) y es idempotente en llamadas repetidas", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const first = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.viewer.token));
    const second = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.viewer.token));
    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(firstBody.id).toBe(secondBody.id);
  });
});
