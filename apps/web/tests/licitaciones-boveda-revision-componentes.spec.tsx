// @vitest-environment jsdom
//
// paridad3 (L-P3-05/06/07) -- componentes reales contra un fetch simulado: la boveda (estado de extraccion, re-extraer, base
// sin la 037), los conflictos (las notas son obligatorias) y la revision (editor, autoria y aviso de invalidacion).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentosBases } from "../src/verticals/licitaciones/components/DocumentosBases.tsx";
import { ConflictosRequisitos } from "../src/verticals/licitaciones/components/ConflictosRequisitos.tsx";
import { RevisionExpediente } from "../src/verticals/licitaciones/components/RevisionExpediente.tsx";
import type { TenderDocument } from "../src/verticals/licitaciones/lib/documents-client.ts";
import type { PersistedRequirementConflict } from "../src/verticals/licitaciones/lib/requirements-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const callsTo = (suffix: string, method: string) => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && ((init as RequestInit | undefined)?.method ?? "GET") === method);

const doc = (over: Partial<TenderDocument> = {}): TenderDocument => ({
  id: "d1", tenderId: "t1", documentType: "bases", title: "Bases", filename: "bases.pdf", mimeType: "application/pdf", sha256: "a".repeat(64), sizeBytes: 100, pageCount: 4,
  extractionStatus: "extracted", extractionDetail: null, lineageId: "l1", version: 1, latest: true, createdAt: "2026-10-01T16:00:00.000Z", ...over,
});

describe("DocumentosBases", () => {
  const props = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", tenderId: "t1", canWrite: true, onChanged: vi.fn(async () => undefined), onSkipped: vi.fn() };

  it("base sin la 037: estado honesto 'no disponible aun' y ningun control de subida", async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<DocumentosBases {...props} disponible={false} documents={[]} />);
    await settle();
    expect(rendered.container.textContent).toContain("no disponible aún");
    expect(rendered.container.querySelector('input[type="file"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("muestra el estado de extraccion con su motivo; un documento sin texto no se puede re-extraer", async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(
      <DocumentosBases {...props} disponible documents={[doc(), doc({ id: "d2", title: "Escaneado", extractionStatus: "requires_ocr", extractionDetail: "PDF sin capa de texto" })]} />,
    );
    await settle();
    expect(rendered.container.textContent).toContain("Texto extraído");
    expect(rendered.container.textContent).toContain("Requiere OCR");
    expect(rendered.container.textContent).toContain("PDF sin capa de texto");
    const reextraer = [...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Re-extraer"));
    expect(reextraer).toHaveLength(2);
    expect(reextraer.map((b) => b.disabled)).toEqual([false, true]);
  });

  it("Re-extraer manda documentIds con Idempotency-Key, recarga y avisa lo que paso con la matriz", async () => {
    fetchMock = vi.fn(async () => json({ items: [], conflicts: [], skippedDocuments: [], matrix: { mode: "estable", created: 1, updated: 2, unchanged: 0, retired: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn(async () => undefined);
    rendered = renderComponent(<DocumentosBases {...props} onChanged={onChanged} disponible documents={[doc()]} />);
    await settle();
    click(boton("Re-extraer")!);
    await settle();
    const [call] = callsTo("/requirements/extract", "POST");
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ documentIds: ["d1"] });
    expect(((call![1] as RequestInit).headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(rendered.container.textContent).toContain("1 nuevos, 2 actualizados, 3 retirados");
  });

  it("un rol sin escritura ve la lista sin subir ni re-extraer", async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<DocumentosBases {...props} canWrite={false} disponible documents={[doc()]} />);
    await settle();
    expect(rendered.container.querySelector('input[type="file"]')).toBeNull();
    expect(boton("Re-extraer")).toBeUndefined();
  });
});

describe("ConflictosRequisitos", () => {
  const conflict = (over: Partial<PersistedRequirementConflict> = {}): PersistedRequirementConflict => ({
    id: "c1", kind: "deadline_mismatch", topicKey: "plazo_entrega_proposiciones", description: "Dos fechas limite distintas.", itemIds: ["i1", "i2"], status: "abierto", resolutionNotes: null, resolvedAt: null, ...over,
  });
  const base = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", tenderId: "t1", canWrite: true, disponible: true };

  it("Resolver sin notas no llama a la API; con notas manda POST resolve y recarga", async () => {
    fetchMock = vi.fn(async () => json({ conflict: { id: "c1", status: "resuelto" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onResolved = vi.fn(async () => undefined);
    rendered = renderComponent(<ConflictosRequisitos {...base} conflicts={[conflict()]} onResolved={onResolved} />);
    await settle();
    click(boton("Resolver")!);
    await settle();
    await submitForm(rendered.container.querySelector("form")!);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("notas de resolución");

    changeValue(rendered.container.querySelector("textarea")!, "Prevalece el acta de junta.");
    await submitForm(rendered.container.querySelector("form")!);
    await settle();
    const [call] = callsTo("/requirements/conflicts/c1/resolve", "POST");
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ notes: "Prevalece el acta de junta." });
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("los resueltos muestran las notas; sin la 037 dice 'no disponible aun'; un rol sin escritura no ve Resolver", async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<ConflictosRequisitos {...base} canWrite={false} conflicts={[conflict(), conflict({ id: "c2", status: "resuelto", resolutionNotes: "Se uso el acta.", resolvedAt: "2026-10-02T10:00:00.000Z" })]} onResolved={vi.fn(async () => undefined)} />);
    await settle();
    expect(boton("Resolver")).toBeUndefined();
    expect(rendered.container.textContent).toContain("Notas: Se uso el acta.");
    rendered.rerender(<ConflictosRequisitos {...base} disponible={false} conflicts={[]} onResolved={vi.fn(async () => undefined)} />);
    await settle();
    expect(rendered.container.textContent).toContain("No disponible aún");
  });
});

describe("RevisionExpediente", () => {
  const section = (over: Record<string, unknown> = {}) => ({ sectionKey: "technical:legal", label: "Cumplimiento legal", content: "Texto original.", version: 1, authorCount: 1, authoredByViewer: false, approved: true, expedienteApproved: false, ...over });
  const stub = (opts: { sections?: unknown[]; comments?: unknown; edit?: unknown } = {}) => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/proposal/sections") && !init?.method) return json({ sections: opts.sections ?? [section()] });
      if (u.endsWith("/proposal/comments") && !init?.method) return json(opts.comments ?? { disponible: true, comments: [] });
      if (init?.method === "PATCH") return json(opts.edit ?? { section: section({ version: 2, authoredByViewer: true }), changed: true, invalidatedApprovals: 1 });
      throw new Error(`fetch inesperado: ${init?.method ?? "GET"} ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  };
  const props = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", tenderId: "t1" };

  it("Guardar solo se habilita con cambios; avisa que se invalidara la aprobacion y, al guardar, que se invalido y que ya no puede aprobar", async () => {
    stub();
    rendered = renderComponent(<RevisionExpediente {...props} role="writer" />);
    await settle();
    expect(boton("Guardar sección")!.disabled).toBe(true);
    changeValue(rendered.container.querySelector("textarea")!, "Texto corregido por una persona.");
    expect(boton("Guardar sección")!.disabled).toBe(false);
    expect(rendered.container.textContent).toContain("Al guardar se invalidará la aprobación vigente de la sección");
    click(boton("Guardar sección")!);
    await settle();
    const [call] = callsTo("/proposal/sections/technical%3Alegal", "PATCH");
    expect(JSON.parse(String((call![1] as RequirementInit).body))).toEqual({ content: "Texto corregido por una persona." });
    expect(rendered.container.textContent).toContain("Se invalidaron 1 aprobación");
  });

  it("el autor lo ve marcado y un viewer ve el editor de solo lectura sin guardar ni comentar", async () => {
    stub({ sections: [section({ authoredByViewer: true })] });
    rendered = renderComponent(<RevisionExpediente {...props} role="viewer" />);
    await settle();
    expect(rendered.container.textContent).toContain("Tú la redactaste: no puedes aprobarla");
    expect(rendered.container.querySelector("textarea")!.readOnly).toBe(true);
    expect(boton("Guardar sección")).toBeUndefined();
    expect(boton("Comentar")).toBeUndefined();
  });

  it("el hilo muestra autor, rol y alcance; sin la 037 dice 'no disponible aun'", async () => {
    stub({ comments: { disponible: true, comments: [{ id: "m1", scope: "seccion", scopeRef: "seccion:technical:legal", kind: "solicitud_revision", body: "Listo para revisar.", authorRole: "writer", authorName: "Ana", esTuyo: false, createdAt: "2026-10-01T16:00:00.000Z" }] } });
    rendered = renderComponent(<RevisionExpediente {...props} role="analyst" />);
    await settle();
    expect(rendered.container.textContent).toContain("Ana");
    expect(rendered.container.textContent).toContain("Solicitud de revisión");
    expect(rendered.container.textContent).toContain("Cumplimiento legal");
    expect(boton("Pedir revisión")).toBeDefined();
    rendered.unmount();
    stub({ comments: { disponible: false, comments: [] } });
    rendered = renderComponent(<RevisionExpediente {...props} role="analyst" />);
    await settle();
    expect(rendered.container.textContent).toContain("no disponible aún");
  });

  it("sin propuesta generada explica el orden natural en vez de mostrar un error", async () => {
    fetchMock = vi.fn(async () => json({ message: "Genere primero la propuesta antes de revisarla." }, 404));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<RevisionExpediente {...props} role="writer" />);
    await settle();
    expect(rendered.container.textContent).toContain("Genera la propuesta técnica");
  });
});

type RequirementInit = RequestInit;
