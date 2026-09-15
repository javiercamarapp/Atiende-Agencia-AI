import { describe, expect, it, vi } from "vitest";
import { ContractNotFoundError, createContractInvoice, fetchContractInvoices, fetchReceivablesSummary, markContractInvoicePaid } from "../src/verticals/licitaciones/lib/contract-billing-client.ts";

describe("fetchContractInvoices", () => {
  it("hace GET .../contract/invoices y devuelve el arreglo", async () => {
    const invoices = [{ id: "inv-1", contractId: "c1", concepto: "x", amount: "100.00", invoiceVerifiedOn: "2026-01-05", dueDate: "2026-01-28", legalReference: "Art. 73", paidAt: null, status: "pendiente" as const, createdBy: "u1", createdAt: "2026-01-05T00:00:00Z" }];
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/invoices");
      return new Response(JSON.stringify({ invoices }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchContractInvoices(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(invoices);
  });

  it("404 'sin contrato' -> ContractNotFoundError distinguible", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchContractInvoices(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.toBeInstanceOf(ContractNotFoundError);
  });

  it("otro 404 (factura/convocatoria inexistente) -> NO se confunde con ContractNotFoundError", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Convocatoria no encontrada." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchContractInvoices(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.not.toBeInstanceOf(ContractNotFoundError);
  });
});

describe("createContractInvoice", () => {
  it("hace POST .../contract/invoices con el body exacto -- nunca declara dueDate", async () => {
    const created = { id: "inv-1", contractId: "c1", concepto: "Primera exhibición", amount: "100000.00", invoiceVerifiedOn: "2026-01-05", dueDate: "2026-01-28", legalReference: "Art. 73 LAASSP", paidAt: null, status: "pendiente" as const, createdBy: "u1", createdAt: "2026-01-05T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/invoices");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ concepto: "Primera exhibición", amount: "100000.00", invoiceVerifiedOn: "2026-01-05" });
      expect(body.dueDate).toBeUndefined();
      return new Response(JSON.stringify(created), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createContractInvoice(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { concepto: "Primera exhibición", amount: "100000.00", invoiceVerifiedOn: "2026-01-05" });
    expect(result).toEqual(created);
  });

  it("400 (amount inválido) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Cadena decimal inválida (se esperaba p.ej. "1234.56"): "cien pesos"' }), { status: 400 })) as unknown as typeof fetch;
    await expect(createContractInvoice(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { concepto: "x", amount: "cien pesos", invoiceVerifiedOn: "2026-01-05" })).rejects.toThrow("Cadena decimal inválida");
  });

  it("404 sin contrato -> ContractNotFoundError", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract." }), { status: 404 })) as unknown as typeof fetch;
    await expect(createContractInvoice(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { concepto: "x", amount: "1.00", invoiceVerifiedOn: "2026-01-05" })).rejects.toBeInstanceOf(ContractNotFoundError);
  });
});

describe("markContractInvoicePaid", () => {
  it("hace POST .../contract/invoices/:invoiceId/mark-paid y devuelve la factura actualizada", async () => {
    const paid = { id: "inv-1", contractId: "c1", concepto: "x", amount: "500.00", invoiceVerifiedOn: "2026-01-05", dueDate: "2026-01-28", legalReference: "Art. 73", paidAt: "2026-01-10T00:00:00Z", status: "pagada" as const, createdBy: "u1", createdAt: "2026-01-05T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/invoices/inv-1/mark-paid");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify(paid), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await markContractInvoicePaid(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "inv-1");
    expect(result).toEqual(paid);
  });

  it("404 (factura inexistente) -> propaga el mensaje real, nunca se confunde con ContractNotFoundError", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Factura no encontrada." }), { status: 404 })) as unknown as typeof fetch;
    const promise = markContractInvoicePaid(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "missing");
    await expect(promise).rejects.toThrow("Factura no encontrada.");
    await expect(markContractInvoicePaid(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "missing")).rejects.not.toBeInstanceOf(ContractNotFoundError);
  });
});

describe("fetchReceivablesSummary", () => {
  it("hace GET .../contract/receivables y devuelve el resumen en Decimal tal cual", async () => {
    const summary = { asOfDate: "2026-01-10", totalPending: "1250.75", totalOverdue: "0.00", countPending: 2, countOverdue: 0, invoices: [] };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/receivables");
      return new Response(JSON.stringify(summary), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchReceivablesSummary(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(summary);
  });
});
