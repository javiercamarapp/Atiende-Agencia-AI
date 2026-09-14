// Fase 6 pieza 2 (REQ-052) -- test de integración HTTP real de la subida +
// extracción determinista del contrato firmado. El cuerpo del request admite
// el texto YA EXTRAÍDO por página (mismo contrato original que
// POST .../requirements/extract) O, desde Fase 11, los bytes reales del PDF
// (`contentBase64`) -- ver el describe "Fase 11" al final de este archivo.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

async function createContract(app: ReturnType<typeof buildApp>, propertyId: string, tenderId: string, token: string) {
  const res = await app.request(`/licitaciones/${propertyId}/tenders/${tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(201);
}

async function pdfWithText(text: string): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page = doc.addPage([500, 500]);
  page.drawText(text, { x: 20, y: 460, size: 10, font, maxWidth: 460 });
  return Buffer.from(await doc.save()).toString("base64");
}

async function scannedBlankPdfBase64(): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]); // sin drawText: ninguna capa de texto -- "requires_ocr".
  return Buffer.from(await doc.save()).toString("base64");
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

// Fase 11 -- pipeline real de extracción de texto de PDF conectado también
// a esta ruta: `contentBase64` (bytes reales) como alternativa a `pages`.
describe("Fase 11 -- contract/documents con contentBase64 (bytes reales de PDF)", () => {
  it("un PDF real del contrato firmado se extrae y alimenta extractContractFields -- nunca hace falta pegar texto a mano", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const contentBase64 = await pdfWithText("Contrato numero: SABG-2026-999. Monto total $123,456.00 pesos.");

    const uploaded = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`,
      authedJson(ctx.staff.writer.token, { documentLabel: "Contrato firmado.pdf", contentBase64, mimeType: "application/pdf" }),
    );
    expect(uploaded.status).toBe(201);
    const body = (await uploaded.json()) as { document: { pageCount: number }; fields: { fieldKey: string; status: string }[] };
    expect(body.document.pageCount).toBe(1);
    expect(body.fields.some((f) => f.fieldKey === "numero_contrato")).toBe(true);
    for (const f of body.fields) expect(f.status).toBe("sugerido");
  });

  it("un PDF escaneado (sin capa de texto) -> 422 explícito, nunca se registra un documento con texto inventado", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const scannedBase64 = await scannedBlankPdfBase64();

    const uploaded = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`,
      authedJson(ctx.staff.writer.token, { documentLabel: "Contrato escaneado.pdf", contentBase64: scannedBase64, mimeType: "application/pdf" }),
    );
    expect(uploaded.status).toBe(422);
    const body = (await uploaded.json()) as { message: string };
    expect(body.message).toContain("requires_ocr");

    const listed = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`, authedJson(ctx.staff.viewer.token));
    expect(((await listed.json()) as { documents: unknown[] }).documents).toHaveLength(0);
  });

  it("sin 'pages' NI 'contentBase64' -> 400 de validación", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/documents`, authedJson(ctx.staff.writer.token, { documentLabel: "x" }));
    expect(res.status).toBe(400);
  });
});
