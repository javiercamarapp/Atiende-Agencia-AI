import { describe, expect, it, vi } from "vitest";
import { calcularIsrPf, calcularIsrPm, calcularIsrPmResico, fetchDiot } from "../src/verticals/despachos/lib/declaraciones-client.ts";
import type { DiotAgregado, IsrResultado } from "../src/verticals/despachos/lib/declaraciones-client.ts";

const ISR_PF_RESULT: IsrResultado = {
  baseGravable: 10000,
  isrBruto: 792.24,
  tasaEfectiva: 0.0792,
  tipoContribuyente: "PF",
  tablaAplicada: "monthly",
  isrNeto: 792.24,
  pagosProvisionales: 0,
};

describe("calcularIsrPf", () => {
  it("manda POST .../declaraciones/isr/pf con el body y devuelve el resultado tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/declaraciones/isr/pf");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ baseGravable: 10000, annual: false, pagosProvisionales: undefined }));
      return new Response(JSON.stringify(ISR_PF_RESULT), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await calcularIsrPf(fetchImpl, "http://api.local", "tok", "prop-1", { baseGravable: 10000, annual: false });
    expect(result).toEqual(ISR_PF_RESULT);
  });

  it("400 (baseGravable inválida) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "baseGravable: se esperaba un número." }), { status: 400 })) as unknown as typeof fetch;
    await expect(calcularIsrPf(fetchImpl, "http://api.local", "tok", "prop-1", { baseGravable: Number.NaN })).rejects.toThrow("se esperaba un número");
  });
});

describe("calcularIsrPm", () => {
  it("manda POST .../declaraciones/isr/pm con utilidadFiscal/pagosProvisionales", async () => {
    const resultado: IsrResultado = { ...ISR_PF_RESULT, tablaAplicada: "pm_30%", isrBruto: 3000, isrNeto: 2500, pagosProvisionales: 500 };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/declaraciones/isr/pm");
      expect(init?.body).toBe(JSON.stringify({ utilidadFiscal: 10000, pagosProvisionales: 500 }));
      return new Response(JSON.stringify(resultado), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await calcularIsrPm(fetchImpl, "http://api.local", "tok", "prop-1", { utilidadFiscal: 10000, pagosProvisionales: 500 });
    expect(result).toEqual(resultado);
  });
});

describe("calcularIsrPmResico", () => {
  it("manda POST .../declaraciones/isr/pm-resico con ingresosCobrados/deduccionesAutorizadas (flujo de efectivo, tasa plana 30%)", async () => {
    const resultado: IsrResultado = { ...ISR_PF_RESULT, tablaAplicada: "pm_resico" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/declaraciones/isr/pm-resico");
      expect(init?.body).toBe(JSON.stringify({ ingresosCobrados: 20000, deduccionesAutorizadas: 5000, pagosProvisionales: undefined }));
      return new Response(JSON.stringify(resultado), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await calcularIsrPmResico(fetchImpl, "http://api.local", "tok", "prop-1", { ingresosCobrados: 20000, deduccionesAutorizadas: 5000 });
    expect(result).toEqual(resultado);
  });
});

describe("fetchDiot", () => {
  it("pide GET .../declaraciones/diot/:periodo y devuelve el agregado tal cual", async () => {
    const agregado: DiotAgregado = {
      registros: [
        {
          rfcTercero: "AAA010101AAA",
          nombre: "Proveedor Uno",
          tipoOperacion: "03",
          moneda: "MXN",
          tipoCambio: 1,
          fecha: "2026-03-05",
          montoNeto: 1000,
          ivaTrasladado16: 160,
          ivaTrasladado0: 0,
          ivaAcreditable16: 160,
          ivaAcreditable0: 0,
          ivaExento: 0,
          count: 1,
        },
      ],
      totalMontoNeto: 1000,
      totalIvaTrasladado: 160,
      totalIvaAcreditable: 160,
      periodo: "2026-03",
      rfcContribuyente: "BBB020202BBB",
    };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/declaraciones/diot/2026-03");
      return new Response(JSON.stringify(agregado), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchDiot(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03");
    expect(result).toEqual(agregado);
  });

  it("periodo sin candidatos reportables -> registros vacíos, totales en 0", async () => {
    const vacio: DiotAgregado = { registros: [], totalMontoNeto: 0, totalIvaTrasladado: 0, totalIvaAcreditable: 0, periodo: "2026-01", rfcContribuyente: null };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(vacio), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchDiot(fetchImpl, "http://api.local", "tok", "prop-1", "2026-01");
    expect(result).toEqual(vacio);
  });

  it("400 (periodo con formato inválido) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "periodo: se esperaba el formato YYYY-MM." }), { status: 400 })) as unknown as typeof fetch;
    await expect(fetchDiot(fetchImpl, "http://api.local", "tok", "prop-1", "marzo-2026")).rejects.toThrow("YYYY-MM");
  });
});
