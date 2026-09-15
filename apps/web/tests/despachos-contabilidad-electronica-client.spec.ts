import { describe, expect, it, vi } from "vitest";
import {
  fetchCatalogoBaseContabilidadElectronica,
  postBalanzaContabilidadElectronica,
  postCatalogoContabilidadElectronica,
  postListoParaTimbrarContabilidadElectronica,
  postPaqueteContabilidadElectronica,
} from "../src/verticals/despachos/lib/contabilidad-electronica-client.ts";
import type { CuentaAnexo24, PaqueteContabilidadElectronica, ResumenBalanza } from "../src/verticals/despachos/lib/contabilidad-electronica-client.ts";

const CUENTA: CuentaAnexo24 = { codigo: "1101", descripcion: "BANCOS", nivel: 3, naturaleza: "D", grupo: "ACTIVO" };

describe("fetchCatalogoBaseContabilidadElectronica", () => {
  it("manda GET .../contabilidad-electronica/catalogo-base y devuelve el catálogo tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/contabilidad-electronica/catalogo-base");
      expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
      return new Response(JSON.stringify({ catalogo: [CUENTA] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCatalogoBaseContabilidadElectronica(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([CUENTA]);
  });
});

describe("postCatalogoContabilidadElectronica", () => {
  it("manda POST .../contabilidad-electronica/catalogo con las opciones y devuelve catalogo+xml+sha1", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/contabilidad-electronica/catalogo");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ ejercicio: 2026, mes: 7, rfc: "CON950820K12" });
      return new Response(JSON.stringify({ catalogo: [CUENTA], xml: "<xml/>", sha1: "abc123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postCatalogoContabilidadElectronica(fetchImpl, "http://api.local", "tok", "prop-1", { ejercicio: 2026, mes: 7, rfc: "CON950820K12" });
    expect(result.catalogo).toEqual([CUENTA]);
    expect(result.xml).toBe("<xml/>");
    expect(result.sha1).toBe("abc123");
  });
});

describe("postBalanzaContabilidadElectronica", () => {
  it("manda POST .../contabilidad-electronica/balanza con asientos y devuelve resumen+xml+sha1", async () => {
    const resumen: ResumenBalanza = { periodo: "2026-07", cuentas: 1, totalDebe: "500.00", totalHaber: "500.00", cuadrada: true, saldosAnomalos: [], lineas: [] };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/contabilidad-electronica/balanza");
      expect(JSON.parse(init?.body as string)).toEqual({ ejercicio: 2026, mes: 7, asientos: [{ cuenta: "1101", debe: 500, haber: 0 }] });
      return new Response(JSON.stringify({ resumen, xml: "<xml/>", sha1: "def456" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postBalanzaContabilidadElectronica(fetchImpl, "http://api.local", "tok", "prop-1", { ejercicio: 2026, mes: 7, asientos: [{ cuenta: "1101", debe: 500, haber: 0 }] });
    expect(result.resumen).toEqual(resumen);
    expect(result.xml).toBe("<xml/>");
    expect(result.sha1).toBe("def456");
  });
});

describe("postPaqueteContabilidadElectronica", () => {
  it("manda POST .../contabilidad-electronica/paquete y devuelve el paquete tal cual", async () => {
    const paquete: PaqueteContabilidadElectronica = {
      periodo: "2026-07",
      ejercicio: 2026,
      mes: 7,
      rfc: "CON950820K12",
      razonSocial: "Despacho de Prueba SC",
      catalogo: { xml: "<cat/>", sha1: "aaa", cuentas: 30 },
      balanza: { xml: "<bal/>", sha1: "bbb", cuadrada: true, cuentas: 1 },
      resumenBalanza: { periodo: "2026-07", cuentas: 1, totalDebe: "500.00", totalHaber: "500.00", cuadrada: true, saldosAnomalos: [], lineas: [] },
      estado: "listo_para_timbrar",
      generadoEn: "2026-08-01T10:00:00.000Z",
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/contabilidad-electronica/paquete");
      expect(JSON.parse(init?.body as string)).toEqual({ ejercicio: 2026, mes: 7, razonSocial: "Despacho de Prueba SC", asientos: [] });
      return new Response(JSON.stringify(paquete), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postPaqueteContabilidadElectronica(fetchImpl, "http://api.local", "tok", "prop-1", { ejercicio: 2026, mes: 7, razonSocial: "Despacho de Prueba SC", asientos: [] });
    expect(result).toEqual(paquete);
  });
});

describe("postListoParaTimbrarContabilidadElectronica", () => {
  it("manda POST .../contabilidad-electronica/listo-para-timbrar con el estado actual y devuelve el nuevo estado", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/contabilidad-electronica/listo-para-timbrar");
      expect(JSON.parse(init?.body as string)).toEqual({ estadoActual: "borrador" });
      return new Response(JSON.stringify({ estado: "listo_para_timbrar" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postListoParaTimbrarContabilidadElectronica(fetchImpl, "http://api.local", "tok", "prop-1", "borrador");
    expect(result.estado).toBe("listo_para_timbrar");
  });
});
