// Test de integración HTTP real del Flujo 1 -- el guardia anti-manipulación
// de fecha (REQ-LIC-001/AE-01) es el hallazgo de seguridad más repetido del
// repo origen: se verifica aquí a nivel de ruta completa, no solo de unidad.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

const GREEN_CHECKLIST_BODY = {
  files: [{ filename: "carta.pdf", extension: "pdf", sizeBytes: 1000 }],
  formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 20 },
  requiredSignatures: [],
  presentAnnexRefs: [],
};

describe("POST /licitaciones/:propertyId/tenders/:tenderId/checklist/run -- REQ-LIC-001/AE-01", () => {
  it("una convocatoria SIN submissionDeadline -> 422 explícito, nunca corre el checklist con 'ahora'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: null });
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));

    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`,
      authedJson(ctx.staff.writer.token, GREEN_CHECKLIST_BODY, { "idempotency-key": "k1" }),
    );
    expect(res.status).toBe(422);
    expect((await res.json())).toMatchObject({ code: "submission_deadline_unknown" });
  });

  it('un asOfIso inyectado en el body es ignorado por completo -- el tipo de la ruta ni siquiera lo declara', async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));

    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`,
      authedJson(ctx.staff.writer.token, { ...GREEN_CHECKLIST_BODY, asOfIso: "1999-01-01T00:00:00Z" }, { "idempotency-key": "k2" }),
    );
    // La convocatoria SÍ tiene submissionDeadline (sembrado por el fixture) ->
    // corre normalmente, el asOfIso inyectado nunca se lee.
    expect(res.status).toBe(200);
  });

  it("sin propuesta generada todavía -> 404 explícito ('genere primero la propuesta')", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`,
      authedJson(ctx.staff.writer.token, GREEN_CHECKLIST_BODY, { "idempotency-key": "k3" }),
    );
    expect(res.status).toBe(404);
  });

  it("un viewer no puede ejecutar el checklist (solo lectura)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`,
      authedJson(ctx.staff.viewer.token, GREEN_CHECKLIST_BODY, { "idempotency-key": "k4" }),
    );
    expect(res.status).toBe(403);
  });

  it("mismo Idempotency-Key + mismo body -> mismo resultado, sin re-ejecutar dos veces", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    const first = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`, authedJson(ctx.staff.writer.token, GREEN_CHECKLIST_BODY, { "idempotency-key": "k5" }));
    const second = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`, authedJson(ctx.staff.writer.token, GREEN_CHECKLIST_BODY, { "idempotency-key": "k5" }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { items: { id: string }[] };
    const secondBody = (await second.json()) as { items: { id: string }[] };
    expect(secondBody.items[0]!.id).toBe(firstBody.items[0]!.id);
  });

  it("el mismo Idempotency-Key con un cuerpo DISTINTO -> 422 idempotency_conflict", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`, authedJson(ctx.staff.writer.token, GREEN_CHECKLIST_BODY, { "idempotency-key": "k6" }));
    const conflicting = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`,
      authedJson(ctx.staff.writer.token, { ...GREEN_CHECKLIST_BODY, presentAnnexRefs: ["algo-distinto"] }, { "idempotency-key": "k6" }),
    );
    expect(conflicting.status).toBe(422);
    expect((await conflicting.json())).toMatchObject({ code: "idempotency_conflict" });
  });
});
