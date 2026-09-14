// Fase 6 pieza 2 (REQ-052) -- test de integración HTTP real de la subida +
// extracción determinista del contrato firmado. El cuerpo del request trae
// el texto YA EXTRAÍDO por página (mismo contrato que
// POST .../requirements/extract) -- nunca bytes de un PDF, ver el límite
// documentado en contract-extraction.ts.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

async function createContract(app: ReturnType<typeof buildApp>, propertyId: string, tenderId: string, token: string) {
  const res = await app.request(`/licitaciones/${propertyId}/tenders/${tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(201);
}

describe("Fase 6 pieza 2 (REQ-052) -- documentos y campos extraídos del contrato firmado", () => {
  it("sin contrato registrado -> 404 al subir un documento", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`,
      authedJson(ctx.staff.writer.token, { documentLabel: "Contrato firmado.pdf", pages: [{ page: 1, text: "Contrato número: X-1." }] }),
    );
    expect(res.status).toBe(404);
  });

  it("viewer no puede subir un documento (403); writer sí, y los campos quedan 'sugerido'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);

    const forbidden = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`,
      authedJson(ctx.staff.viewer.token, { documentLabel: "x", pages: [{ page: 1, text: "Contrato número: X-1." }] }),
    );
    expect(forbidden.status).toBe(403);

    const uploaded = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`,
      authedJson(ctx.staff.writer.token, {
        documentLabel: "Contrato firmado.pdf",
        pages: [{ page: 1, text: "Contrato número: SABG-2026-777. Monto total $999,999.00 pesos." }],
      }),
    );
    expect(uploaded.status).toBe(201);
    const body = (await uploaded.json()) as { document: { id: string; pageCount: number }; fields: { fieldKey: string; status: string }[] };
    expect(body.document.pageCount).toBe(1);
    expect(body.fields.length).toBeGreaterThan(0);
    for (const f of body.fields) expect(f.status).toBe("sugerido");

    const listed = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`, authedJson(ctx.staff.viewer.token));
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { documents: unknown[] }).documents).toHaveLength(1);

    const fields = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents/${body.document.id}/fields`, authedJson(ctx.staff.viewer.token));
    expect(fields.status).toBe(200);
  });

  it("documento sin pages -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`, authedJson(ctx.staff.writer.token, { documentLabel: "x", pages: [] }));
    expect(res.status).toBe(400);
  });

  it("confirmar un campo extraído (action=confirm) -- writer puede, viewer no", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const uploaded = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`,
      authedJson(ctx.staff.writer.token, { documentLabel: "Contrato firmado.pdf", pages: [{ page: 1, text: "Contrato número: SABG-2026-777." }] }),
    );
    const uploadedBody = (await uploaded.json()) as { fields: { id: string; fieldKey: string; extractedValue: string }[] };
    const numeroField = uploadedBody.fields.find((f) => f.fieldKey === "numero_contrato")!;

    const forbidden = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/fields/${numeroField.id}/confirm`, authedJson(ctx.staff.viewer.token, { action: "confirm" }));
    expect(forbidden.status).toBe(403);

    const confirmed = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/fields/${numeroField.id}/confirm`, authedJson(ctx.staff.writer.token, { action: "confirm" }));
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as { status: string; confirmedValue: string };
    expect(confirmedBody.status).toBe("confirmado");
    expect(confirmedBody.confirmedValue).toBe(numeroField.extractedValue);
  });

  it("corregir un campo extraído (action=correct) exige correctedValue no vacío", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const uploaded = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`,
      authedJson(ctx.staff.writer.token, { documentLabel: "Contrato firmado.pdf", pages: [{ page: 1, text: "Contrato número: SABG-2026-777." }] }),
    );
    const uploadedBody = (await uploaded.json()) as { fields: { id: string; fieldKey: string }[] };
    const numeroField = uploadedBody.fields.find((f) => f.fieldKey === "numero_contrato")!;

    const missingValue = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/fields/${numeroField.id}/confirm`, authedJson(ctx.staff.writer.token, { action: "correct" }));
    expect(missingValue.status).toBe(400);

    const corrected = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/fields/${numeroField.id}/confirm`,
      authedJson(ctx.staff.writer.token, { action: "correct", correctedValue: "SABG-2026-777-CORREGIDO" }),
    );
    expect(corrected.status).toBe(200);
    const correctedBody = (await corrected.json()) as { status: string; confirmedValue: string };
    expect(correctedBody.status).toBe("corregido");
    expect(correctedBody.confirmedValue).toBe("SABG-2026-777-CORREGIDO");
  });

  it("un texto sin ninguno de los 9 campos reconocidos -- documento se registra, pero sin campos extraídos", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const uploaded = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`,
      authedJson(ctx.staff.writer.token, { documentLabel: "x", pages: [{ page: 1, text: "Texto sin ningún campo reconocible." }] }),
    );
    expect(uploaded.status).toBe(201);
    expect(((await uploaded.json()) as { fields: unknown[] }).fields).toHaveLength(0);
  });
});
