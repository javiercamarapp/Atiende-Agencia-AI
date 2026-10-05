// D-P3-13: cliente de la clasificacion contable (rutas, cuerpos y helpers puros).
import { describe, expect, it, vi } from "vitest";
import {
  corregirCategoriaCfdi,
  eliminarCorreccion,
  esRfcValido,
  fetchAjustesClasificacion,
  fetchCatalogoClasificacion,
  fetchCorrecciones,
  formatConfianza,
  guardarAjustesClasificacion,
  guardarCorreccion,
} from "../src/verticals/despachos/lib/clasificacion-client.ts";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("clasificacion-client", () => {
  it("catalogo, correcciones y ajustes: GET a las rutas reales con el token", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true }));
    await fetchCatalogoClasificacion(f as unknown as typeof fetch, "https://api.test", "tok", "p1");
    await fetchCorrecciones(f as unknown as typeof fetch, "https://api.test", "tok", "p1");
    await fetchAjustesClasificacion(f as unknown as typeof fetch, "https://api.test", "tok", "p1");
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://api.test/despachos/p1/clasificacion/catalogo", "https://api.test/despachos/p1/clasificacion/correcciones", "https://api.test/despachos/p1/clasificacion/ajustes"]);
    for (const c of f.mock.calls) expect((c[1]!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("corregirCategoriaCfdi: PUT .../cfdi/:id/categoria con guardarRegla explicito y la cuenta solo si hay", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => json({ clasificacionId: "c1", clasificacion: null }));
    await corregirCategoriaCfdi(f as unknown as typeof fetch, "https://api.test", "tok", "p1", "inv1", { categoria: "seguros" });
    await corregirCategoriaCfdi(f as unknown as typeof fetch, "https://api.test", "tok", "p1", "inv1", { categoria: "seguros", cuenta: "6080100", guardarRegla: true });
    expect(f.mock.calls[0]![0]).toBe("https://api.test/despachos/p1/cfdi/inv1/categoria");
    expect(f.mock.calls[0]![1]!.method).toBe("PUT");
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ categoria: "seguros", guardarRegla: false });
    expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toEqual({ categoria: "seguros", cuenta: "6080100", guardarRegla: true });
  });

  it("guardarCorreccion / eliminarCorreccion / guardarAjustesClasificacion", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => json({ id: "x", eliminada: true }));
    await guardarCorreccion(f as unknown as typeof fetch, "https://api.test", "tok", "p1", { rfcEmisor: "AAA010101AAA", categoria: "publicidad" });
    await guardarCorreccion(f as unknown as typeof fetch, "https://api.test", "tok", "p1", { rfcEmisor: "AAA010101AAA", claveProdServ: "43211503", categoria: "publicidad", cuenta: "6020500" });
    await eliminarCorreccion(f as unknown as typeof fetch, "https://api.test", "tok", "p1", "corr-1");
    await guardarAjustesClasificacion(f as unknown as typeof fetch, "https://api.test", "tok", "p1", { umbralConfianza: 0.8, portalAutoaceptarValidos: false });
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ rfcEmisor: "AAA010101AAA", categoria: "publicidad" });
    expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toEqual({ rfcEmisor: "AAA010101AAA", claveProdServ: "43211503", categoria: "publicidad", cuenta: "6020500" });
    expect(f.mock.calls[2]).toEqual(["https://api.test/despachos/p1/clasificacion/correcciones/corr-1", expect.objectContaining({ method: "DELETE" })]);
    expect(f.mock.calls[3]![0]).toBe("https://api.test/despachos/p1/clasificacion/ajustes");
    expect(JSON.parse(String(f.mock.calls[3]![1]!.body))).toEqual({ umbralConfianza: 0.8, portalAutoaceptarValidos: false });
  });

  it("un error del servidor llega como mensaje legible", async () => {
    const f = vi.fn(async () => json({ code: "validation", message: "umbralConfianza: no puede ser menor que el piso de confianza (0.5)." }, 400));
    await expect(guardarAjustesClasificacion(f as unknown as typeof fetch, "https://api.test", "tok", "p1", { umbralConfianza: 0.4 })).rejects.toThrow(/piso de confianza/);
  });

  it("esRfcValido y formatConfianza", () => {
    expect(esRfcValido("aaa010101aaa")).toBe(true);
    expect(esRfcValido("AAA010101")).toBe(false);
    expect(esRfcValido("")).toBe(false);
    expect(formatConfianza(0.456)).toBe("46 %");
    expect(formatConfianza(null)).toBe("—");
    expect(formatConfianza(undefined)).toBe("—");
  });
});
