import { describe, expect, it } from "vitest";
import { InMemoryHotelesRepository } from "../src/in-memory-repository.ts";
import { IdempotencyConflictError } from "../src/errors.ts";

const ORG = "org-1";
const PROPERTY = "prop-1";
const FOLIO = "folio-1";

function repoWithFolio(): InMemoryHotelesRepository {
  const repo = new InMemoryHotelesRepository();
  repo.seedFolio({
    id: FOLIO,
    organizationId: ORG,
    propertyId: PROPERTY,
    reservationId: "res-1",
    status: "abierto",
    label: "Principal",
    isPrimary: true,
    closedAt: null,
    closeReason: null,
    arApprovedBy: null,
  });
  return repo;
}

describe("InMemoryHotelesRepository.withIdempotency", () => {
  it("misma key + mismo body -> devuelve la MISMA respuesta sin volver a correr run()", async () => {
    const repo = repoWithFolio();
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { status: 201, body: { id: "x" } };
    };
    const first = await repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "k1", body: { a: 1 } }, run);
    const second = await repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "k1", body: { a: 1 } }, run);
    expect(first).toEqual(second);
    expect(calls).toBe(1);
  });

  it("misma key + body DISTINTO -> conflicto explícito, nunca ejecuta la mutación de nuevo en silencio", async () => {
    const repo = repoWithFolio();
    await repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "k2", body: { a: 1 } }, async () => ({ status: 201, body: {} }));
    await expect(
      repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "k2", body: { a: 2 } }, async () => ({ status: 201, body: {} })),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("distintos scopes con la misma key no chocan entre sí", async () => {
    const repo = repoWithFolio();
    const a = await repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "same", body: 1 }, async () => ({ status: 201, body: "a" }));
    const b = await repo.withIdempotency({ organizationId: ORG, scope: "payment.create", key: "same", body: 1 }, async () => ({ status: 201, body: "b" }));
    expect(a.body).toBe("a");
    expect(b.body).toBe("b");
  });
});

describe("InMemoryHotelesRepository -- guardia anti-doble-captura (charge_folio_stay_date_hospedaje_idx)", () => {
  it("bloquea un segundo cargo de hospedaje para la misma noche del mismo folio (simula el índice único parcial)", async () => {
    const repo = repoWithFolio();
    await repo.insertCharge({
      organizationId: ORG,
      propertyId: PROPERTY,
      folioId: FOLIO,
      description: "Hospedaje 2026-10-01",
      amount: 1000,
      taxAmount: 190,
      concept: "hospedaje",
      stayDate: "2026-10-01",
    });
    await expect(
      repo.insertCharge({
        organizationId: ORG,
        propertyId: PROPERTY,
        folioId: FOLIO,
        description: "Hospedaje 2026-10-01 (duplicado del night-audit)",
        amount: 1000,
        taxAmount: 190,
        concept: "hospedaje",
        stayDate: "2026-10-01",
      }),
    ).rejects.toThrow(/charge_folio_stay_date_hospedaje_idx/);
  });

  it("un reverso de un cargo de hospedaje NUNCA choca contra el índice (no lleva stay_date real)", async () => {
    const repo = repoWithFolio();
    const original = await repo.insertCharge({
      organizationId: ORG,
      propertyId: PROPERTY,
      folioId: FOLIO,
      description: "Hospedaje 2026-10-01",
      amount: 1000,
      taxAmount: 190,
      concept: "hospedaje",
      stayDate: "2026-10-01",
    });
    await expect(
      repo.insertCharge({
        organizationId: ORG,
        propertyId: PROPERTY,
        folioId: FOLIO,
        description: "Reverso de hospedaje",
        amount: -1000,
        taxAmount: -190,
        concept: "reverso",
        reversesChargeId: original.id,
        stayDate: "2026-10-01",
      }),
    ).resolves.toBeDefined();
  });

  it("permite el mismo concepto hospedaje en noches distintas", async () => {
    const repo = repoWithFolio();
    await repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "n1", amount: 1000, taxAmount: 190, concept: "hospedaje", stayDate: "2026-10-01" });
    await expect(
      repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "n2", amount: 1000, taxAmount: 190, concept: "hospedaje", stayDate: "2026-10-02" }),
    ).resolves.toBeDefined();
  });
});

describe("InMemoryHotelesRepository -- payment_token_ref_not_pan", () => {
  it("rechaza un token_ref que parece un PAN (12-19 dígitos)", async () => {
    const repo = repoWithFolio();
    await expect(
      repo.insertPayment({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, amount: 100, method: "tarjeta", status: "capturado", tokenRef: "4111111111111111" }),
    ).rejects.toThrow(/payment_token_ref_not_pan/);
  });

  it("acepta un token opaco de procesador", async () => {
    const repo = repoWithFolio();
    await expect(
      repo.insertPayment({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, amount: 100, method: "tarjeta", status: "capturado", tokenRef: "tok_abc123" }),
    ).resolves.toBeDefined();
  });
});

describe("InMemoryHotelesRepository -- reverso de cargo", () => {
  it("no permite reversar dos veces el mismo cargo", async () => {
    const repo = repoWithFolio();
    const original = await repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "extra", amount: 100, taxAmount: 16, concept: "extras" });
    await repo.markChargeReversed(original.id, "reversal-1");
    await expect(repo.markChargeReversed(original.id, "reversal-2")).rejects.toThrow(/reverso_invalido/);
  });
});
