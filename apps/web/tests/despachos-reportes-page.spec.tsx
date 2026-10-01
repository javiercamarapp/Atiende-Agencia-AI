// @vitest-environment jsdom
//
// D-01 — <ReportesPage /> (reportes de cliente): período por defecto en CDMX, tabla real con
// totales, secciones "Sin datos" con su motivo, descarga PDF/Excel con ruta y nombre reales.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportesPage, periodoPorDefecto } from "../src/verticals/despachos/pages/Reportes.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import type { ReporteCliente } from "../src/verticals/despachos/lib/reportes-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role: "auditor", staffFullName: "Auditor", staffEmail: "a@example.com" };

const REPORTE: ReporteCliente = {
  tipo: "diot",
  titulo: "DIOT (Declaración Informativa de Operaciones con Terceros)",
  periodo: "2026-08",
  generadoEn: "2026-09-30",
  contribuyente: { nombre: "Cliente Uno SA de CV", rfc: "CLI010101CL1" },
  secciones: [
    {
      titulo: "Operaciones con terceros",
      columnas: [
        { clave: "rfc", titulo: "RFC del tercero", tipo: "texto" },
        { clave: "operaciones", titulo: "CFDI", tipo: "entero" },
        { clave: "montoNeto", titulo: "Valor de actos (base)", tipo: "moneda" },
      ],
      filas: [{ rfc: "AAA010101AAA", operaciones: 2, montoNeto: 1500 }],
      totales: { rfc: "Total", operaciones: 2, montoNeto: 1500 },
      sinDatosMotivo: null,
    },
    { titulo: "Desglose por empleado", columnas: [{ clave: "c", titulo: "Concepto", tipo: "texto" }], filas: [], totales: null, sinDatosMotivo: "La nómina procesada no se persiste." },
  ],
  notas: ["Reporte informativo; no sustituye la presentación ante el SAT."],
  sinDatos: false,
};

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("periodoPorDefecto", () => {
  it("es el mes anterior del día de calendario CDMX, no del día UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T01:30:00.000Z")); // 28-feb 19:30 CDMX
    expect(periodoPorDefecto()).toBe("2026-01");
    vi.setSystemTime(new Date("2026-01-15T18:00:00.000Z"));
    expect(periodoPorDefecto()).toBe("2025-12");
  });
});

describe("ReportesPage (despachos)", () => {
  it("genera el reporte al abrir: tabla con montos MXN, fila de totales, sección 'Sin datos' con su motivo y notas", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(REPORTE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<ReportesPage {...CTX} />);
    await esperar();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/^https:\/\/api\.test\/despachos\/prop-1\/reportes\/diot\?periodo=\d{4}-\d{2}&formato=json$/);
    const text = rendered.container.textContent!;
    expect(text).toContain("Cliente Uno SA de CV");
    expect(text).toContain("RFC CLI010101CL1");
    expect(text).toContain("AAA010101AAA");
    expect(text).toContain("$1,500.00");
    expect(text).toContain("Total");
    expect(text).toContain("Sin datos");
    expect(text).toContain("La nómina procesada no se persiste.");
    expect(text).toContain("no sustituye la presentación ante el SAT");
  });

  it("cambiar tipo y período y generar vuelve a pedir ese reporte", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(REPORTE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<ReportesPage {...CTX} />);
    await esperar();
    await act(async () => {
      changeValue(rendered!.container.querySelector("#reporte-tipo") as HTMLSelectElement, "nomina");
      changeValue(rendered!.container.querySelector("#reporte-periodo") as HTMLInputElement, "2026-07");
    });
    await act(async () => {
      click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Generar reporte"))!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe("https://api.test/despachos/prop-1/reportes/nomina?periodo=2026-07&formato=json");
  });

  it("un período inválido no llama al servidor", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(REPORTE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<ReportesPage {...CTX} />);
    await esperar();
    const llamadas = fetchMock.mock.calls.length;
    await act(async () => {
      changeValue(rendered!.container.querySelector("#reporte-periodo") as HTMLInputElement, "agosto");
    });
    await act(async () => {
      click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Generar reporte"))!);
      await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.length).toBe(llamadas);
    expect(rendered.container.textContent).toContain("Período inválido");
  });

  it("'Descargar Excel' pide formato=xlsx con bearer y dispara la descarga con el nombre del servidor", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes("formato=xlsx")
        ? new Response(new Blob(["PK"]), { status: 200, headers: { "content-disposition": 'attachment; filename="reporte-diot-2026-08.xlsx"' } })
        : new Response(JSON.stringify(REPORTE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const descargas: string[] = [];
    const clickOriginal = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      descargas.push(this.download);
    };
    try {
      rendered = renderComponent(<ReportesPage {...CTX} />);
      await esperar();
      await act(async () => {
        click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Descargar Excel"))!);
        await flushMicrotasks();
        await flushMicrotasks();
        await flushMicrotasks();
      });
      const llamada = fetchMock.mock.calls.find(([u]) => String(u).includes("formato=xlsx"))!;
      expect(llamada[1]?.headers).toMatchObject({ authorization: "Bearer tok-123" });
      expect(descargas).toEqual(["reporte-diot-2026-08.xlsx"]);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    } finally {
      HTMLAnchorElement.prototype.click = clickOriginal;
    }
  });

  it("error del servidor al generar: mensaje real", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Tu rol (sin resolver) no puede realizar esta acción." }), { status: 403 })));
    rendered = renderComponent(<ReportesPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("no puede realizar esta acción");
  });

  it("reporte sin datos: aviso explícito, sin tabla vacía", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...REPORTE, sinDatos: true, contribuyente: { nombre: "Cliente", rfc: null }, secciones: [REPORTE.secciones[1]] }), { status: 200 })));
    rendered = renderComponent(<ReportesPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("No hay datos para este reporte en el período indicado.");
    expect(rendered.container.textContent).toContain("RFC sin datos");
    expect(rendered.container.querySelector("table")).toBeNull();
  });
});
