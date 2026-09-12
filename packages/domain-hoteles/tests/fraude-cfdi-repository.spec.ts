// Fase 5 — pruebas de la capa de repositorio (adaptador en memoria) para la cola de
// revisión de fraude y la persistencia de CFDI de hospedaje: idempotencia por
// dedupeKey/folio, y que una alerta ya resuelta no pueda resolverse dos veces (mismo
// criterio que InvoiceReviewAlreadyResolvedError de domain-despachos).
import { describe, expect, it } from "vitest";
import { InMemoryHotelesRepository } from "../src/in-memory-repository.ts";
import { FraudAlertAlreadyResolvedError } from "../src/errors.ts";

const ORG = "org-1";
const PROPERTY = "prop-1";
const FOLIO = "folio-1";

function newAlertInput(overrides: Partial<Parameters<InMemoryHotelesRepository["recordFraudAlert"]>[0]> = {}) {
  return {
    organizationId: ORG,
    propertyId: PROPERTY,
    pattern: "descuento_fuera_de_politica" as const,
    folioId: FOLIO,
    chargeId: "charge-1",
    paymentId: null,
    reason: "descuento fuera de política",
    evidence: { discountAmount: 1000 },
    recipientRoles: ["owner", "gm"],
    dedupeKey: "descuento_fuera_de_politica:charge-1",
    ...overrides,
  };
}

describe("InMemoryHotelesRepository -- cola de revisión de fraude", () => {
  it("recordFraudAlert es idempotente por (propertyId, dedupeKey): un re-escaneo NUNCA duplica la alerta", async () => {
    const repo = new InMemoryHotelesRepository();
    const first = await repo.recordFraudAlert(newAlertInput());
    expect(first.isNew).toBe(true);

    const second = await repo.recordFraudAlert(newAlertInput());
    expect(second.isNew).toBe(false);
    expect(second.record.id).toBe(first.record.id);

    const alerts = await repo.listFraudAlerts(PROPERTY);
    expect(alerts).toHaveLength(1);
  });

  it("resolveFraudAlert transiciona pendiente -> confirmado/descartado y registra quién/cuándo", async () => {
    const repo = new InMemoryHotelesRepository();
    const { record } = await repo.recordFraudAlert(newAlertInput());
    expect(record.status).toBe("pendiente");

    const resolved = await repo.resolveFraudAlert(PROPERTY, record.id, "user-owner", "confirmado", "sí era fraude");
    expect(resolved.status).toBe("confirmado");
    expect(resolved.resolvedBy).toBe("user-owner");
    expect(resolved.decisionNote).toBe("sí era fraude");
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("una alerta ya resuelta no puede resolverse de nuevo", async () => {
    const repo = new InMemoryHotelesRepository();
    const { record } = await repo.recordFraudAlert(newAlertInput());
    await repo.resolveFraudAlert(PROPERTY, record.id, "user-owner", "descartado", null);
    await expect(repo.resolveFraudAlert(PROPERTY, record.id, "user-owner", "confirmado", null)).rejects.toBeInstanceOf(FraudAlertAlreadyResolvedError);
  });

  it("listFraudAlerts filtra por status", async () => {
    const repo = new InMemoryHotelesRepository();
    const { record: a } = await repo.recordFraudAlert(newAlertInput({ dedupeKey: "d1", chargeId: "c1" }));
    await repo.recordFraudAlert(newAlertInput({ dedupeKey: "d2", chargeId: "c2" }));
    await repo.resolveFraudAlert(PROPERTY, a.id, "user-owner", "confirmado", null);

    expect(await repo.listFraudAlerts(PROPERTY, { status: "pendiente" })).toHaveLength(1);
    expect(await repo.listFraudAlerts(PROPERTY, { status: "confirmado" })).toHaveLength(1);
    expect(await repo.listFraudAlerts(PROPERTY)).toHaveLength(2);
  });
});

describe("InMemoryHotelesRepository -- listado de insumos de escaneo de fraude", () => {
  it("listDiscountChargesForFraudScan lee solo cargos concept='descuento' no reversados", async () => {
    const repo = new InMemoryHotelesRepository();
    const descuento = await repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "descuento", amount: -1000, taxAmount: 0, concept: "descuento" });
    await repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "hospedaje", amount: 1000, taxAmount: 190, concept: "hospedaje" });
    const reversado = await repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "descuento reversado", amount: -500, taxAmount: 0, concept: "descuento" });
    await repo.markChargeReversed(reversado.id, descuento.id);

    const rows = await repo.listDiscountChargesForFraudScan(PROPERTY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chargeId).toBe(descuento.id);
  });

  it("listReopenedFolioChargesForFraudScan detecta cargos creados DESPUÉS del cierre del folio", async () => {
    const repo = new InMemoryHotelesRepository();
    repo.seedFolio({ id: FOLIO, organizationId: ORG, propertyId: PROPERTY, reservationId: "res-1", status: "cerrado", label: "Principal", isPrimary: true, closedAt: "2026-01-01T00:00:00.000Z", closeReason: "saldo_cero", arApprovedBy: null });
    const charge = await repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "cargo post-cierre", amount: 100, taxAmount: 16, concept: "otro" });

    const rows = await repo.listReopenedFolioChargesForFraudScan(PROPERTY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chargeId).toBe(charge.id);
    expect(rows[0]!.folioId).toBe(FOLIO);
  });
});

describe("InMemoryHotelesRepository -- CFDI de hospedaje (REQ-BO-002 idempotencia)", () => {
  function repoWithFolio(): InMemoryHotelesRepository {
    const repo = new InMemoryHotelesRepository();
    repo.seedFolio({ id: FOLIO, organizationId: ORG, propertyId: PROPERTY, reservationId: "res-1", status: "abierto", label: "Principal", isPrimary: true, closedAt: null, closeReason: null, arApprovedBy: null });
    return repo;
  }

  function cfdiInput(overrides: Partial<Parameters<InMemoryHotelesRepository["insertCfdiEmision"]>[0]> = {}) {
    return {
      organizationId: ORG,
      propertyId: PROPERTY,
      folioId: FOLIO,
      tipo: "hospedaje" as const,
      uuidFiscal: "11111111-1111-1111-1111-111111111111",
      status: "timbrado" as const,
      pac: "finkok",
      subtotal: 1000,
      iva: 160,
      ishTasa: 0.03,
      ishMonto: 30,
      dsaMonto: 20,
      total: 1210,
      rfcReceptor: "XAXX010101000",
      usoCfdi: "S01",
      metodoPago: "PUE",
      esExtranjero: false,
      esGlobal: false,
      esNoShow: false,
      relatedCfdiId: null,
      paymentId: null,
      ...overrides,
    };
  }

  it("a lo más UN CFDI de tipo 'hospedaje' por folio -- reintentar devuelve el mismo, nunca duplica", async () => {
    const repo = repoWithFolio();
    const first = await repo.insertCfdiEmision(cfdiInput());
    const second = await repo.insertCfdiEmision(cfdiInput({ uuidFiscal: "22222222-2222-2222-2222-222222222222" }));
    expect(second.id).toBe(first.id);
    expect(second.uuidFiscal).toBe(first.uuidFiscal);

    const all = await repo.listCfdiEmisiones(PROPERTY);
    expect(all).toHaveLength(1);
  });

  it("findCfdiEmisionByFolio / findCfdiEmision devuelven el registro real", async () => {
    const repo = repoWithFolio();
    const created = await repo.insertCfdiEmision(cfdiInput());
    expect(await repo.findCfdiEmisionByFolio(PROPERTY, FOLIO, "hospedaje")).toEqual(created);
    expect(await repo.findCfdiEmision(PROPERTY, created.id)).toEqual(created);
  });

  it("updateCfdiEmisionCancelacion marca cancelado con canceledAt", async () => {
    const repo = repoWithFolio();
    const created = await repo.insertCfdiEmision(cfdiInput());
    await repo.updateCfdiEmisionCancelacion(created.id, "cancelado");
    const updated = await repo.findCfdiEmision(PROPERTY, created.id);
    expect(updated!.status).toBe("cancelado");
    expect(updated!.canceledAt).not.toBeNull();
  });

  it("a lo más UN CFDI de tipo 'pago' por payment -- idempotente por paymentId", async () => {
    const repo = repoWithFolio();
    const first = await repo.insertCfdiEmision(cfdiInput({ tipo: "pago", paymentId: "pay-1", subtotal: 0, iva: 0, ishMonto: 0, dsaMonto: 0, total: 500 }));
    const second = await repo.insertCfdiEmision(cfdiInput({ tipo: "pago", paymentId: "pay-1", subtotal: 0, iva: 0, ishMonto: 0, dsaMonto: 0, total: 999 }));
    expect(second.id).toBe(first.id);
  });
});
