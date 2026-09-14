import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { InvoiceAlreadyExistsError, InvoiceReviewAlreadyResolvedError, ReceivableAlreadyExistsError, ReceivableAlreadyPaidError } from "../src/errors.ts";
import type { NewInvoiceInput } from "../src/types.ts";
import { DEFAULT_MONTHLY_CLOSE_TEMPLATE } from "../src/cierre-mensual/templates.ts";
import { completarTarea } from "../src/cierre-mensual/engine.ts";

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

describe("InMemoryDespachosRepository — cierre mensual (Fase 6)", () => {
  it("insertPeriodoCierre arma las 15 tareas de la plantilla con depends_on resueltos a IDs reales", async () => {
    const repo = new InMemoryDespachosRepository();
    const { periodo, tareas } = await repo.insertPeriodoCierre({ organizationId: "org-1", propertyId: "prop-1", anio: 2026, mes: 3, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });
    expect(periodo.status).toBe("open");
    expect(tareas).toHaveLength(15);

    const cfdiVerificado = tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")!;
    const folios = tareas.find((t) => t.title === "Validar folios fiscales y sellos")!;
    expect(folios.status).toBe("blocked");
    expect(folios.dependsOn).toEqual([cfdiVerificado.id]); // key "cfdi_verificado" resuelta a un UUID real, no la key en texto.

    expect(await repo.findPeriodoCierre("prop-1", periodo.id)).toEqual(periodo);
    expect(await repo.findPeriodoCierrePorAnioMes("prop-1", 2026, 3)).toEqual(periodo);
    expect(await repo.listTareasCierre(periodo.id)).toEqual(tareas);
  });

  it("replaceTareasCierre persiste el resultado de completarTarea (desbloqueo incluido)", async () => {
    const repo = new InMemoryDespachosRepository();
    const { periodo, tareas } = await repo.insertPeriodoCierre({ organizationId: "org-1", propertyId: "prop-1", anio: 2026, mes: 3, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });
    const cfdiVerificado = tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")!;
    const actualizadas = completarTarea(tareas, cfdiVerificado.id, "user-1", new Date().toISOString());
    const persistidas = await repo.replaceTareasCierre(periodo.id, actualizadas);
    expect(await repo.listTareasCierre(periodo.id)).toEqual(persistidas);
    const folios = persistidas.find((t) => t.title === "Validar folios fiscales y sellos")!;
    expect(folios.status).toBe("pending");
  });

  it("updatePeriodoCierre persiste el cierre", async () => {
    const repo = new InMemoryDespachosRepository();
    const { periodo } = await repo.insertPeriodoCierre({ organizationId: "org-1", propertyId: "prop-1", anio: 2026, mes: 3, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });
    const cerrado = { ...periodo, status: "closed" as const, closedAt: new Date().toISOString(), closedBy: "admin-1" };
    await repo.updatePeriodoCierre(cerrado);
    expect(await repo.findPeriodoCierre("prop-1", periodo.id)).toEqual(cerrado);
  });

  it("listPeriodosCierre solo devuelve los períodos de la property pedida", async () => {
    const repo = new InMemoryDespachosRepository();
    await repo.insertPeriodoCierre({ organizationId: "org-1", propertyId: "prop-1", anio: 2026, mes: 1, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });
    await repo.insertPeriodoCierre({ organizationId: "org-1", propertyId: "prop-2", anio: 2026, mes: 1, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });
    const periodos = await repo.listPeriodosCierre("prop-1");
    expect(periodos).toHaveLength(1);
    expect(periodos[0]!.propertyId).toBe("prop-1");
  });
});

describe("InMemoryDespachosRepository — cobranza (Fase 10)", () => {
  it("registra una cuenta por cobrar sobre un invoice ya ingerido y la encuentra por invoice", async () => {
    const repo = new InMemoryDespachosRepository();
    const invoice = await repo.insertInvoice(invoiceInput());
    const receivable = await repo.registerReceivable({ organizationId: invoice.organizationId, propertyId: invoice.propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-03-01" });
    expect(receivable.pagadoEn).toBeNull();
    expect(await repo.findReceivable(invoice.propertyId, receivable.id)).toEqual(receivable);
    expect(await repo.findReceivableByInvoice(invoice.propertyId, invoice.id)).toEqual(receivable);
  });

  it("REQ: un mismo invoice nunca arranca el reloj de cobranza dos veces", async () => {
    const repo = new InMemoryDespachosRepository();
    const invoice = await repo.insertInvoice(invoiceInput());
    await repo.registerReceivable({ organizationId: invoice.organizationId, propertyId: invoice.propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-03-01" });
    await expect(repo.registerReceivable({ organizationId: invoice.organizationId, propertyId: invoice.propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-03-15" })).rejects.toThrow(
      ReceivableAlreadyExistsError,
    );
  });

  it("listReceivables con pendiente:true excluye las ya pagadas", async () => {
    const repo = new InMemoryDespachosRepository();
    const i1 = await repo.insertInvoice(invoiceInput());
    const i2 = await repo.insertInvoice(invoiceInput());
    const r1 = await repo.registerReceivable({ organizationId: i1.organizationId, propertyId: i1.propertyId, invoiceId: i1.id, fechaVencimiento: "2026-01-01" });
    await repo.registerReceivable({ organizationId: i2.organizationId, propertyId: i2.propertyId, invoiceId: i2.id, fechaVencimiento: "2026-02-01" });
    await repo.markReceivablePaid(i1.propertyId, r1.id, new Date().toISOString(), 1160);

    const todas = await repo.listReceivables("prop-1");
    expect(todas).toHaveLength(2);
    const pendientes = await repo.listReceivables("prop-1", { pendiente: true });
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]!.invoiceId).toBe(i2.id);
  });

  it("markReceivablePaid es de un solo sentido — marcar pagada dos veces lanza ReceivableAlreadyPaidError", async () => {
    const repo = new InMemoryDespachosRepository();
    const invoice = await repo.insertInvoice(invoiceInput());
    const receivable = await repo.registerReceivable({ organizationId: invoice.organizationId, propertyId: invoice.propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-01-01" });
    const pagada = await repo.markReceivablePaid(invoice.propertyId, receivable.id, "2026-01-05T00:00:00Z", 1160);
    expect(pagada.pagadoEn).toBe("2026-01-05T00:00:00Z");
    expect(pagada.montoPagado).toBe(1160);
    await expect(repo.markReceivablePaid(invoice.propertyId, receivable.id, new Date().toISOString(), 1160)).rejects.toThrow(ReceivableAlreadyPaidError);
  });

  it("insertCollectionEvent registra el historial de recordatorios/respuestas de una cuenta por cobrar", async () => {
    const repo = new InMemoryDespachosRepository();
    const invoice = await repo.insertInvoice(invoiceInput());
    const receivable = await repo.registerReceivable({ organizationId: invoice.organizationId, propertyId: invoice.propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-01-01" });

    await repo.insertCollectionEvent({ organizationId: invoice.organizationId, propertyId: invoice.propertyId, receivableId: receivable.id, etapa: "recordatorio_formal", canal: "email", respuesta: null });
    const respuesta = await repo.insertCollectionEvent({ organizationId: invoice.organizationId, propertyId: invoice.propertyId, receivableId: receivable.id, etapa: "respuesta", canal: "whatsapp", respuesta: "promesa_pago" });

    const eventos = await repo.listCollectionEvents(invoice.propertyId, receivable.id);
    expect(eventos).toHaveLength(2);
    expect(eventos[1]).toEqual(respuesta);
  });

  it("una cuenta por cobrar de otra property nunca es visible (aislamiento por tenant)", async () => {
    const repo = new InMemoryDespachosRepository();
    const invoice = await repo.insertInvoice(invoiceInput({ propertyId: "prop-1" }));
    const receivable = await repo.registerReceivable({ organizationId: invoice.organizationId, propertyId: "prop-1", invoiceId: invoice.id, fechaVencimiento: "2026-01-01" });
    expect(await repo.findReceivable("prop-2", receivable.id)).toBeNull();
    expect(await repo.findReceivableByInvoice("prop-2", invoice.id)).toBeNull();
  });
});
