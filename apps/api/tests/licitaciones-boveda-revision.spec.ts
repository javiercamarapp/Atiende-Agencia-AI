// paridad3 (L-P3-05/06/07) -- HTTP real (app.request) de la boveda de bases, la matriz estable, los conflictos persistidos, los
// comentarios de revision y el editor humano de secciones. Incluye AE-02 y AE-11 portados con nombre.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildApp } from "../src/app.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import type { LicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const BASES = "El licitante deberá presentar acta constitutiva original. El licitante deberá acreditar experiencia técnica mínima de 3 años.";

async function pdfBytes(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  doc.addPage([500, 500]).drawText(text, { x: 20, y: 460, size: 10, font, maxWidth: 460 });
  return Buffer.from(await doc.save());
}
async function blankPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  return Buffer.from(await doc.save());
}
function peImage(): Buffer {
  const b = Buffer.alloc(0x100);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  return b;
}

let seq = 0;
const key = (p: string) => `${p}-${(seq += 1)}`;

function url(ctx: LicitacionesTestContext, path: string): string {
  return `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}${path}`;
}

function put(ctx: LicitacionesTestContext, method: "PATCH" | "POST", path: string, token: string, body: unknown): [string, RequestInit] {
  const raw = JSON.stringify(body);
  return [url(ctx, path), { method, body: raw, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)), "idempotency-key": key("k") } }];
}

async function upload(ctx: LicitacionesTestContext, token: string, bytes: Buffer, extra: Record<string, unknown> = {}) {
  const app = buildApp(ctx.deps);
  return app.request(url(ctx, "/documents"), authedJson(token, { documentType: "bases", filename: "bases.pdf", mimeType: "application/pdf", contentBase64: bytes.toString("base64"), ...extra }, { "idempotency-key": key("up") }));
}

async function extract(ctx: LicitacionesTestContext, body: unknown) {
  return buildApp(ctx.deps).request(url(ctx, "/requirements/extract"), authedJson(ctx.staff.writer.token, body, { "idempotency-key": key("ex") }));
}

describe("boveda de documentos (L-P3-05)", () => {
  it("subir un PDF valido da 201 con sha256, tamano, paginas y estado de extraccion; el viewer lo lista", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const bytes = await pdfBytes(BASES);
    const res = await upload(ctx, ctx.staff.writer.token, bytes);
    expect(res.status).toBe(201);
    const { document } = (await res.json()) as { document: { id: string; sha256: string; sizeBytes: number; pageCount: number; extractionStatus: string; version: number; latest: boolean } };
    expect(document).toMatchObject({ sizeBytes: bytes.length, pageCount: 1, extractionStatus: "extracted", version: 1, latest: true });
    expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await buildApp(ctx.deps).request(url(ctx, "/documents"), authedJson(ctx.staff.viewer.token));
    const body = (await list.json()) as { disponible: boolean; documents: { id: string }[] };
    expect(body.disponible).toBe(true);
    expect(body.documents.map((d) => d.id)).toEqual([document.id]);
  });

  it("un MZ al final, un ZIP o un PDF sin %%EOF dan 422 y no guardan nada", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const pdf = await pdfBytes(BASES);
    const truncated = pdf.subarray(0, pdf.lastIndexOf("%%EOF"));
    for (const bad of [Buffer.concat([pdf, peImage()]), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]), truncated]) {
      const res = await upload(ctx, ctx.staff.writer.token, bad);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("documento_rechazado");
    }
    const list = (await (await buildApp(ctx.deps).request(url(ctx, "/documents"), authedJson(ctx.staff.viewer.token))).json()) as { documents: unknown[] };
    expect(list.documents).toEqual([]);
  });

  it("un PDF escaneado se guarda con requires_ocr y motivo, sin inventar texto, y emite el aviso de documento sin texto", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const app = buildApp(deps);
    const res = await app.request(url(ctx, "/documents"), authedJson(ctx.staff.writer.token, { filename: "escaneado.pdf", contentBase64: (await blankPdf()).toString("base64") }, { "idempotency-key": key("up") }));
    expect(res.status).toBe(201);
    const { document } = (await res.json()) as { document: { extractionStatus: string; extractionDetail: string } };
    expect(document.extractionStatus).toBe("requires_ocr");
    expect(document.extractionDetail).toMatch(/OCR/);
    expect(emisiones.map((e) => e.evento)).toEqual(["licitaciones.documentos.sin_texto"]);
  });

  it("solo roles de escritura suben; una version nueva comparte linaje y deja la anterior no vigente", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    expect((await upload(ctx, ctx.staff.viewer.token, await pdfBytes(BASES))).status).toBe(403);
    const v1 = (await (await upload(ctx, ctx.staff.writer.token, await pdfBytes(BASES))).json()) as { document: { id: string; lineageId: string } };
    const v2 = (await (await upload(ctx, ctx.staff.writer.token, await pdfBytes(`${BASES} Se agrega un anexo.`), { replacesDocumentId: v1.document.id })).json()) as { document: { version: number; lineageId: string } };
    expect(v2.document).toMatchObject({ version: 2, lineageId: v1.document.lineageId });
    const list = (await (await buildApp(ctx.deps).request(url(ctx, "/documents"), authedJson(ctx.staff.viewer.token))).json()) as { documents: { id: string; latest: boolean }[] };
    expect(list.documents.find((d) => d.id === v1.document.id)!.latest).toBe(false);
  });

  it("el visor de la cita devuelve el texto de UNA pagina; otra organizacion no ve el documento", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const { document } = (await (await upload(ctx, ctx.staff.writer.token, await pdfBytes(BASES))).json()) as { document: { id: string } };
    const app = buildApp(ctx.deps);
    const page = (await (await app.request(url(ctx, `/documents/${document.id}?page=1`), authedJson(ctx.staff.viewer.token))).json()) as { page: { page: number; text: string } };
    expect(page.page.text).toContain("acta constitutiva");
    const meta = (await (await app.request(url(ctx, `/documents/${document.id}`), authedJson(ctx.staff.viewer.token))).json()) as Record<string, unknown>;
    expect(meta).not.toHaveProperty("page");

    const other = await buildLicitacionesTestContext(buildApp);
    const cross = await buildApp(other.deps).request(`/licitaciones/${other.propertyId}/tenders/${other.tenderId}/documents/${document.id}`, authedJson(other.staff.viewer.token));
    expect(cross.status).toBe(404);
  });

  it("un base64 inline tambien se guarda en la boveda (sin duplicar si se repite) y se valida por contenido", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const bytes = await pdfBytes(BASES);
    const doc = { documentId: "cliente-1", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", contentBase64: bytes.toString("base64"), mimeType: "application/pdf", filename: "bases.pdf" };
    expect((await extract(ctx, { documents: [doc] })).status).toBe(200);
    expect((await extract(ctx, { documents: [{ ...doc, documentId: "cliente-2" }] })).status).toBe(200);
    const list = (await (await buildApp(ctx.deps).request(url(ctx, "/documents"), authedJson(ctx.staff.viewer.token))).json()) as { documents: unknown[] };
    expect(list.documents).toHaveLength(1);
    const bad = await extract(ctx, { documents: [{ ...doc, documentId: "cliente-3", contentBase64: Buffer.concat([bytes, peImage()]).toString("base64") }] });
    expect(bad.status).toBe(422);
  });
});

describe("matriz estable (L-P3-06)", () => {
  it("extraer desde documentIds de la boveda y re-extraer conserva el responsable asignado a mano", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    ctx.repo.seedOrganizationMember(ctx.organizationId, ctx.staff.analyst.id, "Analista", "analyst");
    const { document } = (await (await upload(ctx, ctx.staff.writer.token, await pdfBytes(BASES))).json()) as { document: { id: string } };

    const first = await extract(ctx, { documentIds: [document.id] });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { items: { id: string; type: string }[]; matrix: { created: number } };
    expect(firstBody.matrix.created).toBeGreaterThan(0);
    const legal = firstBody.items.find((i) => i.type === "legal")!;

    const app = buildApp(ctx.deps);
    const patch = await app.request(...put(ctx, "PATCH", `/requirements/${legal.id}`, ctx.staff.writer.token, { responsibleRole: "juridico", status: "en_progreso", assignedTo: ctx.staff.analyst.id, disqualifying: true }));
    expect(patch.status).toBe(200);

    const second = await extract(ctx, { documentIds: [document.id] });
    const secondBody = (await second.json()) as { matrix: { created: number; updated: number; retired: number } };
    expect(secondBody.matrix).toMatchObject({ created: 0, retired: 0 });

    const list = (await (await app.request(url(ctx, "/requirements"), authedJson(ctx.staff.viewer.token))).json()) as { items: { id: string; responsibleRole: string; status: string; assignedTo: string | null; disqualifying: boolean }[]; migrated: boolean };
    expect(list.migrated).toBe(true);
    expect(list.items.find((i) => i.id === legal.id)).toMatchObject({ responsibleRole: "juridico", status: "en_progreso", assignedTo: ctx.staff.analyst.id, disqualifying: true });
  });

  it("lo que desaparece de las bases queda retirado con la version (visible con includeRetired) y no aparece en el listado normal", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const page = (text: string) => ({ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text }] });
    await extract(ctx, { documents: [page(BASES)] });
    const before = (await (await buildApp(ctx.deps).request(url(ctx, "/requirements"), authedJson(ctx.staff.viewer.token))).json()) as { items: unknown[] };
    const res = await extract(ctx, { documents: [page("El licitante deberá presentar acta constitutiva original.")] });
    expect(((await res.json()) as { matrix: { retired: number } }).matrix.retired).toBe(1);

    const app = buildApp(ctx.deps);
    const active = (await (await app.request(url(ctx, "/requirements"), authedJson(ctx.staff.viewer.token))).json()) as { items: unknown[] };
    const all = (await (await app.request(url(ctx, "/requirements?includeRetired=1"), authedJson(ctx.staff.viewer.token))).json()) as { items: { retiredAt: string | null; retiredInVersion: number | null }[] };
    expect(active.items).toHaveLength(before.items.length - 1);
    expect(all.items.filter((i) => i.retiredAt !== null)).toHaveLength(1);
    expect(all.items.find((i) => i.retiredAt !== null)!.retiredInVersion).toBeGreaterThan(1);
  });

  it("PATCH exige rol de escritura, valida el asignado y no deja poner 'bloqueado'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    await extract(ctx, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: BASES }] }] });
    const [first] = ((await (await buildApp(ctx.deps).request(url(ctx, "/requirements"), authedJson(ctx.staff.viewer.token))).json()) as { items: { id: string }[] }).items;
    const app = buildApp(ctx.deps);
    expect((await app.request(...put(ctx, "PATCH", `/requirements/${first!.id}`, ctx.staff.viewer.token, { status: "cumplido" }))).status).toBe(403);
    expect((await app.request(...put(ctx, "PATCH", `/requirements/${first!.id}`, ctx.staff.writer.token, { status: "bloqueado" }))).status).toBe(400);
    expect((await app.request(...put(ctx, "PATCH", `/requirements/${first!.id}`, ctx.staff.writer.token, { assignedTo: ctx.staff.owner.id }))).status).toBe(400); // no es miembro sembrado
    expect((await app.request(...put(ctx, "PATCH", `/requirements/${first!.id}`, ctx.staff.writer.token, {}))).status).toBe(400);
    expect((await app.request(...put(ctx, "PATCH", `/requirements/00000000-0000-4000-8000-000000000000`, ctx.staff.writer.token, { status: "cumplido" }))).status).toBe(404);
  });
});

describe("conflictos persistidos (L-P3-06)", () => {
  const A = { documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: "La entrega de proposiciones será a más tardar el 15 de diciembre del 2026 a las 18:00 horas." }] };
  const B = { documentId: "aclaracion", documentLabel: "Acta", publishedAt: "2026-02-01T00:00:00-06:00", pages: [{ page: 1, text: "Se aclara que la entrega de proposiciones será a más tardar el 20 de diciembre del 2026 a las 18:00 horas." }] };

  async function conConflicto() {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const res = await buildApp(deps).request(url(ctx, "/requirements/extract"), authedJson(ctx.staff.writer.token, { documents: [A, B] }, { "idempotency-key": key("ex") }));
    expect(res.status).toBe(200);
    return { ctx, deps, emisiones };
  }

  it("el conflicto se persiste abierto, avisa por la campana y un GET posterior lo sigue mostrando", async () => {
    const { ctx, emisiones } = await conConflicto();
    const list = (await (await buildApp(ctx.deps).request(url(ctx, "/requirements/conflicts"), authedJson(ctx.staff.viewer.token))).json()) as { disponible: boolean; conflicts: { id: string; status: string; kind: string }[] };
    expect(list.disponible).toBe(true);
    expect(list.conflicts).toMatchObject([{ status: "abierto", kind: "deadline_mismatch" }]);
    expect(emisiones.filter((e) => e.evento === "licitaciones.requisitos.conflicto_abierto")).toHaveLength(1);
  });

  it("resolver exige notas, deja quien lo resolvio y no se puede resolver dos veces; viewer no resuelve", async () => {
    const { ctx } = await conConflicto();
    const app = buildApp(ctx.deps);
    const [c] = ((await (await app.request(url(ctx, "/requirements/conflicts"), authedJson(ctx.staff.viewer.token))).json()) as { conflicts: { id: string }[] }).conflicts;
    const path = `/requirements/conflicts/${c!.id}/resolve`;
    expect((await app.request(...put(ctx, "POST", path, ctx.staff.writer.token, {}))).status).toBe(400);
    expect((await app.request(...put(ctx, "POST", path, ctx.staff.writer.token, { notes: "   " }))).status).toBe(400);
    expect((await app.request(...put(ctx, "POST", path, ctx.staff.viewer.token, { notes: "Prevalece el acta." }))).status).toBe(403);
    const ok = await app.request(...put(ctx, "POST", path, ctx.staff.writer.token, { notes: "Prevalece el acta de junta." }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { conflict: { status: string; resolvedBy: string } }).conflict).toMatchObject({ status: "resuelto", resolvedBy: ctx.staff.writer.id });
    expect((await app.request(...put(ctx, "POST", path, ctx.staff.writer.token, { notes: "otra vez" }))).status).toBe(409);
    expect((await app.request(...put(ctx, "POST", `/requirements/conflicts/00000000-0000-4000-8000-000000000000/resolve`, ctx.staff.writer.token, { notes: "x" }))).status).toBe(404);
  });

  it("un conflicto abierto pone en rojo la consistencia cruzada del checklist; resuelto, deja de bloquear", async () => {
    const { ctx } = await conConflicto();
    const app = buildApp(ctx.deps);
    await app.request(url(ctx, "/proposal"), authedJson(ctx.staff.writer.token));
    const run = async () => {
      const body = { files: [], formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 1000, maxUploadSlots: 5 }, requiredSignatures: [], presentAnnexRefs: [] };
      const res = await app.request(url(ctx, "/checklist/run"), authedJson(ctx.staff.writer.token, body, { "idempotency-key": key("ck") }));
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: { dimension: string; result: string; notes: string }[] }).items.find((i) => i.dimension === "consistencia_cruzada")!;
    };
    expect(await run()).toMatchObject({ result: "rojo" });
    const [c] = ((await (await app.request(url(ctx, "/requirements/conflicts"), authedJson(ctx.staff.viewer.token))).json()) as { conflicts: { id: string }[] }).conflicts;
    await app.request(...put(ctx, "POST", `/requirements/conflicts/${c!.id}/resolve`, ctx.staff.writer.token, { notes: "Prevalece el acta de junta." }));
    expect((await run()).notes).not.toMatch(/conflicto/i);
  });

  it("cross-tenant: otra organizacion no ve ni resuelve los conflictos", async () => {
    const { ctx } = await conConflicto();
    const other = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const [c] = ((await (await app.request(url(ctx, "/requirements/conflicts"), authedJson(ctx.staff.viewer.token))).json()) as { conflicts: { id: string }[] }).conflicts;
    const otherApp = buildApp(other.deps);
    const seen = (await (await otherApp.request(`/licitaciones/${other.propertyId}/tenders/${other.tenderId}/requirements/conflicts`, authedJson(other.staff.viewer.token))).json()) as { conflicts: unknown[] };
    expect(seen.conflicts).toEqual([]);
    const res = await otherApp.request(`/licitaciones/${other.propertyId}/tenders/${other.tenderId}/requirements/conflicts/${c!.id}/resolve`, { method: "POST", body: JSON.stringify({ notes: "intento ajeno" }), headers: { authorization: `Bearer ${other.staff.writer.token}`, "content-type": "application/json" } });
    expect(res.status).toBe(404);
  });
});

describe("revision con comentarios y editor humano de secciones (L-P3-07)", () => {
  async function conSeccion() {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const app = buildApp(deps);
    const proposal = (await (await app.request(url(ctx, "/proposal"), authedJson(ctx.staff.writer.token))).json()) as { id: string };
    ctx.repo.seedProposalSection(proposal.id, { documentId: "doc-legal", sectionKey: "technical:legal", label: "Cumplimiento legal", filename: "legal.txt", version: 1, content: "Texto original." });
    return { ctx, app, emisiones, proposalId: proposal.id };
  }
  const sectionPath = `/proposal/sections/${encodeURIComponent("technical:legal")}`;

  async function aprobar(ctx: LicitacionesTestContext, app: ReturnType<typeof buildApp>, token: string) {
    return app.request(url(ctx, `${sectionPath}/approval`), authedJson(token, {}));
  }

  it("AE-02: editar con el MISMO texto no invalida la aprobacion; con un texto distinto si, y avisa por la campana", async () => {
    const { ctx, app, emisiones } = await conSeccion();
    expect((await aprobar(ctx, app, ctx.staff.owner.token)).status).toBe(201);

    const same = await app.request(...put(ctx, "PATCH", sectionPath, ctx.staff.writer.token, { content: "Texto original." }));
    expect(((await same.json()) as { changed: boolean; invalidatedApprovals: number })).toMatchObject({ changed: false, invalidatedApprovals: 0 });
    const aprobada = async () => ((await (await app.request(url(ctx, "/proposal/sections"), authedJson(ctx.staff.viewer.token))).json()) as { sections: { approved: boolean }[] }).sections[0]!.approved;
    expect(await aprobada()).toBe(true);
    expect(emisiones.filter((e) => e.evento === "licitaciones.expediente.aprobacion_invalidada")).toHaveLength(0);

    const edit = await app.request(...put(ctx, "PATCH", sectionPath, ctx.staff.writer.token, { content: "Texto corregido por una persona." }));
    expect(((await edit.json()) as { changed: boolean; invalidatedApprovals: number; section: { version: number } })).toMatchObject({ changed: true, invalidatedApprovals: 1, section: { version: 2 } });
    expect(await aprobada()).toBe(false);
    expect(emisiones.filter((e) => e.evento === "licitaciones.expediente.aprobacion_invalidada")).toHaveLength(1);
  });

  it("AE-11: quien edita la seccion no puede aprobarla (403) y la API lo marca como autor; otra persona si aprueba", async () => {
    const { ctx, app } = await conSeccion();
    const edit = await app.request(...put(ctx, "PATCH", sectionPath, ctx.staff.analyst.token, { content: "Texto del analista." }));
    expect(edit.status).toBe(200);
    expect((await aprobar(ctx, app, ctx.staff.analyst.token)).status).toBe(403);
    const sections = (await (await app.request(url(ctx, "/proposal/sections"), authedJson(ctx.staff.analyst.token))).json()) as { sections: { authoredByViewer: boolean }[] };
    expect(sections.sections[0]!.authoredByViewer).toBe(true);
    const asOwner = (await (await app.request(url(ctx, "/proposal/sections"), authedJson(ctx.staff.owner.token))).json()) as { sections: { authoredByViewer: boolean }[] };
    expect(asOwner.sections[0]!.authoredByViewer).toBe(false);
    expect((await aprobar(ctx, app, ctx.staff.owner.token)).status).toBe(201);
  });

  it("el editor exige rol de escritura, contenido no vacio y una seccion existente", async () => {
    const { ctx, app } = await conSeccion();
    expect((await app.request(...put(ctx, "PATCH", sectionPath, ctx.staff.viewer.token, { content: "x" }))).status).toBe(403);
    expect((await app.request(...put(ctx, "PATCH", sectionPath, ctx.staff.writer.token, { content: "  " }))).status).toBe(400);
    expect((await app.request(...put(ctx, "PATCH", "/proposal/sections/no-existe", ctx.staff.writer.token, { content: "x" }))).status).toBe(404);
  });

  it("comentarios: el escritor comenta por seccion y expediente, el viewer los lee con 'esTuyo', y no se expone el id del autor", async () => {
    const { ctx, app } = await conSeccion();
    expect((await app.request(...put(ctx, "POST", "/proposal/comments", ctx.staff.viewer.token, { body: "hola" }))).status).toBe(403);
    expect((await app.request(...put(ctx, "POST", "/proposal/comments", ctx.staff.writer.token, { body: "  " }))).status).toBe(400);
    expect((await app.request(...put(ctx, "POST", "/proposal/comments", ctx.staff.writer.token, { scope: "seccion", sectionKey: "technical:legal", body: "Falta el anexo 3." }))).status).toBe(201);
    expect((await app.request(...put(ctx, "POST", "/proposal/comments", ctx.staff.owner.token, { body: "Revisado el expediente." }))).status).toBe(201);
    const list = (await (await app.request(url(ctx, "/proposal/comments"), authedJson(ctx.staff.writer.token))).json()) as { disponible: boolean; comments: { scopeRef: string; authorRole: string; esTuyo: boolean; authorId?: string }[] };
    expect(list.disponible).toBe(true);
    expect(list.comments.map((c) => [c.scopeRef, c.authorRole, c.esTuyo])).toEqual([["seccion:technical:legal", "writer", true], ["expediente", "owner", false]]);
    expect(JSON.stringify(list)).not.toContain(ctx.staff.owner.id);
  });

  it("comentarios con aislamiento entre organizaciones: otra organizacion no los ve ni comenta en esta propuesta", async () => {
    const { ctx, app } = await conSeccion();
    await app.request(...put(ctx, "POST", "/proposal/comments", ctx.staff.writer.token, { body: "Solo de esta organizacion." }));
    const other = await buildLicitacionesTestContext(buildApp);
    const otherApp = buildApp(other.deps);
    await otherApp.request(`/licitaciones/${other.propertyId}/tenders/${other.tenderId}/proposal`, authedJson(other.staff.writer.token));
    const seen = (await (await otherApp.request(`/licitaciones/${other.propertyId}/tenders/${other.tenderId}/proposal/comments`, authedJson(other.staff.viewer.token))).json()) as { comments: unknown[] };
    expect(seen.comments).toEqual([]);
    // un token de la otra organizacion sobre la propiedad de esta: la membresia lo rechaza
    const cross = await app.request(url(ctx, "/proposal/comments"), authedJson(other.staff.viewer.token));
    expect([403, 404]).toContain(cross.status);
  });

  it("pedir revision: queda en el hilo, avisa a los revisores y quien la pidio no puede aprobar ese alcance", async () => {
    const { ctx, app, emisiones } = await conSeccion();
    const res = await app.request(...put(ctx, "POST", "/proposal/request-review", ctx.staff.owner.token, { scope: "seccion", sectionKey: "technical:legal", note: "Listo para tu revision." }));
    expect(res.status).toBe(201);
    expect(emisiones.filter((e) => e.evento === "licitaciones.revision.solicitada")).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({ categoria: "aprobaciones", roles: ["analyst", "reviewer"] });
    expect(JSON.stringify(emisiones)).not.toContain("Listo para tu revision");

    expect((await aprobar(ctx, app, ctx.staff.owner.token)).status).toBe(403); // quien pidio la revision no la aprueba
    expect((await aprobar(ctx, app, ctx.staff.admin.token)).status).toBe(201);
    const list = (await (await app.request(url(ctx, "/proposal/comments"), authedJson(ctx.staff.viewer.token))).json()) as { comments: { kind: string }[] };
    expect(list.comments.map((c) => c.kind)).toEqual(["solicitud_revision"]);
    // el rol reviewer no puede pedir revision (SUBMITTER_ROLES) y el viewer tampoco
    expect((await app.request(...put(ctx, "POST", "/proposal/request-review", ctx.staff.reviewer.token, {}))).status).toBe(403);
    expect((await app.request(...put(ctx, "POST", "/proposal/request-review", ctx.staff.viewer.token, {}))).status).toBe(403);
  });
});

describe("base sin la migracion 037 (compatibilidad)", () => {
  it("las lecturas dan vacio honesto y las escrituras 503 'no disponible aun'; extraer sigue funcionando", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    ctx.repo.boveda037 = false;
    const app = buildApp(ctx.deps);
    const docs = (await (await app.request(url(ctx, "/documents"), authedJson(ctx.staff.viewer.token))).json()) as { disponible: boolean; documents: unknown[] };
    expect(docs).toMatchObject({ disponible: false, documents: [] });
    const up = await upload(ctx, ctx.staff.writer.token, await pdfBytes(BASES));
    expect(up.status).toBe(503);
    expect(((await up.json()) as { code: string }).code).toBe("boveda_no_disponible");

    const ex = await extract(ctx, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: BASES }] }] });
    expect(ex.status).toBe(200);
    expect(((await ex.json()) as { matrix: { mode: string } }).matrix.mode).toBe("reemplazo");
    const list = (await (await app.request(url(ctx, "/requirements"), authedJson(ctx.staff.viewer.token))).json()) as { migrated: boolean; items: unknown[] };
    expect(list.migrated).toBe(false);
    expect(list.items.length).toBeGreaterThan(0);

    const conflicts = (await (await app.request(url(ctx, "/requirements/conflicts"), authedJson(ctx.staff.viewer.token))).json()) as { disponible: boolean };
    expect(conflicts.disponible).toBe(false);
    await app.request(url(ctx, "/proposal"), authedJson(ctx.staff.writer.token));
    const comment = await app.request(...put(ctx, "POST", "/proposal/comments", ctx.staff.writer.token, { body: "hola" }));
    expect(comment.status).toBe(503);
    const comments = (await (await app.request(url(ctx, "/proposal/comments"), authedJson(ctx.staff.viewer.token))).json()) as { disponible: boolean };
    expect(comments.disponible).toBe(false);
  });
});
