// Test de integración HTTP real de Fase 3 pieza 3 (§7): decisiones Go/No-Go.
// Reproduce el ataque de rol (writer intenta decidir -> 403) y verifica que
// el estado de la convocatoria y el historial completo se comportan como
// especifica el diseño.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

describe("POST /licitaciones/:propertyId/tenders/:tenderId/go-no-go (§7)", () => {
  it("owner/analyst/reviewer pueden decidir; writer/viewer NUNCA (GO_NO_GO_ROLES = DECISION_ROLES + reviewer)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const writerRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.writer.token, { decision: "go", reasons: ["Encaja con nuestro giro."] }));
    expect(writerRes.status).toBe(403);

    const viewerRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.viewer.token, { decision: "go", reasons: ["Encaja con nuestro giro."] }));
    expect(viewerRes.status).toBe(403);

    const reviewerRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.reviewer.token, { decision: "go", reasons: ["Encaja con nuestro giro."] }));
    expect(reviewerRes.status).toBe(201);
  });

  it("motivo vacío -> 400 de validación, ninguna decisión se persiste", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "go", reasons: [] }));
    expect(res.status).toBe(400);

    const history = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token));
    const historyBody = (await history.json()) as { decisions: unknown[] };
    expect(historyBody.decisions).toHaveLength(0);
  });

  it("decision inválida (ni 'go' ni 'no_go') -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "tal-vez", reasons: ["x"] }));
    expect(res.status).toBe(400);
  });

  it("convocatoria inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/00000000-0000-0000-0000-000000000000/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "go", reasons: ["x"] }));
    expect(res.status).toBe(404);
  });

  it("una decisión 'no_go' registra match_score/eligibility en vivo, sella un matchInputsHash, y escribe tender.status='no_go'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/matching-profile`, { method: "PUT", headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" }, body: JSON.stringify({ budgetMin: 10_000_000, budgetMax: 20_000_000 }) });

    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.analyst.token, { decision: "no_go", reasons: ["Fuera de nuestro rango de presupuesto operable."] }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { decision: string; matchScore: number; matchEligibilityStatus: string; matchInputsHash: string; decidedBy: string };
    expect(body.decision).toBe("no_go");
    expect(typeof body.matchScore).toBe("number");
    expect(body.matchEligibilityStatus).toBe("no_evaluable"); // el tender de fixture no trae budgetAmount -> no evaluable, nunca "cumple" inventado.
    expect(body.matchInputsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.decidedBy).toBe(ctx.staff.analyst.id);

    const tender = await ctx.repo.findTender(ctx.organizationId, ctx.tenderId);
    expect(tender!.status).toBe("no_go"); // único camino que saca la convocatoria de discovered/in_review.
  });

  it("historial COMPLETO: un 'no_go' puede reabrirse con un 'go' posterior sin perder el rastro anterior", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const first = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "no_go", reasons: ["Condiciones iniciales desfavorables."] }));
    expect(first.status).toBe(201);

    const tenderAfterFirst = await ctx.repo.findTender(ctx.organizationId, ctx.tenderId);
    expect(tenderAfterFirst!.status).toBe("no_go");

    const second = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.analyst.token, { decision: "go", reasons: ["Cambiaron las condiciones: ahora sí es viable."] }));
    expect(second.status).toBe(201);

    const tenderAfterSecond = await ctx.repo.findTender(ctx.organizationId, ctx.tenderId);
    expect(tenderAfterSecond!.status).toBe("go");

    const historyRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.viewer.token));
    expect(historyRes.status).toBe(200); // leer el historial es abierto a cualquier miembro.
    const history = (await historyRes.json()) as { decisions: { decision: string }[] };
    expect(history.decisions).toHaveLength(2); // ambas decisiones se conservan, nunca se sobreescribe la anterior.
    expect(history.decisions[0]!.decision).toBe("go"); // más reciente primero.
    expect(history.decisions[1]!.decision).toBe("no_go");
  });

  it("un writer/viewer pueden LEER el historial aunque no puedan decidir (decidir es privilegiado, ver la decisión no)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.owner.token, { decision: "go", reasons: ["x"] }));

    const writerRead = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.writer.token));
    expect(writerRead.status).toBe(200);
    const viewerRead = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/go-no-go`, authedJson(ctx.staff.viewer.token));
    expect(viewerRead.status).toBe(200);
  });
});
