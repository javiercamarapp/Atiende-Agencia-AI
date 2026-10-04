// @vitest-environment jsdom
//
// paridad3 L-P3-16 -- bandeja de Expedientes: lo que se ve sale del servidor (GET .../expedientes), la pagina y el filtro de estado viajan en la
// consulta, cada paso enlaza a su pantalla y la pantalla es de solo lectura (ninguna llamada escribe).
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpedientesPage } from "../src/verticals/licitaciones/pages/Expedientes.tsx";
import type { ExpedienteFila } from "../src/verticals/licitaciones/lib/expedientes-client.ts";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "viewer", staffFullName: "Ana", staffEmail: "ana@example.com" };
const FILA = (id: string, over: Partial<ExpedienteFila> = {}): ExpedienteFila => ({
  tenderId: id,
  title: `Expediente ${id}`,
  status: "go",
  submissionDeadline: "2026-12-15T18:00:00-06:00",
  requisitos: { total: 10, cumplidos: 4 },
  redaccion: "hecho",
  checklist: "ambar",
  aprobacion: { modo: "doble", tecnicaLegal: true, economica: false, completa: false },
  paquete: false,
  presentada: false,
  ...over,
});

function stub(items: ExpedienteFila[], total = items.length, ok = true) {
  fetchMock = vi.fn(async () => ({ ok, status: ok ? 200 : 500, headers: new Headers({ "x-total-count": String(total) }), json: async () => (ok ? { expedientes: items } : { message: "boom" }) }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const mount = () => {
  rendered = renderComponent(
    <MemoryRouter>
      <ExpedientesPage {...CTX} />
    </MemoryRouter>,
  );
};
const text = () => rendered!.container.textContent ?? "";
const lastUrl = () => new URL(String(fetchMock.mock.calls.at(-1)![0]));

describe("ExpedientesPage (L-P3-16)", () => {
  it("muestra cada paso del expediente que dice el servidor y enlaza a su pantalla", async () => {
    stub([FILA("t1"), FILA("t2", { status: "submitted", presentada: true, paquete: true, checklist: "verde", aprobacion: { modo: "doble", tecnicaLegal: true, economica: true, completa: true } })]);
    mount();
    await settle();
    expect(lastUrl().pathname).toBe("/licitaciones/prop-1/expedientes");
    expect(lastUrl().searchParams.get("limit")).toBe("25");
    expect(lastUrl().searchParams.get("offset")).toBe("0");
    expect(text()).toContain("Expediente t1");
    expect(text()).toContain("4 de 10");
    expect(text()).toContain("Ámbar");
    expect(text()).toContain("Presentada");
    const hrefs = [...rendered!.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/licitaciones/demo/convocatorias/t1");
    expect(hrefs).toContain("/licitaciones/demo/convocatorias/t1/requisitos");
    expect(hrefs).toContain("/licitaciones/demo/convocatorias/t1/propuesta-tecnica");
    expect(hrefs).toContain("/licitaciones/demo/convocatorias/t1/cierre");
    expect(hrefs).toContain("/licitaciones/demo/convocatorias/t1/sala-guerra");
  });

  it("el filtro de estado viaja al servidor y regresa a la pagina 1", async () => {
    stub([FILA("t1")]);
    mount();
    await settle();
    await act(async () => {
      changeValue(rendered!.container.querySelector("#exp-estado") as HTMLSelectElement, "submitted");
    });
    await settle();
    expect(lastUrl().searchParams.get("status")).toBe("submitted");
    expect(lastUrl().searchParams.get("offset")).toBe("0");
  });

  it("sin expedientes: estado vacio honesto; con error: mensaje y reintento", async () => {
    stub([], 0);
    mount();
    await settle();
    expect(text()).toContain("Todavía no hay convocatorias en Go, en curso o presentadas.");
    rendered!.unmount();
    stub([], 0, false);
    mount();
    await settle();
    expect(rendered!.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("es de solo lectura: toda llamada es GET", async () => {
    stub([FILA("t1")]);
    mount();
    await settle();
    expect(fetchMock.mock.calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === "GET")).toBe(true);
  });
});
