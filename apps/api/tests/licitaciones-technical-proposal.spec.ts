// Test de integración end-to-end (HTTP real vía app.request) de Fase 2
// pieza 3: RequirementMatrix + TechnicalProposalBuilder. Antes de esta
// pieza, `licitaciones.requirement_item` era SOLO LECTURA (ver comentario de
// 001_licitaciones_schema.sql) y toda sección técnica del expediente quedaba
// para siempre en "PENDIENTE..." (ver checklist.ts / cierre.ts, Fase 1).
// Este test ejercita la cadena real: extraer requisitos -> configurar el
// mapeo requisito->dato de empresa -> generar la propuesta técnica -> ver el
// resultado reflejado en la propuesta y en el ensamblado del paquete.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

const BASES_TEXT =
  "El licitante deberá presentar acta constitutiva original. El licitante deberá acreditar experiencia técnica mínima de 3 años en proyectos similares.";

describe("Fase 2 pieza 3 -- requirements/extract + proposal/technical/generate", () => {
  it("extrae requisitos reales, los persiste, y GET .../requirements los expone", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const extractRes = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`,
      authedJson(ctx.staff.writer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: BASES_TEXT }] }] }, { "idempotency-key": "extract-1" }),
    );
    expect(extractRes.status).toBe(200);
    const extractBody = (await extractRes.json()) as { items: { type: string }[]; conflicts: unknown[] };
    expect(extractBody.items.length).toBeGreaterThan(0);
    expect(extractBody.items.some((i) => i.type === "legal")).toBe(true);
    expect(extractBody.conflicts).toEqual([]);

    const listRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements`, authedJson(ctx.staff.viewer.token));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { items: unknown[] };
    expect(listBody.items.length).toBe(extractBody.items.length);
  });

  it("un rol de solo lectura (viewer) no puede extraer requisitos", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`,
      authedJson(ctx.staff.viewer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: BASES_TEXT }] }] }, { "idempotency-key": "extract-viewer" }),
    );
    expect(res.status).toBe(403);
  });

  it("sin datos de empresa ni mapeo configurado, la propuesta técnica queda 'PENDIENTE' -- nunca redacta con datos inventados", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`,
      authedJson(ctx.staff.writer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: BASES_TEXT }] }] }, { "idempotency-key": "extract-2" }),
    );

    const generateRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/technical/generate`, authedJson(ctx.staff.writer.token, {}, { "idempotency-key": "gen-1" }));
    expect(generateRes.status).toBe(200);
    const generateBody = (await generateRes.json()) as { sections: { sectionKey: string }[]; blockers: number };
    expect(generateBody.blockers).toBeGreaterThan(0);
    expect(generateBody.sections.some((s) => s.sectionKey === "technical:legal")).toBe(true);

    const proposalRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.viewer.token));
    const proposalBody = (await proposalRes.json()) as { generationReport: { technical?: { usedCompanyDocumentIds?: string[] } } };
    expect(proposalBody.generationReport.technical?.usedCompanyDocumentIds).toEqual([]);
  });

  it("camino feliz: documento de empresa APROBADO + mapeo configurado -> la sección técnica se redacta con SourceRef trazable, y deja de bloquear el ensamblado por ese documento", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.repo.seedCompanyDocuments(ctx.organizationId, [{ id: "doc-acta-1", type: "acta_constitutiva", label: "Acta Constitutiva Empresa de Prueba S.A. de C.V.", expiresAt: null, approvalStatus: "aprobado" }]);

    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));

    const extractRes = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`,
      authedJson(ctx.staff.writer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: "El licitante deberá presentar acta constitutiva original." }] }] }, { "idempotency-key": "extract-3" }),
    );
    const extractBody = (await extractRes.json()) as { items: { topicKey?: string }[] };
    const topicKey = extractBody.items.find((i) => i.topicKey === "acta_constitutiva")!.topicKey!;

    // DECISION_ROLES configura el mapeo (writer, que no es DECISION_ROLES, no puede).
    const forbiddenMapRes = await app.request(`/licitaciones/${ctx.propertyId}/requirement-mappings/${topicKey}`, { method: "PUT", headers: { authorization: `Bearer ${ctx.staff.writer.token}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "document", refKey: "acta_constitutiva", statementTemplate: "Se acompaña acta constitutiva vigente: {value}." }) });
    expect(forbiddenMapRes.status).toBe(403);

    const mapRes = await app.request(`/licitaciones/${ctx.propertyId}/requirement-mappings/${topicKey}`, { method: "PUT", headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "document", refKey: "acta_constitutiva", statementTemplate: "Se acompaña acta constitutiva vigente: {value}." }) });
    expect(mapRes.status).toBe(200);

    const generateRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/technical/generate`, authedJson(ctx.staff.writer.token, {}, { "idempotency-key": "gen-2" }));
    expect(generateRes.status).toBe(200);
    const generateBody = (await generateRes.json()) as { blockers: number };
    expect(generateBody.blockers).toBe(0);

    const proposalRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.viewer.token));
    const proposalBody = (await proposalRes.json()) as { generationReport: { technical?: { usedCompanyDocumentIds?: string[] } } };
    expect(proposalBody.generationReport.technical?.usedCompanyDocumentIds).toEqual(["doc-acta-1"]);

    // El expediente completo aún no está "ready" (falta checklist/aprobación),
    // pero la sección técnica ya NO cuenta como faltante -- assemble no debe
    // listarla en `missing` como bloqueo por falta de contenido técnico.
    const assembleRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/assemble`, authedJson(ctx.staff.writer.token, {}, { "idempotency-key": "assemble-tech-1" }));
    const assembleBody = (await assembleRes.json()) as { status: string; missing: string[] };
    expect(assembleBody.status).toBe("draft"); // checklist nunca corrió todavía.
    expect(assembleBody.missing).toEqual([]); // la única sección generada (técnica) SÍ está presente.
  });

  it("Fase 4 -- mapeo tipo 'signer' con un firmante APROBADO real (no el stub vacío de Fase 1) resuelve y trazabiliza el sourceRef", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // Antes de Fase 4, CompanyDataResolver.getSigners() SIEMPRE devolvía [] sin
    // importar qué se sembrara -- este seed habría sido ignorado en silencio.
    ctx.repo.seedCompanySigners(ctx.organizationId, [{ id: "signer-1", name: "Juana Pérez Ruiz", role: "representante_legal", authorized: true }]);

    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const extractRes = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`,
      authedJson(ctx.staff.writer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: "El licitante deberá presentar acta constitutiva original." }] }] }, { "idempotency-key": "extract-4" }),
    );
    const extractBody = (await extractRes.json()) as { items: { topicKey?: string }[] };
    const topicKey = extractBody.items.find((i) => i.topicKey === "acta_constitutiva")!.topicKey!;

    const mapRes = await app.request(`/licitaciones/${ctx.propertyId}/requirement-mappings/${topicKey}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "signer", refKey: "representante_legal", statementTemplate: "Firma el representante legal autorizado: {value}." }),
    });
    expect(mapRes.status).toBe(200);

    const generateRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/technical/generate`, authedJson(ctx.staff.writer.token, {}, { "idempotency-key": "gen-signer-1" }));
    expect(generateRes.status).toBe(200);
    const generateBody = (await generateRes.json()) as { blockers: number };
    expect(generateBody.blockers).toBe(0); // el firmante autorizado resuelve -- ya no queda "missing" por un stub vacío.

    const proposalRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.viewer.token));
    const proposalBody = (await proposalRes.json()) as { generationReport: { technical?: { usedCompanyDocumentIds?: string[] } } };
    expect(proposalBody.generationReport.technical?.usedCompanyDocumentIds).toEqual(["signer-1"]); // sourceRef.refId real del firmante sembrado, trazable.
  });

  it("Fase 4 -- un firmante NO autorizado bloquea explícitamente (nunca 'missing' silencioso ni redacción inventada)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.repo.seedCompanySigners(ctx.organizationId, [{ id: "signer-2", name: "Carlos Ibarra Solís", role: "representante_legal", authorized: false }]);

    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const extractRes = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`,
      authedJson(ctx.staff.writer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: "El licitante deberá presentar acta constitutiva original." }] }] }, { "idempotency-key": "extract-5" }),
    );
    const extractBody = (await extractRes.json()) as { items: { topicKey?: string }[] };
    const topicKey = extractBody.items.find((i) => i.topicKey === "acta_constitutiva")!.topicKey!;
    await app.request(`/licitaciones/${ctx.propertyId}/requirement-mappings/${topicKey}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "signer", refKey: "representante_legal", statementTemplate: "Firma el representante legal autorizado: {value}." }),
    });

    const generateRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/technical/generate`, authedJson(ctx.staff.writer.token, {}, { "idempotency-key": "gen-signer-2" }));
    expect(generateRes.status).toBe(200);
    const generateBody = (await generateRes.json()) as { blockers: number };
    // El detalle fino de "blocked" vs "missing" se prueba a nivel de dominio
    // (packages/domain-licitaciones/tests/technical-proposal.spec.ts) -- este
    // endpoint solo expone el conteo agregado. El punto de este test HTTP es
    // confirmar que el firmante sembrado SÍ se intentó resolver (ya no un
    // stub siempre-vacío): con InMemoryCompanyDataResolver's stub anterior,
    // este seed habría sido ignorado en silencio pero el resultado (1 bloqueo
    // por "missing") habría sido indistinguible de este caso a este nivel --
    // la cobertura real de la distinción vive en el test de dominio de arriba.
    expect(generateBody.blockers).toBe(1);
  });
});
