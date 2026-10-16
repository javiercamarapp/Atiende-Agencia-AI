// @vitest-environment jsdom
//
// Portal del cliente del lado del DESPACHO (pages/PortalCliente.tsx) tras migrar enlaces y documentos recibidos a DataTable
// (UNI-C-despachos.3): los datos reales llegan a las tablas con nombre accesible, las acciones por fila pegan al endpoint real
// segun rol y estado, y los vacios son honestos. `fetch` global mockeado por las rutas reales de portal-cliente-client.ts.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalClientePage } from "../src/verticals/despachos/pages/PortalCliente.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "contador",
  staffFullName: "Contadora Demo",
  staffEmail: "contadora@example.com",
};

const FUTURO = new Date(Date.now() + 30 * 86_400_000).toISOString();
const ENLACE_VIGENTE = { id: "enl-1", etiqueta: "Administracion del cliente", creadoEn: "2026-07-01T10:00:00.000Z", expiraEn: FUTURO, revocadoEn: null, ultimoUsoEn: null, usos: 0 };
const ENLACE_REVOCADO = { id: "enl-2", etiqueta: "Enlace viejo", creadoEn: "2026-06-01T10:00:00.000Z", expiraEn: FUTURO, revocadoEn: "2026-06-02T10:00:00.000Z", ultimoUsoEn: null, usos: 1 };
const DOC_RECIBIDO = {
  id: "doc-1",
  tipo: "cfdi_xml",
  nombreArchivo: "factura-julio.xml",
  tamanoBytes: 4096,
  estado: "recibido",
  motivo: null,
  resumen: { folio_fiscal: "ABCDEF12-0000-0000-0000-000000000000", total: "1160.00" },
  invoiceId: null,
  creadoEn: "2026-07-03T10:00:00.000Z",
};
const DOC_RECHAZADO = { ...DOC_RECIBIDO, id: "doc-2", tipo: "pdf", nombreArchivo: "constancia.pdf", estado: "rechazado", motivo: "Ilegible", resumen: {} };

function stubFetch(opts: { enlaces?: unknown[]; documentos?: unknown[] } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/portal-cliente/enlaces")) return jsonResponse({ disponible: true, enlaces: opts.enlaces ?? [] });
    if (method === "GET" && url.endsWith("/portal-cliente/documentos")) return jsonResponse({ disponible: true, documentos: opts.documentos ?? [] });
    if (method === "GET" && url.endsWith("/portal-cliente/mensajes")) return jsonResponse({ disponible: true, mensajes: [] });
    if (method === "POST" && url.endsWith("/enlaces/enl-1/revocar")) return jsonResponse({ revocado: true });
    if (method === "POST" && url.endsWith("/documentos/doc-1/aceptar")) return jsonResponse({ estado: "aceptado", invoiceId: null, cfdi: null });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const botones = (root: HTMLElement, texto: string) => Array.from(root.querySelectorAll("button")).filter((b) => b.textContent?.includes(texto));

describe("PortalClientePage del despacho con DataTable", () => {
  it("enlaces y documentos recibidos son tablas con nombre accesible y datos reales", async () => {
    stubFetch({ enlaces: [ENLACE_VIGENTE, ENLACE_REVOCADO], documentos: [DOC_RECIBIDO, DOC_RECHAZADO] });
    rendered = renderComponent(<PortalClientePage {...CTX} />);
    await esperar();
    const tablas = Array.from(rendered.container.querySelectorAll("table"));
    expect(tablas.map((t) => t.getAttribute("aria-label"))).toEqual(["Enlaces del cliente", "Documentos recibidos"]);
    const texto = rendered.container.textContent!;
    expect(texto).toContain("Administracion del cliente");
    expect(texto).toContain("Vigente");
    expect(texto).toContain("Revocado");
    expect(texto).toContain("factura-julio.xml");
    expect(texto).toContain("UUID ABCDEF12");
    expect(texto).toContain("4 KB");
    expect(texto).toContain("Motivo: Ilegible");
    // Solo el enlace vigente se puede revocar; solo el documento recibido se puede aceptar o rechazar.
    expect(botones(rendered.container, "Revocar")).toHaveLength(1);
    expect(botones(rendered.container, "Aceptar")).toHaveLength(1);
    expect(botones(rendered.container, "Rechazar")).toHaveLength(1);
    expect(botones(rendered.container, "Descargar")).toHaveLength(2);
  });

  it("revocar y aceptar pegan al endpoint real de la fila", async () => {
    stubFetch({ enlaces: [ENLACE_VIGENTE], documentos: [DOC_RECIBIDO] });
    rendered = renderComponent(<PortalClientePage {...CTX} />);
    await esperar();
    await act(async () => {
      botones(rendered!.container, "Revocar")[0]!.click();
      await flushMicrotasks();
    });
    await esperar();
    await act(async () => {
      botones(rendered!.container, "Aceptar")[0]!.click();
      await flushMicrotasks();
    });
    await esperar();
    const llamadas = fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${String(c[0])}`);
    expect(llamadas).toContain("POST https://api.test/despachos/prop-1/portal-cliente/enlaces/enl-1/revocar");
    expect(llamadas).toContain("POST https://api.test/despachos/prop-1/portal-cliente/documentos/doc-1/aceptar");
  });

  it("un rol de solo lectura ve las tablas sin acciones de gestion y los vacios son honestos", async () => {
    stubFetch({ enlaces: [ENLACE_VIGENTE], documentos: [DOC_RECIBIDO] });
    rendered = renderComponent(<PortalClientePage {...CTX} role="readonly" />);
    await esperar();
    expect(botones(rendered.container, "Revocar")).toHaveLength(0);
    expect(botones(rendered.container, "Aceptar")).toHaveLength(0);
    expect(botones(rendered.container, "Descargar")).toHaveLength(1);
    rendered.unmount();
    stubFetch();
    rendered = renderComponent(<PortalClientePage {...CTX} />);
    await esperar();
    expect(rendered.container.querySelectorAll("table")).toHaveLength(0);
    expect(rendered.container.textContent).toContain("Aún no has creado enlaces para este cliente.");
    expect(rendered.container.textContent).toContain("No hay documentos recibidos.");
  });
});
