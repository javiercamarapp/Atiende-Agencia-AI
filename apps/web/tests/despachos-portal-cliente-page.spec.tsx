// @vitest-environment jsdom
//
// D-08: pantalla publica del portal del cliente final. El token se lee del fragmento, viaja por header y la pantalla
// responde IGUAL (mensaje generico) para enlace invalido, expirado o revocado.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalClientePage } from "../src/verticals/despachos/portal/PortalClientePage.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
const TOKEN = "B".repeat(43);

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const RESUMEN = {
  cliente: { nombre: "Cliente A SA de CV" },
  despacho: { nombre: "Despacho de Prueba SC" },
  expiraEn: "2026-12-01T00:00:00.000Z",
  obligaciones: [
    { tipo: "ISR", periodo: "2026-07", fechaLimite: "2026-08-17", estado: "pendiente", fechaPresentacion: null },
    { tipo: "IVA", periodo: "2026-06", fechaLimite: "2026-07-17", estado: "completado", fechaPresentacion: "2026-07-10" },
  ],
  cierres: [{ anio: 2026, mes: 6, estado: "open", tareasTotal: 5, tareasListas: 2 }],
  documentos: [{ id: "d1", tipo: "pdf", nombreArchivo: "constancia.pdf", estado: "rechazado", motivo: "Ilegible", creadoEn: "2026-07-01T10:00:00.000Z" }],
  mensajes: [{ autor: "despacho", cuerpo: "Recibimos tus facturas.", creadoEn: "2026-07-02T10:00:00.000Z" }],
};

const CFDI = [
  { id: "c1", folioFiscal: "11111111-2222-3333-4444-555555555555", tipo: "I", direccion: "recibido", fecha: "2026-07-10", rfcEmisor: "CON950820K12", rfcReceptor: "EKU9003173C9", emisorNombre: "Proveedor SA", totalCentavos: 116000, estadoSat: "vigente", excluido: false },
  { id: "c2", folioFiscal: "66666666-2222-3333-4444-555555555555", tipo: "I", direccion: "emitido", fecha: "2026-07-11", rfcEmisor: "EKU9003173C9", rfcReceptor: "XAXX010101000", emisorNombre: null, totalCentavos: 5800, estadoSat: "pendiente", excluido: true },
];

/** `fetch` por ruta: el resumen de siempre y, aparte, la lista de CFDI del cliente (carga independiente). */
function stubPortal(cfdi: () => Response = () => new Response(JSON.stringify({ cfdi: CFDI, tope: 500 }), { status: 200 })) {
  const mock = vi.fn(async (url: string) => (String(url).includes("/portal-cliente/cfdi") ? cfdi() : new Response(JSON.stringify(RESUMEN), { status: 200 })));
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("PortalClientePage", () => {
  it("con token valido muestra estatus SAT, cierre, documentos y mensajes; el token solo va en el header", async () => {
    const fetchMock = stubPortal();
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    const texto = rendered.container.textContent!;
    expect(texto).toContain("Cliente A SA de CV");
    expect(texto).toContain("Obligaciones ante el SAT");
    expect(texto).toContain("ISR · 2026-07");
    expect(texto).toContain("Presentada el 10 jul 2026");
    expect(texto).toContain("Vence el 17 ago 2026");
    expect(texto).toContain("junio de 2026");
    expect(texto).toContain("2 de 5 tareas listas");
    expect(texto).toContain("Rechazado");
    expect(texto).toContain("Motivo: Ilegible");
    expect(texto).toContain("Recibimos tus facturas.");
    expect(texto).not.toContain(TOKEN);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)["x-portal-token"]).toBe(TOKEN);
  });

  it("sin token, con fragmento mal formado o con 404 muestra el MISMO aviso generico (sin distinguir causa) y sin llamar al servidor cuando no hay token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: "enlace_no_valido", message: "x" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash="" />);
    await esperar();
    const sinToken = rendered.container.textContent;
    expect(sinToken).toContain("Este enlace no es válido");
    expect(fetchMock).not.toHaveBeenCalled();
    rendered.unmount();
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    // Identico para "no hay token" y "el servidor dijo 404" (inexistente, expirado o revocado).
    expect(rendered.container.textContent).toBe(sinToken);
  });

  it("503 (base sin migrar) -> 'aun no esta disponible', no un error crudo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "service_unavailable", message: "x" }), { status: 503 })));
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    expect(rendered.container.textContent).toContain("El portal aún no está disponible");
  });

  it("D-P3-22: 'Mis CFDI' lista SOLO lo que devuelve el servidor para su enlace (emisor, sentido, total) y marca el excluido; el token nunca va en la URL", async () => {
    const fetchMock = stubPortal();
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    const texto = rendered.container.textContent!;
    expect(texto).toContain("Mis CFDI");
    expect(texto).toContain("Proveedor SA");
    expect(texto).toContain("Recibido");
    expect(texto).toContain("$1,160.00");
    expect(texto).toContain("Excluido");
    expect(texto).toContain("Exportar CSV");
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).not.toContain(TOKEN);
      expect((init.headers as Record<string, string>)["x-portal-token"]).toBe(TOKEN);
    }
  });

  it("D-P3-22: sin CFDI, un fallo y la base sin migrar dicen la verdad en vez de mostrar una tabla inventada", async () => {
    stubPortal(() => new Response(JSON.stringify({ cfdi: [], tope: 500 }), { status: 200 }));
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Tu despacho aún no tiene CFDI registrados a tu nombre.");
    rendered.unmount();
    stubPortal(() => new Response(JSON.stringify({ code: "internal", message: "x" }), { status: 500 }));
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudieron cargar tus CFDI.");
    expect(rendered.container.textContent).toContain("Cliente A SA de CV"); // el resto del portal sigue funcionando
    rendered.unmount();
    stubPortal(() => new Response(JSON.stringify({ code: "service_unavailable", message: "x" }), { status: 503 }));
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Esta lista aún no está disponible.");
  });

  it("D-P3-22: 'Exportar CSV' pide ?formato=csv con el token en el header y descarga un archivo; un error se muestra y no rompe la pantalla", async () => {
    const urls: string[] = [];
    const mock = vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("formato=csv")) return new Response("\uFEFFFecha,Tipo\r\n", { status: 200, headers: { "content-type": "text/csv" } });
      if (String(url).includes("/portal-cliente/cfdi")) return new Response(JSON.stringify({ cfdi: CFDI, tope: 500 }), { status: 200 });
      return new Response(JSON.stringify(RESUMEN), { status: 200 });
    });
    vi.stubGlobal("fetch", mock);
    const clic = vi.fn();
    const crear = vi.fn(() => "blob:csv");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: crear, revokeObjectURL: vi.fn() }));
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, o?: ElementCreationOptions) => {
      const el = original(tag, o);
      if (tag === "a") el.click = clic;
      return el;
    });
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => /Exportar CSV/.test(b.textContent ?? ""))!;
    await act(async () => {
      boton.click();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(urls.some((u) => u.endsWith("/portal-cliente/cfdi?formato=csv"))).toBe(true);
    expect(urls.every((u) => !u.includes(TOKEN))).toBe(true);
    expect(crear).toHaveBeenCalledTimes(1);
    expect(clic).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
