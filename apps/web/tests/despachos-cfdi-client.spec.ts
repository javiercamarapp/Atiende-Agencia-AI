import { describe, expect, it, vi } from "vitest";
import { fetchInvoice, fetchInvoices, importarCfdiXml } from "../src/verticals/despachos/lib/cfdi-client.ts";

const SAMPLE_INVOICE = {
  id: "inv1",
  folioFiscal: "AAAA1111-BBBB-2222-CCCC-DDDDEEEEFFFF",
  tipo: "I",
  rfcEmisor: "AAA010101AAA",
  rfcReceptor: "BBB020202BBB",
  emisorNombre: "Proveedor de Prueba SA de CV",
  subtotal: 1000,
  total: 1160,
  iva: 160,
  descuento: 0,
  categoria: "gasto_operativo",
  valido: true,
  issues: [],
  warnings: [],
  requiereRevisionHumana: false,
  diot: { proveedoresReportables: [], reportable: false },
  creadoEn: "2026-03-01T00:00:00Z",
};

describe("fetchInvoices", () => {
  it("pide GET .../cfdi sin filtro y devuelve el arreglo tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cfdi");
      return new Response(JSON.stringify([SAMPLE_INVOICE]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchInvoices(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([SAMPLE_INVOICE]);
  });

  it("con filtro requiereRevisionHumana=true -> agrega el query param", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cfdi?requiereRevisionHumana=true");
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchInvoices(fetchImpl, "http://api.local", "tok", "prop-1", { requiereRevisionHumana: true });
  });
});

describe("fetchInvoice", () => {
  it("pide GET .../cfdi/:id y devuelve el CFDI completo (issues/warnings/diot incluidos)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cfdi/inv1");
      return new Response(JSON.stringify(SAMPLE_INVOICE), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchInvoice(fetchImpl, "http://api.local", "tok", "prop-1", "inv1");
    expect(result).toEqual(SAMPLE_INVOICE);
  });

  it("404 -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "CFDI no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchInvoice(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe")).rejects.toThrow("CFDI no encontrado.");
  });
});

describe("importarCfdiXml", () => {
  it("pide POST .../cfdi/importar-xml con el XML crudo (sin envolverlo en JSON) y devuelve el invoice creado", async () => {
    const xml = '<cfdi:Comprobante Version="4.0">…</cfdi:Comprobante>';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cfdi/importar-xml");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(xml);
      expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/xml");
      return new Response(JSON.stringify(SAMPLE_INVOICE), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await importarCfdiXml(fetchImpl, "http://api.local", "tok", "prop-1", xml);
    expect(result).toEqual(SAMPLE_INVOICE);
  });

  it("400 (XML inválido) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "XML mal formado." }), { status: 400 })) as unknown as typeof fetch;
    await expect(importarCfdiXml(fetchImpl, "http://api.local", "tok", "prop-1", "<xml/>")).rejects.toThrow("XML mal formado.");
  });
});
