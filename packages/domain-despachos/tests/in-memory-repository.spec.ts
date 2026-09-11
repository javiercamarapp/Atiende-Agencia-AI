import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { InvoiceAlreadyExistsError, InvoiceReviewAlreadyResolvedError } from "../src/errors.ts";
import type { NewInvoiceInput } from "../src/types.ts";

function invoiceInput(overrides: Partial<NewInvoiceInput> = {}): NewInvoiceInput {
  return {
    organizationId: "org-1",
    propertyId: "prop-1",
    folioFiscal: randomUUID(),
    tipo: "I",
    rfcEmisor: "CON950820K12",
    rfcReceptor: "XAXX010101000",
    emisorNombre: "PROVEEDOR",
    subtotal: 1000,
    total: 1160,
    iva: 160,
    descuento: 0,
    categoria: "sin_clasificar",
    valido: true,
    issues: [],
    warnings: [],
    requiresHumanReview: true,
    diot: { proveedoresReportables: [], reportable: true },
    ...overrides,
  };
}

describe("InMemoryDespachosRepository — invoices", () => {
  it("inserta y recupera un invoice por id y por folio fiscal", async () => {
    const repo = new InMemoryDespachosRepository();
    const input = invoiceInput();
    const created = await repo.insertInvoice(input);
    expect(await repo.findInvoice(input.propertyId, created.id)).toEqual(created);
    expect(await repo.findInvoiceByFolioFiscal(input.organizationId, input.folioFiscal)).toEqual(created);
  });

  it("REQ: el folio fiscal es único por organización — reintentar el mismo CFDI nunca lo duplica", async () => {
    const repo = new InMemoryDespachosRepository();
    const folioFiscal = randomUUID();
    await repo.insertInvoice(invoiceInput({ folioFiscal }));
    await expect(repo.insertInvoice(invoiceInput({ folioFiscal }))).rejects.toThrow(InvoiceAlreadyExistsError);
  });

  it("listInvoices filtra por requiresHumanReview", async () => {
    const repo = new InMemoryDespachosRepository();
    await repo.insertInvoice(invoiceInput({ requiresHumanReview: true }));
    await repo.insertInvoice(invoiceInput({ requiresHumanReview: false }));
    const pendientes = await repo.listInvoices("prop-1", { requiresHumanReview: true });
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]!.requiresHumanReview).toBe(true);
  });

  it("un invoice de otra property nunca es visible (aislamiento por tenant)", async () => {
    const repo = new InMemoryDespachosRepository();
    const created = await repo.insertInvoice(invoiceInput({ propertyId: "prop-1" }));
    expect(await repo.findInvoice("prop-2", created.id)).toBeNull();
  });
});

describe("InMemoryDespachosRepository — cola de revisión humana", () => {
  it("crea una revisión pendiente y la resuelve una sola vez", async () => {
    const repo = new InMemoryDespachosRepository();
    const invoice = await repo.insertInvoice(invoiceInput());
    const review = await repo.createReview({ organizationId: invoice.organizationId, propertyId: invoice.propertyId, invoiceId: invoice.id, reason: "DIOT reportable" });
    expect(review.status).toBe("pendiente");
    expect((await repo.listPendingReviews(invoice.propertyId)).map((r) => r.id)).toContain(review.id);

    const resolved = await repo.resolveReview(invoice.propertyId, review.id, "user-1", "aprobado", "revisado y correcto");
    expect(resolved.status).toBe("aprobado");
    expect(resolved.resolvedBy).toBe("user-1");
    expect((await repo.listPendingReviews(invoice.propertyId))).toHaveLength(0);
  });

  it("resolver dos veces la misma revisión lanza InvoiceReviewAlreadyResolvedError", async () => {
    const repo = new InMemoryDespachosRepository();
    const invoice = await repo.insertInvoice(invoiceInput());
    const review = await repo.createReview({ organizationId: invoice.organizationId, propertyId: invoice.propertyId, invoiceId: invoice.id, reason: "DIOT" });
    await repo.resolveReview(invoice.propertyId, review.id, "user-1", "aprobado", null);
    await expect(repo.resolveReview(invoice.propertyId, review.id, "user-2", "rechazado", null)).rejects.toThrow(InvoiceReviewAlreadyResolvedError);
  });
});

describe("InMemoryDespachosRepository — vencimientos fiscales", () => {
  it("crea un vencimiento, lo marca completado y registra escalamientos", async () => {
    const repo = new InMemoryDespachosRepository();
    const deadline = await repo.createDeadline({ organizationId: "org-1", propertyId: "prop-1", tipo: "ISR", periodo: "2026-06", fechaLimite: "2026-07-17", prioridad: "media" });
    expect(deadline.estado).toBe("pendiente");

    await repo.insertEscalation(deadline.id, "nivel_1", new Date().toISOString(), "recordatorio interno");
    expect(await repo.listEscalations(deadline.id)).toHaveLength(1);

    const completed = await repo.markDeadlineCompleted(deadline.id, "https://ejemplo.mx/acuse.pdf", "2026-07-10");
    expect(completed?.estado).toBe("completado");
    expect(completed?.comprobanteUrl).toBe("https://ejemplo.mx/acuse.pdf");
  });

  it("listDeadlines filtra por estado", async () => {
    const repo = new InMemoryDespachosRepository();
    const d1 = await repo.createDeadline({ organizationId: "org-1", propertyId: "prop-1", tipo: "IVA", periodo: "2026-06", fechaLimite: "2026-07-17", prioridad: "media" });
    await repo.createDeadline({ organizationId: "org-1", propertyId: "prop-1", tipo: "DIOT", periodo: "2026-06", fechaLimite: "2026-07-17", prioridad: "media" });
    await repo.updateDeadlineEstado(d1.id, "vencido");
    const vencidos = await repo.listDeadlines("prop-1", { estado: "vencido" });
    expect(vencidos).toHaveLength(1);
    expect(vencidos[0]!.id).toBe(d1.id);
  });
});
