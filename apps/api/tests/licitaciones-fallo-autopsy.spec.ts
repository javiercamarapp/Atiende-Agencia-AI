// Fase 6 pieza 4 (REQ-054) -- test de integración HTTP real de la autopsia
// del fallo y las lecciones aprendidas vinculadas al perfil de empresa
// (org-wide). REQ-054 explícito: campos ausentes -> "no disponible", nunca
// inventados.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

describe("Fase 6 pieza 4 (REQ-054) -- autopsia del fallo + lecciones aprendidas", () => {
  it("viewer no puede registrar una autopsia (403); writer sí, y campos no capturados quedan 'no disponible'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const forbidden = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/fallo-autopsy`,
      authedJson(ctx.staff.viewer.token, { ownProposalStatus: "desechada" }),
    );
    expect(forbidden.status).toBe(403);

    const created = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/fallo-autopsy`,
      authedJson(ctx.staff.writer.token, { ownProposalStatus: "desechada", lessons: ["Reforzar la sección de experiencia previa."] }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { ownProposalStatus: string; disqualificationReason: string; winnerName: string; lessons: { lessonText: string }[] };
    expect(body.ownProposalStatus).toBe("desechada");
    expect(body.disqualificationReason).toBe("no disponible");
    expect(body.winnerName).toBe("no disponible");
    expect(body.lessons).toHaveLength(1);
  });

  it("con datos completos, ningún campo se normaliza a 'no disponible'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/fallo-autopsy`,
      authedJson(ctx.staff.writer.token, {
        ownProposalStatus: "desechada",
        disqualificationReason: "No se acreditó la vigencia de la garantía de sostenimiento de la oferta.",
        winnerName: "Proveedor Ganador S.A. de C.V.",
        ownScore: 78.5,
        winnerScore: 91.2,
        ownPrice: 950000,
        winnerPrice: 910000,
        criteriaComparison: [{ criterio: "Experiencia", propio: "8/10", ganador: "9/10" }],
        lessons: ["Verificar vigencias de garantías antes de presentar."],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { disqualificationReason: string; winnerName: string; criteriaComparison: unknown[] };
    expect(body.disqualificationReason).not.toBe("no disponible");
    expect(body.winnerName).toBe("Proveedor Ganador S.A. de C.V.");
    expect(body.criteriaComparison).toHaveLength(1);
  });

  it("ownProposalStatus inválido -> 400; convocatoria inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const invalid = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/fallo-autopsy`, authedJson(ctx.staff.writer.token, { ownProposalStatus: "perdida" }));
    expect(invalid.status).toBe(400);

    const notFound = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/00000000-0000-0000-0000-000000000000/fallo-autopsy`,
      authedJson(ctx.staff.writer.token, { ownProposalStatus: "desechada" }),
    );
    expect(notFound.status).toBe(404);
  });

  it("historial completo por convocatoria, y lecciones consultables org-wide (sin filtrar por tender)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/fallo-autopsy`,
      authedJson(ctx.staff.writer.token, { ownProposalStatus: "desechada", lessons: ["Lección A"] }),
    );
    await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/fallo-autopsy`,
      authedJson(ctx.staff.writer.token, { ownProposalStatus: "no_presentada", lessons: ["Lección B"] }),
    );

    const list = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/fallo-autopsy`, authedJson(ctx.staff.viewer.token));
    expect(((await list.json()) as { autopsies: unknown[] }).autopsies).toHaveLength(2);

    const lessons = await app.request(`/licitaciones/${ctx.propertyId}/lessons-learned`, authedJson(ctx.staff.viewer.token));
    expect(lessons.status).toBe(200);
    const lessonsBody = (await lessons.json()) as { lessons: { lessonText: string }[] };
    expect(lessonsBody.lessons.map((l) => l.lessonText).sort()).toEqual(["Lección A", "Lección B"]);
  });
});
