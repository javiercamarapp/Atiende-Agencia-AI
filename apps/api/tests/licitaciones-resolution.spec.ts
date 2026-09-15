// Fase 16 (post-adjudicación, pieza 0) -- test de integración HTTP real de la
// resolución won/lost de una convocatoria. Hasta esta pieza,
// `licitaciones.tender.status` no tenía NINGÚN endpoint que lo llevara a
// "won"/"lost" -- todo el flujo de post-adjudicación (Contrato.tsx,
// PostAdjudicacion.tsx) y de autopsia del fallo (Autopsia.tsx) dependía de
// un estado inalcanzable de punta a punta.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

describe("POST/GET /licitaciones/:propertyId/tenders/:tenderId/resolution (Fase 16)", () => {
  it("no se puede marcar ganada/perdida sin pasar antes por una decisión 'go' real -- 409, tender.status sin cambiar", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // El tender de fixture arranca en "discovered" (ninguna decisión go/no-go
    // registrada todavía).
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.owner.token, { resolution: "won", reason: "x" }));
    expect(res.status).toBe(409);

    const tender = await ctx.repo.findTender(ctx.organizationId, ctx.tenderId);
    expect(tender!.status ?? "discovered").toBe("discovered");
  });

  it("camino feliz: go -> marcar ganada -> tender.status='won', historial con 1 registro", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const goRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "go", reasons: ["Encaja con nuestro giro."] }));
    expect(goRes.status).toBe(201);

    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.analyst.token, { resolution: "won", reason: "Fuimos la propuesta técnica y económicamente más solvente." }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("won");

    const tender = await ctx.repo.findTender(ctx.organizationId, ctx.tenderId);
    expect(tender!.status).toBe("won");

    const historyRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.viewer.token));
    expect(historyRes.status).toBe(200); // leer la resolución es abierto a cualquier miembro, decidirla no.
    const history = (await historyRes.json()) as { resolutions: { resolution: string; fromStatus: string; reason: string }[] };
    expect(history.resolutions).toHaveLength(1);
    expect(history.resolutions[0]!.resolution).toBe("won");
    expect(history.resolutions[0]!.fromStatus).toBe("go");
  });

  it("writer/viewer NUNCA pueden marcar ganada/perdida (DECISION_ROLES exacto: owner/admin/analyst, sin reviewer) -- 403", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "go", reasons: ["x"] }));

    const writerRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.writer.token, { resolution: "won", reason: "x" }));
    expect(writerRes.status).toBe(403);

    const reviewerRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.reviewer.token, { resolution: "won", reason: "x" }));
    expect(reviewerRes.status).toBe(403);

    const viewerRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.viewer.token, { resolution: "won", reason: "x" }));
    expect(viewerRes.status).toBe(403);
  });

  it("motivo vacío -> 400 de validación, ninguna resolución se persiste", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "go", reasons: ["x"] }));

    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.owner.token, { resolution: "won", reason: "" }));
    expect(res.status).toBe(400);
  });

  it("resolution inválida (ni 'won' ni 'lost') -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "go", reasons: ["x"] }));

    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.owner.token, { resolution: "adjudicada", reason: "x" }));
    expect(res.status).toBe(400);
  });

  it("una convocatoria ya 'won' no admite una segunda resolución -- 409 (won/lost son terminales)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "go", reasons: ["x"] }));
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.owner.token, { resolution: "won", reason: "Ganamos." }));

    const second = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/resolution`, authedJson(ctx.staff.owner.token, { resolution: "lost", reason: "x" }));
    expect(second.status).toBe(409);
  });

  it("convocatoria inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/00000000-0000-0000-0000-000000000000/resolution`, authedJson(ctx.staff.owner.token, { resolution: "won", reason: "x" }));
    expect(res.status).toBe(404);
  });
});
