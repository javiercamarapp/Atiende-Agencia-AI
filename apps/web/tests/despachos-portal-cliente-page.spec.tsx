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

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("PortalClientePage", () => {
  it("con token valido muestra estatus SAT, cierre, documentos y mensajes; el token solo va en el header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESUMEN), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
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
});
