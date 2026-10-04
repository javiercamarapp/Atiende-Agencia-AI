// @vitest-environment jsdom
//
// UNI-C despachos (.2): rechazar un CFDI en la cola de revision humana es irreversible -> useConfirm.
// Cancelar (o Escape) nunca llama a la API; confirmar manda POST .../revisiones/:id/rechazar. Aprobar no pide confirmacion.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CfdiPage } from "../src/verticals/despachos/pages/Cfdi.tsx";
import { CfdiDetallePage } from "../src/verticals/despachos/pages/CfdiDetalle.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { pulsarEnDialogo, dialogoConfirm } from "./test-utils/confirm.ts";
import { click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "contador", staffFullName: "Contadora", staffEmail: "c@example.com" };
const INVOICE = {
  id: "inv1", folioFiscal: "AAAA1111-BBBB-2222-CCCC-DDDDEEEEFFFF", tipo: "I", rfcEmisor: "AAA010101AAA", rfcReceptor: "BBB020202BBB", emisorNombre: "Proveedor SA", subtotal: 1000, total: 1160, iva: 160, descuento: 0,
  categoria: "gasto_operativo", valido: false, issues: [], warnings: [], requiereRevisionHumana: true, diot: { proveedoresReportables: [], reportable: false }, creadoEn: "2026-03-01T00:00:00Z", estadoSat: "pendiente", estadoSatVerificadoEn: null,
};
const REVISION = { id: "rev1", invoiceId: "inv1", motivo: "Total no cuadra", estado: "pendiente", notaDecision: null, resueltoPor: null, resueltoEn: null, creadoEn: "2026-03-02T00:00:00Z" };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, headers: new Headers() } as unknown as Response;
}
function stubFetch() {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && /\/revisiones\/rev1\/(rechazar|aprobar)$/.test(url)) return json({ ...REVISION, estado: "rechazado" });
    if (url.endsWith("/revisiones")) return json([REVISION]);
    if (url.endsWith("/cfdi/inv1")) return json(INVOICE);
    if (url.includes("/cfdi/efos") || url.includes("efos")) return json({ lista: { periodo: null }, alertas: [], disponible: false });
    if (url.includes("/cfdi")) return json([INVOICE]);
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const posts = (accion: string) => fetchMock.mock.calls.filter(([u, i]) => (i as RequestInit | undefined)?.method === "POST" && String(u).endsWith(`/revisiones/rev1/${accion}`));
const botonPagina = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement;

async function pulsar(texto: string) {
  await act(async () => {
    click(botonPagina(texto));
    await flushMicrotasks();
  });
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const montajes: ReadonlyArray<readonly [string, () => RenderedComponent]> = [
  ["lista de CFDI (Cfdi.tsx)", () => renderComponent(<MemoryRouter><CfdiPage {...CTX} /></MemoryRouter>)],
  [
    "ficha del CFDI (CfdiDetalle.tsx)",
    () =>
      renderComponent(
        <MemoryRouter initialEntries={["/cfdi/inv1"]}>
          <Routes>
            <Route path="/cfdi/:invoiceId" element={<CfdiDetallePage {...CTX} />} />
          </Routes>
        </MemoryRouter>,
      ),
  ],
];

describe.each(montajes)("rechazar CFDI pide confirmacion -- %s", (_nombre, montar) => {
  it("el primer clic solo abre el dialogo; Cancelar no llama a la API", async () => {
    stubFetch();
    rendered = montar();
    await esperar();
    await pulsar("Rechazar");
    expect(dialogoConfirm()).not.toBeNull();
    expect(posts("rechazar")).toHaveLength(0);
    await pulsarEnDialogo("Cancelar");
    expect(posts("rechazar")).toHaveLength(0);
    expect(dialogoConfirm()).toBeNull();
  });

  it("Escape tampoco ejecuta", async () => {
    stubFetch();
    rendered = montar();
    await esperar();
    await pulsar("Rechazar");
    await act(async () => {
      keydown(dialogoConfirm()!, "Escape");
      await flushMicrotasks();
    });
    expect(posts("rechazar")).toHaveLength(0);
  });

  it("confirmar manda POST .../rechazar una sola vez", async () => {
    stubFetch();
    rendered = montar();
    await esperar();
    await pulsar("Rechazar");
    await pulsarEnDialogo("Rechazar");
    expect(posts("rechazar")).toHaveLength(1);
  });

  it("aprobar no pide confirmacion", async () => {
    stubFetch();
    rendered = montar();
    await esperar();
    await pulsar("Aprobar");
    await esperar();
    expect(dialogoConfirm()).toBeNull();
    expect(posts("aprobar")).toHaveLength(1);
  });
});
