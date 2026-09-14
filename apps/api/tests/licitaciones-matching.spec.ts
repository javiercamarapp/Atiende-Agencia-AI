// Test de integración HTTP real de Fase 3 pieza 1/2: alta manual de
// convocatoria (`POST base/tenders`) y perfil/lectura de matching
// (`GET`/`PUT base/matching-profile`, `GET base/tenders/matching(/:tenderId)`).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

function putJson(token: string, body: unknown): RequestInit {
  return { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("POST /licitaciones/:propertyId/tenders -- alta/actualización manual (§6)", () => {
  it("un writer puede dar de alta una convocatoria manual -> 201, source siempre 'manual' aunque el cliente mande otra cosa", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders`,
      authedJson(ctx.staff.writer.token, { title: "Adquisición de equipo de cómputo", externalId: "LA-01/2026", source: "comprasmx", budgetAmount: 250_000 }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source: string; externalId: string; title: string; status: string };
    expect(body.source).toBe("manual"); // nunca lo que el cliente mandó.
    expect(body.externalId).toBe("LA-01/2026");
    expect(body.status).toBe("discovered");
  });

  it("un viewer NO puede dar de alta convocatorias (solo lectura) -> 403", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.viewer.token, { title: "X" }));
    expect(res.status).toBe(403);
  });

  it("title vacío/ausente -> 400 de validación", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, {}));
    expect(res.status).toBe(400);
  });

  it("reingestar el MISMO externalId -> actualiza (200, no duplica), un externalId distinto -> crea otra fila (201)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const first = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria original", externalId: "LA-02/2026" }));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };

    const second = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria actualizada (cambió fecha)", externalId: "LA-02/2026", submissionDeadline: "2026-11-01T18:00:00-06:00" }));
    expect(second.status).toBe(200); // actualizó, no duplicó.
    const secondBody = (await second.json()) as { id: string; title: string };
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.title).toBe("Convocatoria actualizada (cambió fecha)");

    const listRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/matching`, authedJson(ctx.staff.owner.token));
    const listBody = (await listRes.json()) as { results: { tenderId: string }[] };
    expect(listBody.results.filter((r) => r.tenderId === firstBody.id)).toHaveLength(1); // sigue siendo UNA sola convocatoria.

    const third = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Otra convocatoria distinta", externalId: "LA-03/2026" }));
    expect(third.status).toBe(201);
    const thirdBody = (await third.json()) as { id: string };
    expect(thirdBody.id).not.toBe(firstBody.id);
  });

  it("sin externalId, cada alta SIEMPRE crea una convocatoria nueva (el llamador es responsable de no duplicar a mano)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const first = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria sin folio" }));
    const second = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria sin folio" }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(firstBody.id).not.toBe(secondBody.id);
  });

  it("cambiar submissionDeadline en una actualización invalida la aprobación 'expediente' vigente de la propuesta abierta", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria con propuesta", externalId: "LA-04/2026", submissionDeadline: "2026-12-15T18:00:00-06:00" }));
    const { id: tenderId } = (await created.json()) as { id: string };

    // Genera una propuesta real para esa convocatoria y sella una aprobación "expediente" vigente.
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const approveRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${tenderId}/expediente/approval`, authedJson(ctx.staff.owner.token, {}));
    expect(approveRes.status).toBe(201);

    const proposalRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const proposal = (await proposalRes.json()) as { id: string };
    expect((await ctx.repo.activeApprovalsCovering(ctx.organizationId, proposal.id, "expediente")).length).toBe(1);

    // Alta manual con el MISMO externalId cambia la fecha límite.
    const updated = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria con propuesta", externalId: "LA-04/2026", submissionDeadline: "2027-01-15T18:00:00-06:00" }));
    expect(updated.status).toBe(200);

    const activeAfter = await ctx.repo.activeApprovalsCovering(ctx.organizationId, proposal.id, "expediente");
    expect(activeAfter).toHaveLength(0); // la aprobación vigente quedó invalidada.
  });

  it("un submissionDeadline sin offset horario explícito -> 400 (mismo guardia que el resto del vertical, REQ-LIC-001)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "X", submissionDeadline: "2026-12-01 18:00:00" }));
    expect(res.status).toBe(400);
  });
});

describe("GET/PUT /licitaciones/:propertyId/matching-profile (§5)", () => {
  it("sin configurar todavía -> GET devuelve el perfil 'vacío' explícito, nunca 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/matching-profile`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keywords: string[]; budgetMin: number | null };
    expect(body.keywords).toEqual([]);
    expect(body.budgetMin).toBeNull();
  });

  it("un writer puede configurar el perfil (PUT) -- captura de datos, no decisión de riesgo", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/matching-profile`, putJson(ctx.staff.writer.token, { keywords: ["mantenimiento", "flotilla"], budgetMin: 100_000, budgetMax: 2_000_000 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keywords: string[]; budgetMin: number; updatedBy: string };
    expect(body.keywords).toEqual(["mantenimiento", "flotilla"]);
    expect(body.budgetMin).toBe(100_000);
    expect(body.updatedBy).toBe(ctx.staff.writer.id);
  });

  it("un viewer NO puede configurar el perfil (solo lectura) -> 403", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/matching-profile`, putJson(ctx.staff.viewer.token, { keywords: ["x"] }));
    expect(res.status).toBe(403);
  });

  it("budgetMin > budgetMax -> 400 de validación", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/matching-profile`, putJson(ctx.staff.writer.token, { budgetMin: 1000, budgetMax: 100 }));
    expect(res.status).toBe(400);
  });
});

describe("GET /licitaciones/:propertyId/tenders/(matching|:tenderId/matching) (§4/§8, solo lectura)", () => {
  it("cualquier miembro autenticado (incluido viewer) puede leer el score -- ver el score no es una decisión", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/matching-profile`, putJson(ctx.staff.owner.token, { keywords: ["licitación pública"] }));

    const detailRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/matching`, authedJson(ctx.staff.viewer.token));
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { tenderId: string; score: number; eligibility: { status: string } };
    expect(detail.tenderId).toBe(ctx.tenderId);
    expect(detail.score).toBeGreaterThan(0); // el tender de fixture se titula "Licitación pública de prueba".

    const listRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/matching`, authedJson(ctx.staff.viewer.token));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { results: { tenderId: string }[] };
    expect(list.results.some((r) => r.tenderId === ctx.tenderId)).toBe(true);
  });

  it("convocatoria inexistente -> 404 explícito", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/00000000-0000-0000-0000-000000000000/matching`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(404);
  });
});

describe("GET /licitaciones/:propertyId/tenders(/:tenderId) (Fase 7 — lectura del TenderRecord completo para el panel web)", () => {
  it("lista TODAS las convocatorias de la organización con su título real -- cualquier miembro puede leer", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenders: { id: string; title: string }[] };
    expect(body.tenders.some((t) => t.id === ctx.tenderId && t.title === "Licitación pública de prueba")).toBe(true);
  });

  it("detalle de una convocatoria trae el TenderRecord completo (no solo el score)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string; submissionDeadline: string | null };
    expect(body.id).toBe(ctx.tenderId);
    expect(body.title).toBe("Licitación pública de prueba");
    expect(body.submissionDeadline).toBe("2026-12-15T18:00:00-06:00");
  });

  it("detalle de una convocatoria inexistente -> 404 explícito", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/00000000-0000-0000-0000-000000000000`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(404);
  });

  it("rechaza sin JWT (401)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders`);
    expect(res.status).toBe(401);
  });
});
