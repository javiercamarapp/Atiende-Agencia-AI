// Test de integración end-to-end (HTTP real vía app.request, sin mockear el
// motor de dominio) del Flujo 3 de licitaciones — el de mayor riesgo real del
// repo origen (AE-14): un badge "ready" mentiroso puede llevar a que un
// humano presente ante un ente público un expediente incompleto. Ejercita la
// cadena completa: checklist -> propuesta económica -> aprobación de
// expediente -> ensamblado -> descarga, y el guardia AE-14 (un "ready"
// guardado se invalida cuando cambia una tarifa realmente usada).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

const GREEN_CHECKLIST_BODY = {
  files: [{ filename: "carta.pdf", extension: "pdf", sizeBytes: 1000 }],
  formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 20 },
  requiredSignatures: [],
  presentAnnexRefs: [],
};

async function runFullReadyFlow(ctx: Awaited<ReturnType<typeof buildLicitacionesTestContext>>, app: ReturnType<typeof buildApp>) {
  ctx.repo.seedApprovedRates(ctx.organizationId, [{ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);

  const economicRes = await app.request(
    `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`,
    authedJson(ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 10 }] }, { "idempotency-key": "econ-1" }),
  );
  expect(economicRes.status).toBe(200);
  const economicBody = (await economicRes.json()) as { economic: { totals: { total: string } | null } };
  expect(economicBody.economic.totals).not.toBeNull();

  const checklistRes = await app.request(
    `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`,
    authedJson(ctx.staff.writer.token, GREEN_CHECKLIST_BODY, { "idempotency-key": "checklist-1" }),
  );
  expect(checklistRes.status).toBe(200);
  const checklistBody = (await checklistRes.json()) as { overallStatus: string };
  expect(checklistBody.overallStatus).toBe("verde");

  const approvalRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/expediente/approval`, authedJson(ctx.staff.analyst.token, {}));
  expect(approvalRes.status).toBe(201);

  const assembleRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/assemble`, authedJson(ctx.staff.writer.token, {}, { "idempotency-key": "assemble-1" }));
  expect(assembleRes.status).toBe(200);
  const assembleBody = (await assembleRes.json()) as { status: string; draftReasons: string[] };
  return assembleBody;
}

describe("Flujo 3 -- ensamblado 'ready' exige checklist verde + aprobación vigente + sin faltantes", () => {
  it("camino feliz completo: checklist verde -> económico calculado -> aprobación -> assemble 'ready' -> download real", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const assembleBody = await runFullReadyFlow(ctx, app);
    expect(assembleBody.status).toBe("ready");
    expect(assembleBody.draftReasons).toEqual([]);

    const latestRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/latest`, authedJson(ctx.staff.viewer.token));
    expect(latestRes.status).toBe(200);
    expect((await latestRes.json())).toMatchObject({ status: "ready" });

    const downloadRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/download`, authedJson(ctx.staff.viewer.token));
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await downloadRes.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    // Firma de ZIP real (PK\x03\x04) -- no un placeholder de texto plano.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("sin aprobación de expediente -> assemble queda 'draft' con motivo explícito, nunca 'ready' por defecto", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.repo.seedApprovedRates(ctx.organizationId, [{ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);

    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`, authedJson(ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 10 }] }, { "idempotency-key": "econ-1" }));
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`, authedJson(ctx.staff.writer.token, GREEN_CHECKLIST_BODY, { "idempotency-key": "checklist-1" }));

    const assembleRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/assemble`, authedJson(ctx.staff.writer.token, {}, { "idempotency-key": "assemble-1" }));
    const body = (await assembleRes.json()) as { status: string; draftReasons: string[] };
    expect(body.status).toBe("draft");
    expect(body.draftReasons).toContain("sin_aprobacion_vigente_de_alcance_expediente");
  });

  it("AE-14: un paquete 'ready' guardado se re-deriva a 'draft' si cambia una tarifa REALMENTE usada después de aprobar -- latest y download nunca mienten", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const readyBody = await runFullReadyFlow(ctx, app);
    expect(readyBody.status).toBe("ready");

    // Cambia la tarifa realmente usada por la propuesta DESPUÉS de aprobar
    // (p. ej. se corrigió un precio) -- el hash de insumos actual ya no
    // coincide con el que la aprobación registró.
    ctx.repo.seedApprovedRates(ctx.organizationId, [{ id: "r1", concept: "consultoria_hora", unitPrice: "999.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);

    const latestRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/latest`, authedJson(ctx.staff.viewer.token));
    expect(latestRes.status).toBe(200);
    const latestBody = (await latestRes.json()) as { status: string; draftReasons: string[] };
    // Nunca se sirve el "ready" guardado a secas: se re-deriva contra el
    // estado vivo y ahora refleja 'draft'.
    expect(latestBody.status).toBe("draft");
    expect(latestBody.draftReasons.some((r) => r.startsWith("aprobacion_vigente_con_hash_insumos_divergente"))).toBe(true);

    const downloadRes = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/download`, authedJson(ctx.staff.viewer.token));
    expect(downloadRes.status).toBe(409);
    const downloadBody = (await downloadRes.json()) as { code: string; draftReasons: string[] };
    expect(downloadBody.code).toBe("conflict");
    expect(downloadBody.draftReasons.length).toBeGreaterThan(0);

    // Re-aprobar con el hash ACTUAL y volver a ensamblar restaura 'ready'.
    const reApprove = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/expediente/approval`, authedJson(ctx.staff.owner.token, {}));
    expect(reApprove.status).toBe(201);
    const reAssemble = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/assemble`, authedJson(ctx.staff.writer.token, {}, { "idempotency-key": "assemble-2" }));
    expect((await reAssemble.json())).toMatchObject({ status: "ready" });

    const downloadAgain = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/download`, authedJson(ctx.staff.viewer.token));
    expect(downloadAgain.status).toBe(200);
  });

  it("un rol de escritura (writer/reviewer) NO puede aprobar el expediente -- solo DECISION_ROLES (owner/admin/analyst)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/expediente/approval`, authedJson(ctx.staff.writer.token, {}));
    expect(res.status).toBe(403);
  });

  it("un viewer no puede ensamblar el paquete (solo lectura)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/assemble`, authedJson(ctx.staff.viewer.token, {}, { "idempotency-key": "x" }));
    expect(res.status).toBe(403);
  });

  it("exige Idempotency-Key en package/assemble", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/package/assemble`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(400);
    expect((await res.json())).toMatchObject({ code: "idempotency_required" });
  });
});

describe("submission/declare -- REQ-LIC-011: autodeclaración simple, sin bloqueo por fecha ni envío externo", () => {
  it("declarar sin propuesta creada -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/submission/declare`,
      authedJson(ctx.staff.writer.token, { submittedAt: "2026-12-14T10:00:00-06:00" }, { "idempotency-key": "sub-1" }),
    );
    expect(res.status).toBe(404);
  });

  it("GET submission antes de declarar devuelve null; después de declarar devuelve el registro", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));

    const before = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/submission`, authedJson(ctx.staff.viewer.token));
    expect(await before.json()).toBeNull();

    const declareRes = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/submission/declare`,
      authedJson(ctx.staff.writer.token, { submittedAt: "2026-12-20T10:00:00-06:00", notes: "Presentado en ventanilla física, ya vencido el plazo -- se declara igual (no hay bloqueo por fecha, REQ-LIC-011)." }, { "idempotency-key": "sub-2" }),
    );
    expect(declareRes.status).toBe(201);
    const declared = (await declareRes.json()) as { status: string; submittedAt: string };
    expect(declared.status).toBe("submitted");
    // REQ-LIC: un envío "tarde" (posterior al submissionDeadline sembrado,
    // 2026-12-15) igual se declara -- deliberadamente NO se inventa un
    // bloqueo por fecha que el origen no tiene.
    expect(declared.submittedAt).toBe("2026-12-20T10:00:00-06:00");

    const after = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/submission`, authedJson(ctx.staff.viewer.token));
    expect((await after.json())).toMatchObject({ status: "submitted" });
  });

  it("exige Idempotency-Key", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/submission/declare`, authedJson(ctx.staff.writer.token, { submittedAt: "2026-12-20T10:00:00-06:00" }));
    expect(res.status).toBe(400);
  });

  it("un viewer no puede declarar la presentación", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/submission/declare`, authedJson(ctx.staff.viewer.token, { submittedAt: "2026-12-20T10:00:00-06:00" }, { "idempotency-key": "x" }));
    expect(res.status).toBe(403);
  });
});
