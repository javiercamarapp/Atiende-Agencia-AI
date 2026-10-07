// @vitest-environment jsdom
//
// paridad3 L-P3-13: Convocatorias pagina en el SERVIDOR (limit/offset + total real), busca/filtra en el servidor y puntua solo la
// pagina visible. Con 251 convocatorias la pagina 2 existe y el pie dice "de 251"; antes la lista se cortaba en 50 sin aviso.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvocatoriasPage } from "../src/verticals/licitaciones/pages/Convocatorias.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "viewer", staffFullName: "Ana", staffEmail: "ana@example.com" };
const TOTAL = 251;
const TODAS = Array.from({ length: TOTAL }, (_, i) => ({
  id: `t${String(i).padStart(3, "0")}`,
  organizationId: "org",
  title: `Convocatoria ${i}`,
  submissionDeadline: null,
  updatedAt: "2026-01-01T00:00:00Z",
  source: i % 2 === 0 ? "manual" : "nl_ocds",
  externalId: `FOLIO-${i}`,
  contractingBody: "IMSS",
  cpvCodes: [],
  budgetAmount: null,
  currency: "MXN",
  state: null,
  procedureTypeRaw: null,
  status: "discovered",
}));

function stubApi() {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const path = u.pathname.replace("/licitaciones/prop-1", "");
    if (path === "/sources") return json({ connectors: [{ id: "manual", kind: "manual", label: "Alta manual" }, { id: "nl_ocds", kind: "automated", label: "NL OCDS" }] });
    if (path === "/tenders/matching") {
      const ids = (u.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      return json({ results: ids.map((tenderId) => ({ tenderId, score: 42, criteria: [], eligibility: { status: "cumple", criteria: [] } })) });
    }
    if (path === "/tenders") {
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      const source = u.searchParams.get("source");
      const filtradas = TODAS.filter((t) => (!q || t.title.toLowerCase().includes(q) || t.externalId.toLowerCase().includes(q)) && (!source || t.source === source));
      const limit = Number(u.searchParams.get("limit") ?? 50);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const items = filtradas.slice(offset, offset + limit);
      const headers: Record<string, string> = { "x-total-count": String(filtradas.length) };
      if (offset + items.length < filtradas.length) headers["x-next-offset"] = String(offset + items.length);
      return json({ tenders: items }, headers);
    }
    return new Response(JSON.stringify({ message: `sin ruta ${path}` }), { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return urls;
}

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

async function settle(ms = 0) {
  await act(async () => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

function mount() {
  rendered = renderComponent(
    <MemoryRouter>
      <ConvocatoriasPage {...CTX} />
    </MemoryRouter>,
  );
}

const btn = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement;
const filas = () => [...rendered!.container.querySelectorAll("tbody tr")];
const estado = () => rendered!.container.querySelector("[role=status]")?.textContent ?? "";

describe("Convocatorias con paginacion de servidor", () => {
  it("con 251 convocatorias muestra 25 por pagina, 'de 251' y la pagina 2 existe (antes se cortaba en 50 sin aviso)", async () => {
    const urls = stubApi();
    mount();
    await settle();
    expect(filas()).toHaveLength(25);
    expect(estado()).toContain("Mostrando 1–25 de 251");
    expect(rendered!.container.textContent).toContain("Página 1 de 11");
    const primera = new URL(urls.find((u) => new URL(u).pathname.endsWith("/tenders"))!);
    expect(primera.searchParams.get("limit")).toBe("25");
    expect(primera.searchParams.get("offset")).toBe("0");

    click(btn("Siguiente"));
    await settle();
    expect(estado()).toContain("Mostrando 26–50 de 251");
    expect(rendered!.container.textContent).toContain("Convocatoria 25");
    const segunda = new URL([...urls].reverse().find((u) => new URL(u).pathname.endsWith("/tenders"))!);
    expect(segunda.searchParams.get("offset")).toBe("25");
  });

  it("el score se pide solo para los ids de la pagina visible (no para toda la organizacion)", async () => {
    const urls = stubApi();
    mount();
    await settle();
    const matching = new URL(urls.find((u) => new URL(u).pathname.endsWith("/tenders/matching"))!);
    expect(matching.searchParams.get("ids")!.split(",")).toHaveLength(25);
    expect(rendered!.container.textContent).toContain("Cumple");
  });

  it("la busqueda y el filtro de fuente se hacen en el servidor y vuelven a la pagina 1 con el total filtrado", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const urls = stubApi();
    mount();
    await settle();
    click(btn("Siguiente"));
    await settle();

    const buscar = rendered!.container.querySelector("#conv-buscar") as HTMLInputElement;
    changeValue(buscar, "FOLIO-24");
    await settle(400);
    const ultima = new URL([...urls].reverse().find((u) => new URL(u).pathname.endsWith("/tenders"))!);
    expect(ultima.searchParams.get("q")).toBe("FOLIO-24");
    expect(ultima.searchParams.get("offset")).toBe("0");
    expect(estado()).toContain("de 11"); // FOLIO-24, FOLIO-240..249

    changeValue(rendered!.container.querySelector("#conv-fuente") as unknown as HTMLInputElement, "nl_ocds");
    await settle();
    const conFuente = new URL([...urls].reverse().find((u) => new URL(u).pathname.endsWith("/tenders"))!);
    expect(conFuente.searchParams.get("source")).toBe("nl_ocds");
    expect(conFuente.searchParams.get("q")).toBe("FOLIO-24");
  });

  it("sin coincidencias dice que ninguna coincide (no 'todavia no hay ninguna')", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi();
    mount();
    await settle();
    changeValue(rendered!.container.querySelector("#conv-buscar") as HTMLInputElement, "zzzz");
    await settle(400);
    expect(rendered!.container.textContent).toContain("Ninguna convocatoria coincide con la búsqueda.");
  });
});
