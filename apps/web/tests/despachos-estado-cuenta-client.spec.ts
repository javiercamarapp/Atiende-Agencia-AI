import { describe, expect, it, vi } from "vitest";
import { decodificarArchivoEstadoCuenta, formatoPorNombreArchivo, guardarEstadoCuenta, previsualizarEstadoCuenta } from "../src/verticals/despachos/lib/estado-cuenta-client.ts";

describe("decodificarArchivoEstadoCuenta", () => {
  it("UTF-8 válido conserva acentos", () => {
    const bytes = new TextEncoder().encode("PAGO DE NÓMINA, COMISIÓN");
    expect(decodificarArchivoEstadoCuenta(bytes.buffer as ArrayBuffer)).toBe("PAGO DE NÓMINA, COMISIÓN");
  });

  it("Windows-1252 (Latin-1) de bancos viejos se decodifica sin mojibake", () => {
    // "NÓMINA" en Windows-1252: Ó = 0xD3
    const bytes = new Uint8Array([0x4e, 0xd3, 0x4d, 0x49, 0x4e, 0x41]);
    expect(decodificarArchivoEstadoCuenta(bytes.buffer as ArrayBuffer)).toBe("NÓMINA");
  });
});

describe("formatoPorNombreArchivo", () => {
  it.each([
    ["estado.CSV", "csv"],
    ["movimientos.txt", "csv"],
    ["cuenta.ofx", "ofx"],
    ["cuenta.QFX", "ofx"],
    ["estado.pdf", undefined],
    ["sin-extension", undefined],
  ])("%s -> %s", (nombre, esperado) => {
    expect(formatoPorNombreArchivo(nombre)).toBe(esperado);
  });
});

describe("previsualizarEstadoCuenta", () => {
  it("manda POST .../conciliacion/importar-estado-de-cuenta con token y cuerpo exactos", async () => {
    const respuesta = { parseo: { movimientos: [] }, yaImportados: [], nuevos: 0 };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => respuesta }) as unknown as Response);
    const r = await previsualizarEstadoCuenta(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "prop-1", { contenido: "a,b", formato: "csv", banco: "bbva", cuenta: "012180000123456782" });
    expect(r).toEqual(respuesta);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/despachos/prop-1/conciliacion/importar-estado-de-cuenta");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ contenido: "a,b", formato: "csv", banco: "bbva", cuenta: "012180000123456782" });
  });

  it("un error del servidor se propaga con su mensaje", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "banco: se esperaba uno de ..." } }), text: async () => "" }) as unknown as Response);
    await expect(previsualizarEstadoCuenta(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "prop-1", { contenido: "x" })).rejects.toThrow();
  });
});

describe("guardarEstadoCuenta", () => {
  it("manda POST .../importar-estado-de-cuenta/guardar con el mismo cuerpo de la vista previa", async () => {
    const respuesta = { loteId: "l1", insertados: 2, yaExistentes: 0, totalMovimientos: 2 };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => respuesta }) as unknown as Response);
    const r = await guardarEstadoCuenta(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "prop-1", { contenido: "a;b", formato: "csv" });
    expect(r).toEqual(respuesta);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/despachos/prop-1/conciliacion/importar-estado-de-cuenta/guardar");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ contenido: "a;b", formato: "csv" });
  });
});
