// Prueba de dominio (repositorio en memoria, sin HTTP) de
// `LicitacionesRepository.resolveTender`/`listTenderResolutions` -- Fase 16,
// pieza 0. Hasta esta pieza, `licitaciones.tender.status` no tenía NINGÚN
// camino de escritura hacia "won"/"lost" (ver tender-resolution.ts).
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { TenderResolutionRejectedError } from "../src/errors.ts";
import { TENDER_RESOLVABLE_FROM_STATUSES } from "../src/tender-resolution.ts";
import type { TenderStatus } from "../src/types.ts";

const ORG = "org-1";
const TENDER_ID = "tender-1";

function repoWithTenderAt(status: TenderStatus | undefined): InMemoryLicitacionesRepository {
  const repo = new InMemoryLicitacionesRepository();
  repo.seedTender({ id: TENDER_ID, organizationId: ORG, title: "Convocatoria de prueba", submissionDeadline: "2026-12-01T18:00:00-06:00", updatedAt: "2026-01-01T00:00:00Z", status });
  return repo;
}

describe("InMemoryLicitacionesRepository.resolveTender -- resolución won/lost (Fase 16)", () => {
  it("desde 'go' se puede marcar 'won' -- actualiza tender.status y registra el historial en la MISMA operación", async () => {
    const repo = repoWithTenderAt("go");
    const updated = await repo.resolveTender(ORG, TENDER_ID, { resolution: "won", reason: "Fuimos la propuesta técnica y económicamente más solvente.", actorId: "user-1" });
    expect(updated.status).toBe("won");

    const persisted = await repo.findTender(ORG, TENDER_ID);
    expect(persisted!.status).toBe("won");

    const history = await repo.listTenderResolutions(ORG, TENDER_ID);
    expect(history).toHaveLength(1);
    expect(history[0]!.resolution).toBe("won");
    expect(history[0]!.fromStatus).toBe("go");
    expect(history[0]!.resolvedBy).toBe("user-1");
  });

  it("desde 'in_progress' y desde 'submitted' también se puede resolver (los 3 estados intermedios reales)", async () => {
    for (const from of TENDER_RESOLVABLE_FROM_STATUSES) {
      const repo = repoWithTenderAt(from);
      const updated = await repo.resolveTender(ORG, TENDER_ID, { resolution: "lost", reason: "Perdimos ante mejor propuesta económica.", actorId: "user-1" });
      expect(updated.status).toBe("lost");
    }
  });

  it("NUNCA se puede saltar de 'discovered'/'in_review' (sin decisión go/no-go real) directo a won/lost -- 409 vía TenderResolutionRejectedError, ninguna fila se toca", async () => {
    for (const from of ["discovered", "in_review"] as const) {
      const repo = repoWithTenderAt(from);
      await expect(repo.resolveTender(ORG, TENDER_ID, { resolution: "won", reason: "x", actorId: "user-1" })).rejects.toBeInstanceOf(TenderResolutionRejectedError);
      const persisted = await repo.findTender(ORG, TENDER_ID);
      expect(persisted!.status).toBe(from);
      expect(await repo.listTenderResolutions(ORG, TENDER_ID)).toHaveLength(0);
    }
  });

  it("NUNCA se puede resolver desde 'no_go' (ya se decidió activamente no participar)", async () => {
    const repo = repoWithTenderAt("no_go");
    await expect(repo.resolveTender(ORG, TENDER_ID, { resolution: "won", reason: "x", actorId: "user-1" })).rejects.toBeInstanceOf(TenderResolutionRejectedError);
  });

  it("won/lost son terminales -- no se puede volver a resolver una convocatoria ya resuelta", async () => {
    const repo = repoWithTenderAt("go");
    await repo.resolveTender(ORG, TENDER_ID, { resolution: "won", reason: "Ganamos.", actorId: "user-1" });
    await expect(repo.resolveTender(ORG, TENDER_ID, { resolution: "lost", reason: "x", actorId: "user-1" })).rejects.toBeInstanceOf(TenderResolutionRejectedError);
  });

  it("el error trae fromStatus/resolution/allowedFromStatuses para que el cliente sepa exactamente qué pasó, sin adivinar", async () => {
    const repo = repoWithTenderAt("discovered");
    try {
      await repo.resolveTender(ORG, TENDER_ID, { resolution: "won", reason: "x", actorId: "user-1" });
      expect.fail("debía lanzar TenderResolutionRejectedError");
    } catch (err) {
      expect(err).toBeInstanceOf(TenderResolutionRejectedError);
      const e = err as TenderResolutionRejectedError;
      expect(e.fromStatus).toBe("discovered");
      expect(e.resolution).toBe("won");
      expect(e.allowedFromStatuses).toEqual(TENDER_RESOLVABLE_FROM_STATUSES);
    }
  });

  it("resolveTender contra un tender inexistente/de otra organización lanza, nunca crea nada", async () => {
    const repo = repoWithTenderAt("go");
    await expect(repo.resolveTender("otra-org", TENDER_ID, { resolution: "won", reason: "x", actorId: "user-1" })).rejects.toThrow();
  });

  it("listTenderResolutions de una convocatoria sin resolver está vacío", async () => {
    const repo = repoWithTenderAt("go");
    expect(await repo.listTenderResolutions(ORG, TENDER_ID)).toEqual([]);
  });
});
