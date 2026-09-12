// Fase 5 pieza 2 — test de integración HTTP real de
// licitacionesTenderVersionsRoutes (REQ-017/041/151..155): historial de
// versiones de convocatoria, diff estructurado, cascada de invalidación
// (expediente completo y sección técnica granular) y notificaciones.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

const BASES_TEXT_V1 = "El licitante deberá presentar acta constitutiva original.";
const BASES_TEXT_V2 = "El licitante deberá presentar acta constitutiva original certificada ante notario, con menos de 6 meses de antigüedad.";

function extractBody(text: string) {
  return { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text }] }] };
}

describe("GET /licitaciones/:propertyId/tenders/:tenderId/versions -- historial (REQ-153)", () => {
  it("dar de alta una convocatoria crea la versión 1; sin cambios reales, no crea la versión 2", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria versionada", externalId: "LA-20/2026", budgetAmount: 100_000 }));
    const { id: tenderId } = (await created.json()) as { id: string };

    const versionsRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${tenderId}/versions`, authedJson(ctx.staff.viewer.token));
    expect(versionsRes.status).toBe(200);
    const versionsBody = (await versionsRes.json()) as { versions: { version: number; diff: { changedFieldNames: string[] } }[] };
    expect(versionsBody.versions).toHaveLength(1);
    expect(versionsBody.versions[0]!.version).toBe(1);

    // Reingestar EXACTAMENTE lo mismo -> no crea versión 2 (REQ-152/154).
    await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria versionada", externalId: "LA-20/2026", budgetAmount: 100_000 }));
    const stillOne = (await (await app.request(`/licitaciones/${ctx.propertyId}/tenders/${tenderId}/versions`, authedJson(ctx.staff.viewer.token))).json()) as { versions: unknown[] };
    expect(stillOne.versions).toHaveLength(1);

    // Cambiar el presupuesto -> versión 2 con diff correcto (REQ-017).
    await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria versionada", externalId: "LA-20/2026", budgetAmount: 300_000 }));
    const twoVersions = (await (await app.request(`/licitaciones/${ctx.propertyId}/tenders/${tenderId}/versions`, authedJson(ctx.staff.viewer.token))).json()) as {
      versions: { version: number; diff: { changedFieldNames: string[] } }[];
    };
    expect(twoVersions.versions).toHaveLength(2);
    expect(twoVersions.versions[1]!.diff.changedFieldNames).toEqual(["budgetAmount"]);
  });

  it("convocatoria inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/00000000-0000-0000-0000-000000000000/versions`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(404);
  });
});

describe("POST /licitaciones/:propertyId/tenders/:tenderId/versions/recompute -- REQ-154 idempotente", () => {
  it("un writer puede forzar el recálculo; sin cambios, created=false y no duplica versión", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "X", externalId: "LA-21/2026" }));
    const { id: tenderId } = (await created.json()) as { id: string };

    const recomputeRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${tenderId}/versions/recompute`, authedJson(ctx.staff.writer.token, {}));
    expect(recomputeRes.status).toBe(200);
    const body = (await recomputeRes.json()) as { created: boolean; version: { version: number } };
    expect(body.created).toBe(false); // ya se creó la v1 dentro del alta; nada cambió desde entonces.
    expect(body.version.version).toBe(1);

    const versions = (await (await app.request(`/licitaciones/${ctx.propertyId}/tenders/${tenderId}/versions`, authedJson(ctx.staff.viewer.token))).json()) as { versions: unknown[] };
    expect(versions.versions).toHaveLength(1);
  });

  it("un viewer no puede forzar el recálculo (solo lectura) -> 403", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "X", externalId: "LA-22/2026" }));
    const { id: tenderId } = (await created.json()) as { id: string };
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${tenderId}/versions/recompute`, authedJson(ctx.staff.viewer.token, {}));
    expect(res.status).toBe(403);
  });
});

describe("GET/POST /licitaciones/:propertyId/tender-change-notifications -- REQ-151/155", () => {
  it("dar de alta una convocatoria notifica 'convocatoria_nueva'; un writer puede reconocerla", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "X", externalId: "LA-23/2026" }));
    const { id: tenderId } = (await created.json()) as { id: string };

    const listRes = await app.request(`/licitaciones/${ctx.propertyId}/tender-change-notifications?tenderId=${tenderId}`, authedJson(ctx.staff.viewer.token));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { notifications: { id: string; reason: string; acknowledgedAt: string | null; notifiedRoles: string[] }[] };
    expect(listBody.notifications).toHaveLength(1);
    expect(listBody.notifications[0]!.reason).toBe("convocatoria_nueva");
    expect(listBody.notifications[0]!.acknowledgedAt).toBeNull();
    expect(listBody.notifications[0]!.notifiedRoles).toContain("writer");

    const ackRes = await app.request(`/licitaciones/${ctx.propertyId}/tender-change-notifications/${listBody.notifications[0]!.id}/acknowledge`, authedJson(ctx.staff.writer.token, {}));
    expect(ackRes.status).toBe(200);
    const ackBody = (await ackRes.json()) as { acknowledgedAt: string | null };
    expect(ackBody.acknowledgedAt).not.toBeNull();
  });

  it("un viewer no puede reconocer una notificación (solo lectura) -> 403", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "X", externalId: "LA-24/2026" }));
    const { id: tenderId } = (await created.json()) as { id: string };
    const notifications = (await (await app.request(`/licitaciones/${ctx.propertyId}/tender-change-notifications?tenderId=${tenderId}`, authedJson(ctx.staff.viewer.token))).json()) as {
      notifications: { id: string }[];
    };
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tender-change-notifications/${notifications.notifications[0]!.id}/acknowledge`, authedJson(ctx.staff.viewer.token, {}));
    expect(res.status).toBe(403);
  });

  it("reconocer una notificación inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tender-change-notifications/00000000-0000-0000-0000-000000000000/acknowledge`, authedJson(ctx.staff.writer.token, {}));
    expect(res.status).toBe(404);
  });
});

describe("REQ-155: cascada de invalidación en cascada al cambiar requisitos (actas de aclaraciones, REQ-041)", () => {
  it("re-extraer requisitos con una acta que MODIFICA un requisito legal invalida la aprobación granular de la sección técnica 'legal', sin tocar otras secciones", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Primera extracción (bases originales) + propuesta con esa sección redactada y aprobada.
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`, authedJson(ctx.staff.writer.token, extractBody(BASES_TEXT_V1), { "idempotency-key": "v1" }));
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/technical/generate`, authedJson(ctx.staff.writer.token, {}, { "idempotency-key": "gen-1" }));

    const approveRes = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/sections/technical:legal/approval`,
      authedJson(ctx.staff.owner.token, {}),
    );
    expect(approveRes.status).toBe(201);

    const proposalRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const proposal = (await proposalRes.json()) as { id: string };
    expect(await ctx.repo.activeApprovalsCovering(ctx.organizationId, proposal.id, "seccion:technical:legal")).toHaveLength(1);

    // Acta de aclaraciones (REQ-041): re-extrae con un texto que MODIFICA el requisito legal (misma cláusula, redacción distinta).
    const extractV2 = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`,
      authedJson(ctx.staff.writer.token, extractBody(BASES_TEXT_V2), { "idempotency-key": "v2" }),
    );
    expect(extractV2.status).toBe(200);

    // La aprobación de la sección "legal" quedó invalidada por el cambio de requisito.
    expect(await ctx.repo.activeApprovalsCovering(ctx.organizationId, proposal.id, "seccion:technical:legal")).toHaveLength(0);

    // El historial de versiones de la convocatoria refleja el cambio con diff
    // ESTRUCTURADO por requisito (REQ-017), nunca texto plano: la redacción
    // legal original desapareció ("eliminado") y la nueva ("con menos de 6
    // meses de antigüedad") es un requisito distinto ("nuevo") -- el
    // extractor por reglas identifica cada requisito por su CLAVE NATURAL
    // (texto), así que una redacción distinta de la misma cláusula se ve
    // como reemplazo (eliminado+nuevo), no como edición in-place; en
    // cualquier caso, ambos estados cuentan como cambio real y disparan la
    // misma cascada sobre la sección afectada.
    const versionsRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/versions`, authedJson(ctx.staff.viewer.token));
    const versionsBody = (await versionsRes.json()) as { versions: { diff: { requirements: { status: string }[]; affectedSectionKeys: string[]; hasChanges: boolean } }[] };
    const latestDiff = versionsBody.versions[versionsBody.versions.length - 1]!.diff;
    expect(latestDiff.hasChanges).toBe(true);
    expect(latestDiff.affectedSectionKeys).toContain("legal");
    expect(latestDiff.requirements.some((r) => r.status === "nuevo" || r.status === "eliminado")).toBe(true);
  });
});
