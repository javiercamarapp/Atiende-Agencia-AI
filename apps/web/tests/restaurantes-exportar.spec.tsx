// @vitest-environment jsdom
//
// R-17 en la web: botón "Exportar" de Historial y Clientes. Cada caso afirma el EFECTO: a qué URL real se llama (con los filtros vigentes de la
// pantalla), que solo se ofrezca a owner/admin, que se entregue el archivo al navegador con el nombre que manda el servidor, y que un error del
// servidor (p. ej. 413 por pasar del tope de filas) se muestre con su mensaje en vez de descargar nada.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { ClientesListPage } from "../src/verticals/restaurantes/pages/Clientes.tsx";
import { HistorialPage } from "../src/verticals/restaurantes/pages/Historial.tsx";
import { BotonExportar, puedeExportar } from "../src/verticals/restaurantes/components/BotonExportar.tsx";
import { descargarExportacion, guardarArchivo, urlExportarClientes, urlExportarHistorial } from "../src/verticals/restaurantes/lib/exportar-client.ts";
import { changeValue, click, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
const creados: string[] = [];
const descargas: { href: string; download: string }[] = [];
beforeEach(() => {
  // jsdom no implementa createObjectURL ni navega con <a download>: se registran para afirmar la entrega del archivo.
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
    creados.push(`blob:${(b as Blob).size}`);
    return `blob:fake-${creados.length}`;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    descargas.push({ href: this.href, download: this.download });
  });
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  creados.length = 0;
  descargas.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const API = "https://api.test";
type Respuesta = { status: number; body?: unknown; archivo?: { nombre: string; contenido: string } };
function respuesta(r: Respuesta): Response {
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: new Headers(r.archivo ? { "content-disposition": `attachment; filename="${r.archivo.nombre}"` } : {}),
    json: async () => r.body ?? {},
    blob: async () => new Blob([r.archivo?.contenido ?? ""]),
  } as unknown as Response;
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
const texto = () => document.body.textContent ?? "";
function abrirMenu(): void {
  const trigger = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Exportar"))!;
  keydown(trigger, "Enter");
}
const opcion = (nombre: string) => [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.includes(nombre)) as HTMLElement | undefined;

describe("URLs de exportacion (puras)", () => {
  it("Historial: formato y SOLO los filtros que tienen valor", () => {
    expect(urlExportarHistorial(API, "p1", "csv", {})).toBe(`${API}/v1/restaurantes/p1/admin/exportar/historial?formato=csv`);
    expect(urlExportarHistorial(API, "p1", "pdf", { status: "entregado", dateFrom: "2026-10-01T06:00:00.000Z", dateTo: "2026-10-04T06:00:00.000Z" })).toBe(
      `${API}/v1/restaurantes/p1/admin/exportar/historial?formato=pdf&status=entregado&dateFrom=2026-10-01T06%3A00%3A00.000Z&dateTo=2026-10-04T06%3A00%3A00.000Z`,
    );
  });
  it("Clientes: la busqueda viaja codificada", () => {
    expect(urlExportarClientes(API, "p1", "csv")).toBe(`${API}/v1/restaurantes/p1/admin/exportar/clientes?formato=csv`);
    expect(urlExportarClientes(API, "p1", "pdf", "Ñandú & co")).toBe(`${API}/v1/restaurantes/p1/admin/exportar/clientes?formato=pdf&search=%C3%91and%C3%BA+%26+co`);
  });
});

describe("descargarExportacion / guardarArchivo", () => {
  it("toma el nombre del Content-Disposition y manda el token", async () => {
    const f = vi.fn(async () => respuesta({ status: 200, archivo: { nombre: "atiende-historial-2026-10-04.csv", contenido: "a,b" } }));
    const a = await descargarExportacion(f as unknown as typeof fetch, `${API}/x?formato=csv`, "tok", "csv");
    expect(a.nombre).toBe("atiende-historial-2026-10-04.csv");
    expect(a.blob.size).toBe(3);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: "Bearer tok" });
  });
  it("sin cabecera usa un nombre de respaldo con la extension del formato", async () => {
    const f = vi.fn(async () => respuesta({ status: 200 }));
    expect((await descargarExportacion(f as unknown as typeof fetch, `${API}/x`, "tok", "pdf")).nombre).toBe("atiende-exportacion.pdf");
  });
  it("un error del servidor (413) se lanza con SU mensaje y no entrega archivo", async () => {
    const f = vi.fn(async () => respuesta({ status: 413, body: { message: "Hay más de 2000 filas para exportar. Acota el rango de fechas." } }));
    await expect(descargarExportacion(f as unknown as typeof fetch, `${API}/x`, "tok", "pdf")).rejects.toThrow("Acota el rango de fechas");
  });
  it("guardarArchivo crea el enlace de descarga, lo pulsa y libera la URL", () => {
    guardarArchivo({ blob: new Blob(["hola"]), nombre: "x.csv" });
    expect(descargas).toEqual([{ href: "blob:fake-1", download: "x.csv" }]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-1");
    expect(document.querySelector("a[download]")).toBeNull(); // el ancla temporal no queda en el documento
  });
});

describe("<BotonExportar />", () => {
  it.each([["owner", true], ["admin", true], ["staff", false], ["repartidor", false]])("rol %s: boton visible = %s", (rol, visible) => {
    expect(puedeExportar(rol)).toBe(visible);
    rendered = renderComponent(<BotonExportar role={rol} token="tok" urlPara={(f) => `${API}/x?formato=${f}`} />);
    expect(document.body.textContent?.includes("Exportar") ?? false).toBe(visible);
  });

  it("CSV: llama a la URL del formato y entrega el archivo; PDF: igual con su formato", async () => {
    const f = vi.fn(async (url: string) => respuesta({ status: 200, archivo: { nombre: url.includes("pdf") ? "a.pdf" : "a.csv", contenido: "datos" } }));
    rendered = renderComponent(<BotonExportar role="owner" token="tok" urlPara={(fm) => `${API}/x?formato=${fm}`} fetchImpl={f as unknown as typeof fetch} />);
    abrirMenu();
    await act(async () => {
      click(opcion("CSV")!);
    });
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe(`${API}/x?formato=csv`);
    expect(descargas.map((d) => d.download)).toEqual(["a.csv"]);
    abrirMenu();
    await act(async () => {
      click(opcion("PDF")!);
    });
    await settle();
    expect(f.mock.calls[1]![0]).toBe(`${API}/x?formato=pdf`);
    expect(descargas.map((d) => d.download)).toEqual(["a.csv", "a.pdf"]);
  });

  it("si el servidor rechaza, NO se entrega ningun archivo", async () => {
    const f = vi.fn(async () => respuesta({ status: 413, body: { message: "Acota el rango" } }));
    rendered = renderComponent(<BotonExportar role="admin" token="tok" urlPara={(fm) => `${API}/x?formato=${fm}`} fetchImpl={f as unknown as typeof fetch} />);
    abrirMenu();
    await act(async () => {
      click(opcion("PDF")!);
    });
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    expect(descargas).toEqual([]);
  });
});

describe("pantallas: el boton exporta con los filtros VIGENTES", () => {
  const ctx = (role: string) => ({ apiBaseUrl: API, token: "tok", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: undefined, staffEmail: "a@b.c" });

  it("Historial: el estado y el rango elegidos viajan a la exportacion; sin filtros solo el formato", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("/admin/exportar/")) return respuesta({ status: 200, archivo: { nombre: "h.csv", contenido: "x" } });
      return respuesta({ status: 200, body: { orders: [], nextCursor: null } });
    });
    vi.stubGlobal("fetch", f);
    rendered = renderComponent(<HistorialPage {...ctx("owner")} />);
    await settle();
    const estado = document.getElementById("restaurantes-historial-estado") as HTMLElement;
    elegirValor(estado, "entregado");
    changeValue(document.getElementById("restaurantes-historial-desde") as HTMLInputElement, "2026-10-01");
    await settle();
    abrirMenu();
    await act(async () => {
      click(opcion("CSV")!);
    });
    await settle();
    const llamadaExport = f.mock.calls.map((c) => c[0] as string).find((u) => u.includes("/admin/exportar/historial"))!;
    const q = new URL(llamadaExport).searchParams;
    expect(q.get("formato")).toBe("csv");
    expect(q.get("status")).toBe("entregado");
    expect(q.get("dateFrom")).toMatch(/^2026-10-01T/);
    expect(q.get("dateTo")).toBeNull();
    expect(descargas.map((d) => d.download)).toEqual(["h.csv"]);
  });

  it("Historial para staff de piso: no hay boton Exportar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respuesta({ status: 200, body: { orders: [], nextCursor: null } })));
    rendered = renderComponent(<HistorialPage {...ctx("staff")} />);
    await settle();
    expect(texto()).not.toContain("Exportar");
  });

  it("Clientes: la busqueda vigente viaja a la exportacion; staff de piso no ve el boton", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("/admin/exportar/")) return respuesta({ status: 200, archivo: { nombre: "c.pdf", contenido: "x" } });
      return respuesta({ status: 200, body: { customers: [], nextCursor: null } });
    });
    vi.stubGlobal("fetch", f);
    rendered = renderComponent(<ClientesListPage {...ctx("admin")} />);
    await settle();
    changeValue(document.getElementById("restaurantes-clientes-buscar") as HTMLInputElement, "Pech");
    await settle();
    abrirMenu();
    await act(async () => {
      click(opcion("PDF")!);
    });
    await settle();
    const u = new URL(f.mock.calls.map((c) => c[0] as string).find((x) => x.includes("/admin/exportar/clientes"))!);
    expect(u.searchParams.get("formato")).toBe("pdf");
    expect(u.searchParams.get("search")).toBe("Pech");
    rendered?.unmount();
    document.body.innerHTML = "";
    vi.stubGlobal("fetch", vi.fn(async () => respuesta({ status: 200, body: { customers: [], nextCursor: null } })));
    rendered = renderComponent(<ClientesListPage {...ctx("staff")} />);
    await settle();
    expect(texto()).not.toContain("Exportar");
  });
});
