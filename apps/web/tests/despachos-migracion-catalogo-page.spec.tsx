// @vitest-environment jsdom
//
// UNI-C despachos (.1/.2) -- Migracion de catalogo: un solo h1, la clasificacion abre un FormDialog con labels y cada decision
// (aprobar, rechazar, editar) pasa por useConfirm: Cancelar nunca llama a la API.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MigracionCatalogoPage } from "../src/verticals/despachos/pages/MigracionCatalogo.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { dialogoConfirm, pulsarEnDialogo } from "./test-utils/confirm.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role: "contador", staffFullName: "Contadora", staffEmail: "c@example.com" };
const MAPEO = { id: "m1", origenCuentaId: "o1", destinoCuentaId: "d1", tipoMatch: "fuzzy", score: 80, estado: "pendiente", aprobadoPor: null, aprobadoEn: null, nota: null, estrategiaConciliacionSaldos: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() } as unknown as Response;
}
function stubFetch() {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/migracion-catalogo/mapeos")) return json({ mapeos: [MAPEO] });
    if (method === "POST" && /\/mapeos\/m1\/(aprobar|rechazar|editar)$/.test(url)) return json({ ...MAPEO, estado: "aprobado" });
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function montar() {
  rendered = renderComponent(<MigracionCatalogoPage {...CTX} />);
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement;
const escrituras = (accion: string) => fetchMock.mock.calls.filter(([u, i]) => (i as RequestInit | undefined)?.method === "POST" && String(u).endsWith(`/mapeos/m1/${accion}`));
async function pulsar(texto: string) {
  await act(async () => {
    click(boton(texto));
    await flushMicrotasks();
  });
}

describe("MigracionCatalogoPage -- estructura y confirmaciones", () => {
  it("un solo h1 y todo control de la fila tiene label asociado", async () => {
    stubFetch();
    await montar();
    expect(rendered!.container.querySelectorAll("h1")).toHaveLength(1);
    for (const c of rendered!.container.querySelectorAll("input,select,textarea")) {
      const id = c.getAttribute("id");
      expect(id !== null && rendered!.container.querySelector(`label[for="${id}"]`) !== null).toBe(true);
    }
  });

  it.each([
    ["Aprobar", "aprobar", "Aprobar"],
    ["Rechazar", "rechazar", "Rechazar"],
    ["Editar", "editar", "Editar"],
  ])("%s: Cancelar no llama a la API; confirmar si", async (boton_, accion, confirmar) => {
    stubFetch();
    await montar();
    // Rechazar y editar exigen nota; editar exige ademas la cuenta destino corregida.
    await act(async () => {
      changeValue(rendered!.container.querySelector("#migracion-nota-m1") as HTMLInputElement, "Motivo de prueba");
      changeValue(rendered!.container.querySelector("#migracion-destino-m1") as HTMLInputElement, "d2");
      await flushMicrotasks();
    });
    await pulsar(boton_);
    expect(dialogoConfirm()).not.toBeNull();
    expect(escrituras(accion)).toHaveLength(0);
    await pulsarEnDialogo("Cancelar");
    expect(escrituras(accion)).toHaveLength(0);
    await pulsar(boton_);
    await pulsarEnDialogo(confirmar);
    expect(escrituras(accion)).toHaveLength(1);
  });

  it("clasificar abre un FormDialog con los dos catalogos etiquetados", async () => {
    stubFetch();
    await montar();
    await pulsar("Clasificar catálogo");
    const dlg = document.body.querySelector('[role="dialog"]')!;
    for (const id of ["catalogo-origen", "catalogo-destino"]) {
      expect(dlg.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
  });
});
