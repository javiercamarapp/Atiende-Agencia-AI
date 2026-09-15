import { describe, expect, it, vi } from "vitest";
import { calcularNomina, generarXmlNomina } from "../src/verticals/despachos/lib/nomina-client.ts";
import type { GenerarXmlNominaResultado, PayrollPeriodResultado } from "../src/verticals/despachos/lib/nomina-client.ts";

const RESULTADO: PayrollPeriodResultado = {
  month: 1,
  year: 2026,
  employees: [
    {
      employeeId: "e1",
      nombre: "Ana",
      salarioDiario: 0,
      salarioBruto: 15000,
      percepciones: 0,
      deducciones: 1200,
      taxes: { isr: 1000, imssPatronal: 500, imssObrero: 200, infonavit: 0, total: 1200 },
      neto: 13800,
      diasPagados: 30,
    },
  ],
  totalBruto: 15000,
  totalNeto: 13800,
  totalDeducciones: 1200,
  totalIsr: 1000,
  totalImssPatronal: 500,
  totalImssObrero: 200,
  totalInfonavit: 0,
  tenantId: null,
  requiresHumanReview: false,
  humanReviewReason: "",
  referenciaLegal: "Art. 96 LISR",
  supuesto: "nomina_completa",
  idempotencyKey: "nomina-2026-01-None",
};

describe("calcularNomina", () => {
  it("manda POST .../nomina/calcular con period/employees/tenantId y devuelve el resultado tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/nomina/calcular");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(
        JSON.stringify({
          period: { month: 1, year: 2026, diasPagados: 30, salarioDiarioDefault: undefined },
          employees: [{ employeeId: "e1", nombre: "Ana", salarioBruto: 15000, percepciones: undefined, salarioDiario: undefined }],
          tenantId: null,
        }),
      );
      return new Response(JSON.stringify(RESULTADO), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await calcularNomina(fetchImpl, "http://api.local", "tok", "prop-1", {
      period: { month: 1, year: 2026, diasPagados: 30 },
      employees: [{ employeeId: "e1", nombre: "Ana", salarioBruto: 15000 }],
      tenantId: null,
    });
    expect(result).toEqual(RESULTADO);
  });

  it("400 (employees no es arreglo) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "employees: se esperaba un arreglo." }), { status: 400 })) as unknown as typeof fetch;
    await expect(calcularNomina(fetchImpl, "http://api.local", "tok", "prop-1", { period: {}, employees: [] })).rejects.toThrow("se esperaba un arreglo");
  });
});

describe("generarXmlNomina", () => {
  it("manda POST .../nomina/generar-xml con period/employees/emisor y devuelve el idempotencyKey + comprobantes", async () => {
    const resultado: GenerarXmlNominaResultado = {
      idempotencyKey: "nomina-2026-07-None",
      comprobantes: [{ employeeId: "e1", folio: "F0001", xml: "<cfdi:Comprobante/>" }],
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/nomina/generar-xml");
      const body = JSON.parse(init!.body as string);
      expect(body.emisor.rfc).toBe("DESP010101AB1");
      expect(body.employees[0].rfcReceptor).toBe("PEAA850101ABC");
      expect(body.period.tipoNomina).toBe("O");
      return new Response(JSON.stringify(resultado), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await generarXmlNomina(fetchImpl, "http://api.local", "tok", "prop-1", {
      period: { month: 7, year: 2026, diasPagados: 30, tipoNomina: "O" },
      employees: [
        {
          employeeId: "e1",
          nombre: "Ana Pérez",
          salarioBruto: 15000,
          rfcReceptor: "PEAA850101ABC",
          domicilioFiscalReceptor: "01000",
          folio: "F0001",
        },
      ],
      emisor: { rfc: "DESP010101AB1", nombre: "DESPACHO DE PRUEBA SA DE CV", regimenFiscal: "601", lugarExpedicion: "06600" },
      tenantId: null,
    });
    expect(result).toEqual(resultado);
  });

  it("400 (falta domicilioFiscalReceptor) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "employees[0]: domicilioFiscalReceptor: se esperaba un texto no vacío." }), { status: 400 })) as unknown as typeof fetch;
    await expect(
      generarXmlNomina(fetchImpl, "http://api.local", "tok", "prop-1", {
        period: { month: 7, year: 2026 },
        employees: [{ employeeId: "e1", nombre: "Ana", salarioBruto: 15000, rfcReceptor: "PEAA850101ABC", domicilioFiscalReceptor: "", folio: "F0001" }],
        emisor: { rfc: "DESP010101AB1", nombre: "X", regimenFiscal: "601", lugarExpedicion: "06600" },
      }),
    ).rejects.toThrow("domicilioFiscalReceptor");
  });
});
