import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { IdempotencyConflictError } from "../src/errors.ts";

const ORG = "org-1";
const TENDER_ID = "tender-1";

function repoWithTender(submissionDeadline: string | null = "2026-12-01T18:00:00-06:00"): InMemoryLicitacionesRepository {
  const repo = new InMemoryLicitacionesRepository();
  repo.seedTender({ id: TENDER_ID, organizationId: ORG, title: "Convocatoria de prueba", submissionDeadline, updatedAt: "2026-01-01T00:00:00Z" });
  return repo;
}

describe("InMemoryLicitacionesRepository -- expediente", () => {
  it("getOrCreateProposal es idempotente por (organizationId, tenderId)", async () => {
    const repo = repoWithTender();
    const first = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const second = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    expect(second.id).toBe(first.id);
  });

  it("findTender nunca cruza organizaciones", async () => {
    const repo = repoWithTender();
    expect(await repo.findTender("otra-org", TENDER_ID)).toBeNull();
  });

  it("listApprovedRates filtra server-side por aprobación y vigencia a asOfIso", async () => {
    const repo = repoWithTender();
    repo.seedApprovedRates(ORG, [
      { id: "r1", concept: "vigente", unitPrice: "10.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null },
      { id: "r2", concept: "vencida", unitPrice: "10.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: "2026-02-01T00:00:00-06:00" },
      { id: "r3", concept: "no_aprobada", unitPrice: "10.00", currency: "MXN", approvalStatus: "pendiente_aprobacion", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null },
    ]);
    const rates = await repo.listApprovedRates(ORG, "2026-06-01T00:00:00-06:00");
    expect(rates.map((r) => r.concept)).toEqual(["vigente"]);
  });
});

describe("InMemoryLicitacionesRepository -- aprobación de expediente", () => {
  it("approveExpediente invalida cualquier aprobación 'vigente' previa antes de crear la nueva", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const first = await repo.approveExpediente(ORG, proposal.id, "user-1", "owner", "hash-v1");
    const second = await repo.approveExpediente(ORG, proposal.id, "user-1", "owner", "hash-v2");
    const current = await repo.findCurrentExpedienteApproval(ORG, proposal.id);
    expect(current!.id).toBe(second.id);
    expect(current!.inputsHash).toBe("hash-v2");
    expect(first.id).not.toBe(second.id);
  });
});

describe("InMemoryLicitacionesRepository -- idempotencia", () => {
  it("la misma Idempotency-Key con el mismo cuerpo devuelve el resultado ya calculado, sin re-ejecutar", async () => {
    const repo = repoWithTender();
    let calls = 0;
    const run = () => {
      calls += 1;
      return Promise.resolve({ status: 201, body: { ok: true } });
    };
    await repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k1", body: { a: 1 } }, run);
    await repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k1", body: { a: 1 } }, run);
    expect(calls).toBe(1);
  });

  it("la misma Idempotency-Key con un cuerpo DISTINTO lanza IdempotencyConflictError", async () => {
    const repo = repoWithTender();
    const run = () => Promise.resolve({ status: 201, body: { ok: true } });
    await repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k1", body: { a: 1 } }, run);
    await expect(repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k1", body: { a: 2 } }, run)).rejects.toThrow(IdempotencyConflictError);
  });
});

describe("InMemoryLicitacionesRepository -- computeCurrentInputsHash", () => {
  it("produce un HashedInputs sellado y determinista para el mismo estado", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const a = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    const b = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    expect(a.hash).toBe(b.hash);
  });

  it("el hash cambia cuando cambia una tarifa realmente usada en generation_report.economic.usedRateConcepts", async () => {
    const repo = repoWithTender();
    repo.seedApprovedRates(ORG, [{ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const before = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);

    await repo.saveEconomicGeneration(ORG, proposal.id, { economicTotals: { total: "500.00" }, generationReportPatch: { usedRateConcepts: ["consultoria_hora"], blockedLineItems: [], totals: { total: "500.00" } }, correlationId: null });
    const afterUsingRate = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    expect(afterUsingRate.hash).not.toBe(before.hash);

    // Cambia la tarifa realmente usada -> el hash de insumos debe reflejarlo.
    repo.seedApprovedRates(ORG, [{ id: "r1", concept: "consultoria_hora", unitPrice: "999.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);
    const afterRateChanged = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    expect(afterRateChanged.hash).not.toBe(afterUsingRate.hash);
  });
});
