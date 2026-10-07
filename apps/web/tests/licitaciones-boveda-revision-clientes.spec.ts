// paridad3 (L-P3-05/06/07) -- clientes web de la boveda, la matriz editable, los conflictos y la revision: rutas, metodos,
// cuerpos, cabecera de idempotencia y la lectura honesta (`disponible`/`migrated`) de una base sin la migracion 037.
import { describe, expect, it, vi } from "vitest";
import { fetchDocumentPage, fetchTenderDocuments, extractRequirementsFromDocuments, uploadTenderDocument } from "../src/verticals/licitaciones/lib/documents-client.ts";
import { fetchRequirementConflicts, fetchRequirementMatrix, resolveRequirementConflict, updateRequirement } from "../src/verticals/licitaciones/lib/requirements-client.ts";
import { addReviewComment, editProposalSection, requestReview } from "../src/verticals/licitaciones/lib/revision-client.ts";
import { splitAtExtract } from "../src/verticals/licitaciones/components/VisorCita.tsx";

const BASE = "http://api.local";
const T = `${BASE}/licitaciones/p1/tenders/t1`;

function recorder(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("documents-client", () => {
  it("lista la boveda y respeta disponible=false de una base sin la 037", async () => {
    const { fetchImpl, calls } = recorder({ disponible: false, documents: [], tipos: [] });
    expect(await fetchTenderDocuments(fetchImpl, BASE, "tok", "p1", "t1")).toEqual({ disponible: false, documents: [] });
    expect(calls[0]!.url).toBe(`${T}/documents`);
  });

  it("sube el archivo en base64 con tipo, titulo, version que reemplaza e Idempotency-Key", async () => {
    const { fetchImpl, calls } = recorder({ document: { id: "d1", version: 2 } }, 201);
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "bases.pdf", { type: "application/pdf" });
    const doc = await uploadTenderDocument(fetchImpl, BASE, "tok", "p1", "t1", { file, documentType: "acta_junta", title: "Acta 1", replacesDocumentId: "d0" }, "key-1");
    expect(doc.id).toBe("d1");
    expect(calls[0]!.url).toBe(`${T}/documents`);
    expect(calls[0]!.init!.method).toBe("POST");
    expect((calls[0]!.init!.headers as Record<string, string>)["idempotency-key"]).toBe("key-1");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ documentType: "acta_junta", title: "Acta 1", filename: "bases.pdf", mimeType: "application/pdf", contentBase64: "JVBERg==", replacesDocumentId: "d0" });
  });

  it("el visor pide UNA pagina y re-extraer manda documentIds (no vuelve a subir)", async () => {
    const page = recorder({ document: { id: "d1" }, page: { page: 3, text: "texto" } });
    await fetchDocumentPage(page.fetchImpl, BASE, "tok", "p1", "t1", "d1", 3);
    expect(page.calls[0]!.url).toBe(`${T}/documents/d1?page=3`);
    const ex = recorder({ items: [], conflicts: [], skippedDocuments: [] });
    await extractRequirementsFromDocuments(ex.fetchImpl, BASE, "tok", "p1", "t1", ["d1", "d2"], "key-2");
    expect(ex.calls[0]!.url).toBe(`${T}/requirements/extract`);
    expect(JSON.parse(String(ex.calls[0]!.init!.body))).toEqual({ documentIds: ["d1", "d2"] });
    expect((ex.calls[0]!.init!.headers as Record<string, string>)["idempotency-key"]).toBe("key-2");
  });
});

describe("requirements-client (matriz estable y conflictos)", () => {
  it("pide la matriz con includeRetired y distingue una base sin migrar", async () => {
    const a = recorder({ items: [], migrated: true });
    expect(await fetchRequirementMatrix(a.fetchImpl, BASE, "tok", "p1", "t1", true)).toEqual({ migrated: true, items: [] });
    expect(a.calls[0]!.url).toBe(`${T}/requirements?includeRetired=1`);
    const b = recorder({ items: [] });
    expect((await fetchRequirementMatrix(b.fetchImpl, BASE, "tok", "p1", "t1", false)).migrated).toBe(false);
    expect(b.calls[0]!.url).toBe(`${T}/requirements`);
  });

  it("PATCH del requisito manda solo los campos cambiados y devuelve el item", async () => {
    const { fetchImpl, calls } = recorder({ item: { id: "i1", status: "cumplido" } });
    const item = await updateRequirement(fetchImpl, BASE, "tok", "p1", "t1", "i1", { status: "cumplido", disqualifying: true });
    expect(item.id).toBe("i1");
    expect(calls[0]!.url).toBe(`${T}/requirements/i1`);
    expect(calls[0]!.init!.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ status: "cumplido", disqualifying: true });
  });

  it("lista conflictos y resolver manda las notas", async () => {
    const list = recorder({ disponible: true, conflicts: [{ id: "c1", status: "abierto" }] });
    expect((await fetchRequirementConflicts(list.fetchImpl, BASE, "tok", "p1", "t1")).conflicts).toHaveLength(1);
    expect(list.calls[0]!.url).toBe(`${T}/requirements/conflicts`);
    const res = recorder({ conflict: { id: "c1", status: "resuelto" } });
    await resolveRequirementConflict(res.fetchImpl, BASE, "tok", "p1", "t1", "c1", "Prevalece el acta.");
    expect(res.calls[0]!.url).toBe(`${T}/requirements/conflicts/c1/resolve`);
    expect(JSON.parse(String(res.calls[0]!.init!.body))).toEqual({ notes: "Prevalece el acta." });
  });
});

describe("revision-client", () => {
  it("edita una seccion con su clave codificada en la ruta", async () => {
    const { fetchImpl, calls } = recorder({ section: { sectionKey: "technical:legal", version: 2 }, changed: true, invalidatedApprovals: 1 });
    const r = await editProposalSection(fetchImpl, BASE, "tok", "p1", "t1", "technical:legal", "Nuevo texto");
    expect(r.invalidatedApprovals).toBe(1);
    expect(calls[0]!.url).toBe(`${T}/proposal/sections/technical%3Alegal`);
    expect(calls[0]!.init!.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ content: "Nuevo texto" });
  });

  it("comenta y pide revision por seccion o por expediente", async () => {
    const c = recorder({ comment: { id: "m1" } }, 201);
    await addReviewComment(c.fetchImpl, BASE, "tok", "p1", "t1", { sectionKey: "technical:legal", body: "Falta el anexo 3." });
    expect(c.calls[0]!.url).toBe(`${T}/proposal/comments`);
    expect(JSON.parse(String(c.calls[0]!.init!.body))).toEqual({ scope: "seccion", sectionKey: "technical:legal", body: "Falta el anexo 3." });
    const r = recorder({ comment: { id: "m2" } }, 201);
    await requestReview(r.fetchImpl, BASE, "tok", "p1", "t1", { sectionKey: null, note: "" });
    expect(r.calls[0]!.url).toBe(`${T}/proposal/request-review`);
    expect(JSON.parse(String(r.calls[0]!.init!.body))).toEqual({ scope: "expediente", note: "" });
  });
});

describe("visor de la cita", () => {
  it("resalta el extracto dentro de la pagina aunque cambien espacios y mayusculas, y devuelve null si no aparece", () => {
    const page = "Capitulo 2.\nEl  licitante DEBERA presentar\nacta constitutiva original. Fin.";
    const parts = splitAtExtract(page, "El licitante deberá presentar acta constitutiva original.".replace("deberá", "debera"));
    expect(parts).not.toBeNull();
    expect(parts![1].toLowerCase().replace(/\s+/g, " ")).toBe("el licitante debera presentar acta constitutiva original.");
    expect(parts![0] + parts![1] + parts![2]).toBe(page);
    expect(splitAtExtract(page, "Texto que no esta en la pagina para nada")).toBeNull();
    expect(splitAtExtract(page, "corto")).toBeNull();
  });
});
