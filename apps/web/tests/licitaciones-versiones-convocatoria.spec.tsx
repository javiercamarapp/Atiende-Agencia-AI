// @vitest-environment jsdom
//
// paridad3 L-P3-14 -- pestana Versiones: historial real (GET .../versions) con el diff de cada version y las fuentes enlazadas por huella
// cruzada con sus conflictos (GET .../sources). Solo lectura.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionesConvocatoria } from "../src/verticals/licitaciones/components/VersionesConvocatoria.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const VERSIONES = [
  { version: 1, hash: "h1", createdAt: "2026-10-01T10:00:00.000Z", diff: { fields: [], requirements: [], changedFieldNames: [], affectedSectionKeys: [], hasChanges: false } },
  {
    version: 2,
    hash: "h2",
    createdAt: "2026-10-02T10:00:00.000Z",
    diff: {
      fields: [{ field: "submissionDeadline", status: "modificado", previous: "2026-12-15", current: "2026-12-20" }],
      requirements: [{ key: "legal:text:x", status: "nuevo", requirementKind: "legal", previous: null, current: { text: "Presentar acta constitutiva" } }],
      changedFieldNames: ["submissionDeadline"],
      affectedSectionKeys: ["legal"],
      hasChanges: true,
    },
  },
];
const FUENTES = [
  { source: "nl_ocds", externalId: "ocds-1", primary: true, firstSeenAt: null, lastSeenAt: "2026-10-02T10:00:00.000Z", conflicts: [] },
  { source: "cdmx_ocds", externalId: "CDMX-77", primary: false, firstSeenAt: "2026-10-02T11:00:00.000Z", lastSeenAt: "2026-10-02T11:00:00.000Z", conflicts: [{ field: "budget_amount", current: 100, alternative: 200 }] },
];

function stub(over: { versions?: unknown; sources?: unknown; fail?: boolean } = {}) {
  fetchMock = vi.fn(async (url: string) => {
    if (over.fail) return { ok: false, status: 500, headers: new Headers(), json: async () => ({ message: "boom" }) } as unknown as Response;
    const body = String(url).endsWith("/versions") ? { versions: over.versions ?? VERSIONES } : { sources: over.sources ?? FUENTES };
    return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const mount = () => {
  rendered = renderComponent(<VersionesConvocatoria apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" tenderId="t1" />);
};
const text = () => rendered!.container.textContent ?? "";

describe("VersionesConvocatoria (L-P3-14)", () => {
  it("lista las versiones de la mas reciente a la mas antigua con su diff y las secciones afectadas", async () => {
    stub();
    mount();
    await settle();
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain("https://api.test/licitaciones/prop-1/tenders/t1/versions");
    expect(urls).toContain("https://api.test/licitaciones/prop-1/tenders/t1/sources");
    expect(text().indexOf("Versión 2")).toBeLessThan(text().indexOf("Versión 1"));
    expect(text()).toContain("Fecha límite");
    expect(text()).toContain("2026-12-15 → 2026-12-20");
    expect(text()).toContain("Presentar acta constitutiva");
    expect(text()).toContain("Secciones de la propuesta marcadas para revisión por este cambio: legal.");
    expect(text()).toContain("Versión inicial");
  });

  it("muestra la fuente primaria, la enlazada y el conflicto de campos de la enlazada", async () => {
    stub();
    mount();
    await settle();
    expect(text()).toContain("Primaria");
    expect(text()).toContain("Enlazada");
    expect(text()).toContain("cdmx_ocds difiere en:");
    expect(text()).toContain("Presupuesto: 100 (primaria) · 200 (cdmx_ocds)");
  });

  it("sin versiones: estado vacio; con error: mensaje con reintento", async () => {
    stub({ versions: [], sources: [FUENTES[0]] });
    mount();
    await settle();
    expect(text()).toContain("todavía no tiene versiones registradas");
    rendered!.unmount();
    stub({ fail: true });
    mount();
    await settle();
    expect(rendered!.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("solo lectura: toda llamada es GET", async () => {
    stub();
    mount();
    await settle();
    expect(fetchMock.mock.calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === "GET")).toBe(true);
  });
});
