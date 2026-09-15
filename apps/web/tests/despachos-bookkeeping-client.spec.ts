import { describe, expect, it, vi } from "vitest";
import {
  clasificarCfdisBookkeeping,
  fetchCatalogoBookkeeping,
  fetchSugerenciasOverridesBookkeeping,
  generarAjusteBookkeeping,
  generarPolizasBookkeeping,
} from "../src/verticals/despachos/lib/bookkeeping-client.ts";
import type { CatalogoBookkeeping, CfdiClasificarInput, CfdiClassification, OverrideRecord, PolizaContable, PolizaResultado, SuggestionRetraining } from "../src/verticals/despachos/lib/bookkeeping-client.ts";

const CFDI_INPUT: CfdiClasificarInput = { cfdiUuid: "u1", rfcEmisor: "aaa010101aaa", descripcion: "Honorarios enero", subtotal: 10000, iva: 1600, total: 11600, tasaIva: 0.16, tipoCfdi: "I" };

describe("fetchCatalogoBookkeeping", () => {
  it("manda GET .../bookkeeping/catalogo y devuelve el catálogo tal cual", async () => {
    const catalogo: CatalogoBookkeeping = {
      catalogoCuentas: { "1020000": "Bancos" },
      mapeosDefault: { "I|servicios_profesionales": { cargo: "6020100", abono: "1020000", ivaCargo: "2600300", ivaAbono: null, polizaType: "egreso" } },
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/bookkeeping/catalogo");
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(JSON.stringify(catalogo), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCatalogoBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual(catalogo);
  });
});

describe("clasificarCfdisBookkeeping", () => {
  it("sin overrides manda {cfdis, overrides: []} y devuelve las clasificaciones", async () => {
    const clasificaciones: readonly CfdiClassification[] = [
      { cfdiUuid: "u1", rfcEmisor: "AAA010101AAA", rfcReceptor: "", descripcion: "Honorarios enero", subtotal: 10000, iva: 1600, total: 11600, tasaIva: 0.16, tipoCfdi: "I", categoria: "servicios_profesionales", confidence: 0.9, needsHumanReview: false },
    ];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/bookkeeping/clasificar");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ cfdis: [CFDI_INPUT], overrides: [] });
      return new Response(JSON.stringify({ clasificaciones }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await clasificarCfdisBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1", [CFDI_INPUT]);
    expect(result.clasificaciones).toEqual(clasificaciones);
  });

  it("con overrides los incluye en el body", async () => {
    const overrides: readonly OverrideRecord[] = [{ cfdiUuid: "u0", rfcEmisor: "BBB020202BBB", newCategoria: "renta_oficina", tenantId: "t1" }];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ cfdis: [CFDI_INPUT], overrides });
      return new Response(JSON.stringify({ clasificaciones: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await clasificarCfdisBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1", [CFDI_INPUT], overrides);
  });

  it("400 (validación) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "cfdis[0].tipoCfdi: se esperaba I|E|T|P|N." }), { status: 400 })) as unknown as typeof fetch;
    await expect(clasificarCfdisBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1", [CFDI_INPUT])).rejects.toThrow("se esperaba I|E|T|P|N");
  });
});

describe("generarPolizasBookkeeping", () => {
  const POLIZA: PolizaContable = {
    tipo: "egreso",
    fecha: "2026-03-05",
    concepto: "CFDI u1 - Honorarios enero",
    referencia: "u1",
    lineas: [
      { cuenta: "6020100", concepto: "Servicios profesionales - Honorarios enero", debe: 10000, haber: 0, tipo: "cargo" },
      { cuenta: "1020000", concepto: "Bancos", debe: 0, haber: 10000, tipo: "abono" },
    ],
    totalDebe: 10000,
    totalHaber: 10000,
    cuadrada: true,
    tenantId: "",
  };
  const CLASIFICACION: CfdiClassification = { cfdiUuid: "u1", rfcEmisor: "AAA010101AAA", rfcReceptor: "", descripcion: "Honorarios enero", subtotal: 10000, iva: 0, total: 10000, tasaIva: 0, tipoCfdi: "I", categoria: "servicios_profesionales", confidence: 1, needsHumanReview: false };

  it("sin tenantId ni fecha manda solo {clasificaciones}", async () => {
    const resultados: readonly PolizaResultado[] = [{ cfdiUuid: "u1", poliza: POLIZA, errores: [] }];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/bookkeeping/poliza");
      expect(JSON.parse(init?.body as string)).toEqual({ clasificaciones: [CLASIFICACION] });
      return new Response(JSON.stringify({ polizas: resultados }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await generarPolizasBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1", [CLASIFICACION]);
    expect(result.polizas).toEqual(resultados);
  });

  it("con tenantId y fecha los incluye en el body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ clasificaciones: [CLASIFICACION], tenantId: "t1", fecha: "2026-03-05" });
      return new Response(JSON.stringify({ polizas: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await generarPolizasBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1", [CLASIFICACION], "t1", "2026-03-05");
  });

  it("sin mapeo -> poliza null con errores", async () => {
    const resultados: readonly PolizaResultado[] = [{ cfdiUuid: "u1", poliza: null, errores: ["Sin mapeo contable para (tipoCfdi=I, categoria=servicios_profesionales)."] }];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ polizas: resultados }), { status: 200 })) as unknown as typeof fetch;
    const result = await generarPolizasBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1", [CLASIFICACION]);
    expect(result.polizas[0]!.poliza).toBeNull();
  });
});

describe("generarAjusteBookkeeping", () => {
  it("manda POST .../bookkeeping/ajuste con fecha/concepto/entries y devuelve poliza+errores", async () => {
    const poliza: PolizaContable = {
      tipo: "diario",
      fecha: "2026-03-05",
      concepto: "Ajuste manual",
      referencia: "",
      lineas: [
        { cuenta: "6020100", concepto: "Ajuste", debe: 500, haber: 0, tipo: "cargo" },
        { cuenta: "1020000", concepto: "Ajuste", debe: 0, haber: 500, tipo: "abono" },
      ],
      totalDebe: 500,
      totalHaber: 500,
      cuadrada: true,
      tenantId: "",
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/bookkeeping/ajuste");
      expect(JSON.parse(init?.body as string)).toEqual({ fecha: "2026-03-05", concepto: "Ajuste manual", entries: [{ cuenta: "6020100", debe: 500 }, { cuenta: "1020000", haber: 500 }] });
      return new Response(JSON.stringify({ poliza, errores: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await generarAjusteBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03-05", "Ajuste manual", [{ cuenta: "6020100", debe: 500 }, { cuenta: "1020000", haber: 500 }]);
    expect(result.poliza).toEqual(poliza);
    expect(result.errores).toEqual([]);
  });

  it("con tenantId lo incluye en el body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({ tenantId: "t1" });
      return new Response(JSON.stringify({ poliza: null, errores: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await generarAjusteBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03-05", "x", [], "t1");
  });
});

describe("fetchSugerenciasOverridesBookkeeping", () => {
  it("manda POST .../bookkeeping/overrides/sugerencias con el historial y devuelve las sugerencias", async () => {
    const overrides: readonly OverrideRecord[] = [
      { cfdiUuid: "u1", rfcEmisor: "AAA010101AAA", newCategoria: "renta_oficina", tenantId: "" },
      { cfdiUuid: "u2", rfcEmisor: "AAA010101AAA", newCategoria: "renta_oficina", tenantId: "" },
    ];
    const sugerencias: readonly SuggestionRetraining[] = [{ rfc: "AAA010101AAA", suggestedCategoria: "renta_oficina", overrideCount: 2, totalCorrections: 2, confidence: 1 }];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/bookkeeping/overrides/sugerencias");
      expect(JSON.parse(init?.body as string)).toEqual({ overrides });
      return new Response(JSON.stringify({ sugerencias }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchSugerenciasOverridesBookkeeping(fetchImpl, "http://api.local", "tok", "prop-1", overrides);
    expect(result.sugerencias).toEqual(sugerencias);
  });
});
