// @vitest-environment jsdom
//
// L-29 -- pestana "Bitacora" de la convocatoria: DataTable con eventos reales (GET .../bitacora), filtros por
// origen y rango (la query viaja al servidor), paginacion del servidor, estados vacio/error/'sala no disponible'
// y cableado de la pestana dentro de la ficha de la convocatoria. Solo lectura: ninguna llamada escribe.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { BitacoraConvocatoria } from "../src/verticals/licitaciones/components/BitacoraConvocatoria.tsx";
import { ConvocatoriaDetallePage } from "../src/verticals/licitaciones/pages/ConvocatoriaDetalle.tsx";
import type { BitacoraEvento, BitacoraPagina } from "../src/verticals/licitaciones/lib/sala-guerra-client.ts";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const EV = (id: string, over: Partial<BitacoraEvento> = {}): BitacoraEvento => ({
  id,
  fuente: "sala_guerra",
  accion: "comentario",
  descripcion: `Comentario en la sala de guerra: ${id}`,
  at: "2026-10-03T16:00:00.000Z",
  actor: { esTuyo: false, rol: null },
  ...over,
});
const PAGINA = (items: BitacoraEvento[], over: Partial<BitacoraPagina> = {}): BitacoraPagina => ({ available: true, items, total: items.length, nextOffset: null, limit: 25, offset: 0, ...over });

const BASE = "https://api.test/licitaciones/prop-1/tenders/t1/bitacora";
function stub(responder: (query: URLSearchParams) => { ok?: boolean; status?: number; body: unknown }) {
  fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url);
    const r = responder(u.searchParams);
    return { ok: r.ok ?? true, status: r.status ?? (r.ok === false ? 500 : 200), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
function mount() {
  rendered = renderComponent(<BitacoraConvocatoria apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" tenderId="t1" />);
}
const text = () => rendered!.container.textContent ?? "";
const lastQuery = () => new URL(String(fetchMock.mock.calls.at(-1)![0])).searchParams;
const btn = (label: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

describe("BitacoraConvocatoria (L-29)", () => {
  it("lista los eventos reales del servidor con origen, fecha en America/Mexico_City y 'quien' sin identificar a nadie", async () => {
    stub(() => ({ body: PAGINA([EV("a", { actor: { esTuyo: true, rol: "writer" } }), EV("b", { fuente: "aprobacion", descripcion: "Aprobación económica (2/2) del expediente.", actor: { esTuyo: false, rol: "analyst" } }), EV("c", { fuente: "presentacion", actor: { esTuyo: null, rol: null } })]) }));
    mount();
    await settle();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}?limit=25&offset=0`);
    expect(text()).toContain("Comentario en la sala de guerra: a");
    expect(text()).toContain("Aprobación económica (2/2) del expediente.");
    expect(text()).toContain("Tú (writer)");
    expect(text()).toContain("Otra persona (analyst)");
    expect(text()).toContain("Sistema");
    expect(text()).toContain("Aprobaciones");
    expect(text()).toContain("3 oct 2026");
    expect(text()).toContain("1–3 de 3");
  });

  it("vacio honesto sin filtros y con filtros", async () => {
    stub(() => ({ body: PAGINA([]) }));
    mount();
    await settle();
    expect(text()).toContain("Esta convocatoria todavía no tiene eventos.");
    const sel = rendered!.container.querySelector("#bitacora-fuente") as HTMLSelectElement;
    changeValue(sel, "go_no_go");
    await settle();
    expect(text()).toContain("Ningún evento coincide con los filtros.");
  });

  it("los filtros viajan al servidor (origen y rango como instantes ISO) y reinician la pagina; 'Limpiar filtros' los quita", async () => {
    stub(() => ({ body: PAGINA([EV("a")]) }));
    mount();
    await settle();
    changeValue(rendered!.container.querySelector("#bitacora-fuente") as HTMLSelectElement, "aprobacion");
    await settle();
    expect(lastQuery().get("fuente")).toBe("aprobacion");
    changeValue(rendered!.container.querySelector("#bitacora-desde") as HTMLInputElement, "2026-10-01");
    await settle();
    changeValue(rendered!.container.querySelector("#bitacora-hasta") as HTMLInputElement, "2026-10-03");
    await settle();
    const q = lastQuery();
    expect(q.get("fuente")).toBe("aprobacion");
    expect(Date.parse(q.get("desde")!)).toBe(new Date("2026-10-01T00:00:00.000").getTime());
    expect(Date.parse(q.get("hasta")!)).toBe(new Date("2026-10-03T23:59:59.999").getTime());
    expect(q.get("offset")).toBe("0");
    await act(async () => click(btn("Limpiar filtros")));
    await settle();
    expect(lastQuery().has("fuente")).toBe(false);
    expect(lastQuery().has("desde")).toBe(false);
  });

  it("pagina con el nextOffset del servidor: Siguiente / Anterior piden la pagina correcta y se deshabilitan en los extremos", async () => {
    stub((q) => {
      const offset = Number(q.get("offset"));
      return { body: offset === 0 ? PAGINA([EV("p1")], { total: 30, nextOffset: 25, offset: 0 }) : PAGINA([EV("p2")], { total: 30, nextOffset: null, offset: 25 }) };
    });
    mount();
    await settle();
    expect(text()).toContain("1–1 de 30");
    expect(btn("Anterior").disabled).toBe(true);
    await act(async () => click(btn("Siguiente")));
    await settle();
    expect(lastQuery().get("offset")).toBe("25");
    expect(text()).toContain("Comentario en la sala de guerra: p2");
    expect(btn("Siguiente").disabled).toBe(true);
    await act(async () => click(btn("Anterior")));
    await settle();
    expect(lastQuery().get("offset")).toBe("0");
  });

  it("base sin la migracion 029: lo dice y sigue mostrando las demas fuentes", async () => {
    stub(() => ({ body: PAGINA([EV("g", { fuente: "go_no_go", descripcion: "Decisión Go registrada (2 motivo(s))." })], { available: false }) }));
    mount();
    await settle();
    expect(text()).toContain("falta la migración 029");
    expect(text()).toContain("Decisión Go registrada");
  });

  it("error de lectura: mensaje y reintento real; solo hay GET", async () => {
    let n = 0;
    stub(() => (n++ === 0 ? { ok: false, status: 500, body: { message: "Falla del servidor." } } : { body: PAGINA([EV("a")]) }));
    mount();
    await settle();
    expect(text()).toContain("Falla del servidor.");
    const retry = [...rendered!.container.querySelectorAll("button")].find((b) => /reintentar/i.test(b.textContent ?? ""))!;
    await act(async () => click(retry));
    await settle();
    expect(text()).toContain("Comentario en la sala de guerra: a");
    for (const call of fetchMock.mock.calls) expect((call[1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });
});

describe("pestana Bitacora dentro de la ficha de la convocatoria", () => {
  const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "viewer", staffFullName: "Ana", staffEmail: "ana@example.com" };
  const TENDER = { id: "t1", organizationId: "o", title: "Compra", submissionDeadline: null, updatedAt: "2026-09-01T00:00:00.000Z", source: "manual", externalId: null, contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", state: null, procedureTypeRaw: null, status: "discovered" };

  it("solo pide la bitacora al abrir la pestana (no antes) y la muestra", async () => {
    fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      let body: unknown = null;
      if (/\/tenders\/t1$/.test(u)) body = TENDER;
      else if (u.includes("/tenders/t1/bitacora")) body = PAGINA([EV("zz")]);
      else if (u.endsWith("/matching")) body = { tenderId: "t1", score: 70, criteria: [], eligibility: { status: "elegible", criteria: [] } };
      else if (u.endsWith("/checklist")) body = { overallStatus: "verde", items: [] };
      else if (u.endsWith("/resolution")) body = { resolutions: [] };
      else if (u.endsWith("/go-no-go")) body = { decisions: [] };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/licitaciones/demo/convocatorias/t1"]}>
        <Routes>
          <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId" element={<ConvocatoriaDetallePage {...CTX} />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/bitacora"))).toBe(false);
    const trigger = [...rendered!.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Bitácora")!;
    expect(trigger).toBeTruthy();
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/tenders/t1/bitacora"))).toBe(true);
    expect(text()).toContain("Comentario en la sala de guerra: zz");
  });
});
