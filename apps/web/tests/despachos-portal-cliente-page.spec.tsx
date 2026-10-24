// @vitest-environment jsdom
//
// D-08: pantalla publica del portal del cliente final. El token se lee del fragmento, viaja por header y la pantalla
// responde IGUAL (mensaje generico) para enlace invalido, expirado o revocado.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalClientePage } from "../src/verticals/despachos/portal/PortalClientePage.tsx";
import { click as clickEl, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

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

// paridad3 D-31 / D-P3-21 -- solicitudes de documentos (subir PARA un renglon) y reportes del cierre en el portal del cliente.
describe("PortalClientePage -- solicitudes y reportes del cierre", () => {
  const SOLICITUDES = [
    {
      id: "s1", ejercicio: 2026, mes: 6, estado: "abierta",
      renglones: [
        { id: "r1", tipo: "estado_cuenta", etiqueta: "Estado de cuenta ****6789", estado: "pendiente", motivo: null },
        { id: "r2", tipo: "xml_emitidos", etiqueta: "CFDI emitidos del mes (XML)", estado: "recibido", motivo: null },
        { id: "r3", tipo: "xml_recibidos", etiqueta: "CFDI recibidos del mes (XML)", estado: "no_aplica", motivo: "No tuvo compras" },
        { id: "r4", tipo: "otros", etiqueta: "Otros documentos del mes", estado: "en_revision", motivo: null },
      ],
    },
  ];
  const REPORTES = [{ anio: 2026, mes: 5, publicadaEn: "2026-06-05T00:00:00Z", archivos: [{ id: "f1", tipo: "diot", nombreArchivo: "diot-2026-05.pdf", tamanoBytes: 5 }] }];

  function stub(opts: { solicitudes?: unknown; reportes?: unknown; solicitudes503?: boolean } = {}) {
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/portal-cliente/resumen")) return new Response(JSON.stringify(RESUMEN), { status: 200 });
      if (url.endsWith("/portal-cliente/solicitudes")) return opts.solicitudes503 ? new Response(JSON.stringify({ code: "service_unavailable", message: "no" }), { status: 503 }) : new Response(JSON.stringify({ solicitudes: opts.solicitudes ?? SOLICITUDES }), { status: 200 });
      if (url.endsWith("/portal-cliente/reportes")) return new Response(JSON.stringify({ reportes: opts.reportes ?? REPORTES }), { status: 200 });
      if (url.includes("/portal-cliente/reportes/")) return new Response("%PDF-", { status: 200 });
      if (url.includes("/portal-cliente/documentos")) return new Response(JSON.stringify({ id: "d9", estado: "recibido", duplicado: false, nombreArchivo: "edo.pdf", renglon: { vinculado: true, estado: "en_revision" } }), { status: 201 });
      throw new Error(`fetch inesperado ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("muestra lo que el despacho pidio con el estado de cada renglon y solo ofrece subir donde falta o esta en revision", async () => {
    stub();
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    const texto = rendered.container.textContent!;
    expect(texto).toContain("Documentos que te pidió tu despacho");
    expect(texto).toContain("Estado de cuenta ****6789");
    expect(texto).toContain("Falta");
    expect(texto).toContain("Listo");
    expect(texto).toContain("Recibido, en revisión");
    expect(texto).toContain("Tu despacho indicó: No tuvo compras");
    const entradas = [...rendered.container.querySelectorAll('input[type="file"]')].map((i) => i.closest("label")?.textContent ?? "");
    expect(entradas.some((t) => t.includes("Estado de cuenta ****6789"))).toBe(true);
    expect(entradas.some((t) => t.includes("Otros documentos del mes"))).toBe(true);
    expect(entradas.some((t) => t.includes("CFDI emitidos"))).toBe(false);
    expect(entradas.some((t) => t.includes("CFDI recibidos"))).toBe(false);
  });

  it("subir un archivo para un renglon manda ?renglonId= y recarga; el token sigue solo en el header", async () => {
    const mock = stub();
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    const input = [...rendered.container.querySelectorAll('input[type="file"]')].find((i) => i.closest("label")?.textContent?.includes("Estado de cuenta ****6789")) as HTMLInputElement;
    const archivo = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "edo.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [archivo], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    const subida = mock.mock.calls.find(([url, init]) => String(url).includes("/portal-cliente/documentos") && (init as RequestInit | undefined)?.method === "POST")!;
    expect(String(subida[0])).toBe("https://api.test/portal-cliente/documentos?renglonId=r1");
    expect(String(subida[0])).not.toContain(TOKEN);
    expect(rendered.container.textContent).toContain("Recibimos “edo.pdf”");
  });

  it("lista los reportes del cierre y baja el PDF con el token en el header", async () => {
    const mock = stub();
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Reportes de tu cierre");
    expect(rendered.container.textContent).toContain("diot-2026-05.pdf");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    const descargar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Descargar")!;
    await act(async () => {
      clickEl(descargar);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    const llamada = mock.mock.calls.find(([url]) => String(url).endsWith("/portal-cliente/reportes/f1"))!;
    expect(((llamada[1] as RequestInit).headers as Record<string, string>)["x-portal-token"]).toBe(TOKEN);
  });

  it("sin la migracion 027 (503) las secciones nuevas se OCULTAN y el resto del portal sigue funcionando", async () => {
    stub({ solicitudes503: true, reportes: [] });
    rendered = renderComponent(<PortalClientePage apiBaseUrl="https://api.test" hash={`#t=${TOKEN}`} />);
    await esperar();
    const texto = rendered.container.textContent!;
    expect(texto).not.toContain("Documentos que te pidió tu despacho");
    expect(texto).not.toContain("Reportes de tu cierre");
    expect(texto).toContain("Obligaciones ante el SAT");
  });
});
