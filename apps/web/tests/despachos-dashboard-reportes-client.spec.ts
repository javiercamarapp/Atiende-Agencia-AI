// D-01 — clientes HTTP del dashboard gerencial y de los reportes de cliente.
import { describe, expect, it, vi } from "vitest";
import { fetchDashboardCliente, fetchDashboardDespacho } from "../src/verticals/despachos/lib/dashboard-client.ts";
import { descargarReporte, fetchReporte, formatearCeldaReporte, urlReporte } from "../src/verticals/despachos/lib/reportes-client.ts";
import { DespachosAdminError } from "../src/verticals/despachos/lib/admin-client.ts";

describe("dashboard-client", () => {
  it("pide el consolidado por slug (codificado) con bearer", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/despachos/mi%20despacho/dashboard");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      return new Response(JSON.stringify({ totalClientes: 0, ranking: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchDashboardDespacho(fetchImpl, "http://api.local", "tok", "mi despacho");
    expect(r.totalClientes).toBe(0);
  });

  it("pide los KPIs de un cliente por propertyId", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/dashboard");
      return new Response(JSON.stringify({ propertyId: "prop-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await fetchDashboardCliente(fetchImpl, "http://api.local", "tok", "prop-1")).propertyId).toBe("prop-1");
  });

  it("propaga el mensaje real del servidor ante un error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No perteneces a esta organización." }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchDashboardDespacho(fetchImpl, "http://api.local", "tok", "x")).rejects.toThrow("No perteneces a esta organización.");
  });
});

describe("reportes-client", () => {
  it("arma la URL con tipo, periodo y formato", () => {
    expect(urlReporte("http://api.local", "p1", "diot", "2026-08", "xlsx")).toBe("http://api.local/despachos/p1/reportes/diot?periodo=2026-08&formato=xlsx");
  });

  it("fetchReporte pide formato=json", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/p1/reportes/impuestos?periodo=2026-08&formato=json");
      return new Response(JSON.stringify({ tipo: "impuestos", sinDatos: true, secciones: [], notas: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await fetchReporte(fetchImpl, "http://api.local", "tok", "p1", "impuestos", "2026-08")).tipo).toBe("impuestos");
  });

  it("descargarReporte devuelve el blob y el nombre de content-disposition (o uno por defecto)", async () => {
    const conNombre = vi.fn(async () => new Response(new Blob(["PK"]), { status: 200, headers: { "content-disposition": 'attachment; filename="reporte-diot-2026-08.xlsx"' } })) as unknown as typeof fetch;
    const a = await descargarReporte(conNombre, "http://api.local", "tok", "p1", "diot", "2026-08", "xlsx");
    expect(a.nombre).toBe("reporte-diot-2026-08.xlsx");
    expect(a.blob.size).toBe(2);
    const sinNombre = vi.fn(async () => new Response(new Blob(["%PDF"]), { status: 200 })) as unknown as typeof fetch;
    expect((await descargarReporte(sinNombre, "http://api.local", "tok", "p1", "nomina", "2026-07", "pdf")).nombre).toBe("reporte-nomina-2026-07.pdf");
  });

  it("descargarReporte falla con el mensaje del servidor y no devuelve un blob", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "periodo: se esperaba el formato YYYY-MM." }), { status: 400 })) as unknown as typeof fetch;
    const p = descargarReporte(fetchImpl, "http://api.local", "tok", "p1", "diot", "mal", "pdf");
    await expect(p).rejects.toBeInstanceOf(DespachosAdminError);
    await expect(p).rejects.toThrow("YYYY-MM");
  });

  it("formatearCeldaReporte formatea por tipo de columna", () => {
    expect(formatearCeldaReporte(1234.5, { clave: "m", titulo: "m", tipo: "moneda" })).toContain("1,234.50");
    expect(formatearCeldaReporte(1234, { clave: "n", titulo: "n", tipo: "entero" })).toBe("1,234");
    expect(formatearCeldaReporte(16, { clave: "p", titulo: "p", tipo: "porcentaje" })).toBe("16.0 %");
    expect(formatearCeldaReporte(null, { clave: "t", titulo: "t", tipo: "texto" })).toBe("");
    expect(formatearCeldaReporte("AAA", { clave: "t", titulo: "t", tipo: "texto" })).toBe("AAA");
  });
});
