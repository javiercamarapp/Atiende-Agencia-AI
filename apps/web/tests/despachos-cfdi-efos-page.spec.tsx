// @vitest-environment jsdom
//
// Alertas EFOS 69-B de <CfdiPage /> de despachos: el listado de alertas es un DataTable (emisor con enlace al CFDI,
// RFC, total e insignia Definitivo/Presunto). `fetch` global mockeado por ruta real.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CfdiPage } from "../src/verticals/despachos/pages/Cfdi.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "contador", staffFullName: "Contador", staffEmail: "c@example.com" };

const ALERTAS = [
  { invoiceId: "inv-1", folioFiscal: "AAAA-1", rfcEmisor: "AAA010101AAA", emisorNombre: "Emisor Uno SA", fecha: "2026-09-01", total: 1160, situacion: "definitivo", periodoLista: "2026-09" },
  { invoiceId: "inv-2", folioFiscal: "BBBB-2", rfcEmisor: "BBB010101BBB", emisorNombre: null, fecha: "2026-09-02", total: 580, situacion: "presunto", periodoLista: "2026-09" },
];

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function cargar(efos: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/efos/alertas")) return ok(efos);
      if (url.endsWith("/revisiones")) return ok([]);
      if (url.includes("/cfdi")) return ok([]);
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
  rendered = renderComponent(
    <MemoryRouter>
      <CfdiPage {...CTX} />
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("CfdiPage (despachos): alertas EFOS 69-B", () => {
  it("lista las alertas en una tabla con enlace al CFDI, RFC, total y situacion", async () => {
    await cargar({ lista: { estado: "disponible", periodo: "2026-09", filas: 10, ingestadoEn: null }, estado: "disponible", alertas: ALERTAS });
    const tabla = rendered!.container.querySelector('table[aria-label="Alertas EFOS 69-B"]');
    expect(tabla).not.toBeNull();
    const texto = tabla!.textContent!;
    expect(texto).toContain("Emisor Uno SA");
    expect(texto).toContain("BBB010101BBB");
    expect(texto).toContain("Definitivo");
    expect(texto).toContain("Presunto");
    expect(tabla!.querySelector('a[href="/despachos/demo/cfdi/inv-1"]')).not.toBeNull();
  });

  it("sin alertas no pinta tabla", async () => {
    await cargar({ lista: { estado: "disponible", periodo: "2026-09", filas: 10, ingestadoEn: null }, estado: "disponible", alertas: [] });
    expect(rendered!.container.querySelector('table[aria-label="Alertas EFOS 69-B"]')).toBeNull();
  });
});
