// Fase 8 licitaciones — recordatorios automáticos de plazo (gap identificado
// por la auditoría). Integración real (InMemoryLicitacionesRepository, sin
// HTTP) del barrido que persiste un recordatorio por cada convocatoria con
// `submissionDeadline` dentro de la ventana de anticipación.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import type { LicitacionesRepository, TenderUpsertInput } from "@atiende/domain-licitaciones";
import { runDeadlineReminderSweep } from "../src/jobs/licitaciones/deadline-reminders.ts";

let repo: InMemoryLicitacionesRepository;
let organizationId: string;

function baseInput(overrides: Partial<TenderUpsertInput> = {}): TenderUpsertInput {
  return {
    title: "Convocatoria de prueba",
    submissionDeadline: null,
    externalId: null,
    contractingBody: null,
    cpvCodes: [],
    budgetAmount: null,
    currency: "MXN",
    state: null,
    procedureTypeRaw: null,
    actorId: randomUUID(),
    ...overrides,
  };
}

beforeEach(() => {
  repo = new InMemoryLicitacionesRepository();
  organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "org-test", name: "Org de prueba" });
});

describe("runDeadlineReminderSweep", () => {
  it("crea un recordatorio para una convocatoria cuyo vencimiento cae dentro de la ventana de anticipación", async () => {
    const now = new Date("2026-09-14T12:00:00-06:00");
    const { tender } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-1", submissionDeadline: "2026-09-16T18:00:00-06:00" }));

    const sweep = await runDeadlineReminderSweep(repo, { now: () => now });
    expect(sweep).toEqual([{ organizationId, scanned: 1, created: 1 }]);

    const reminders = await repo.listTenderDeadlineReminders(organizationId);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.tenderId).toBe(tender.id);
    expect(reminders[0]!.daysRemaining).toBe(3);
    expect(reminders[0]!.acknowledgedAt).toBeNull();
  });

  it("NO crea recordatorio para un vencimiento fuera de la ventana (ni muy próximo, ni ya pasado)", async () => {
    const now = new Date("2026-09-14T12:00:00-06:00");
    await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-lejos", submissionDeadline: "2026-12-01T00:00:00-06:00" }));
    await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-vencido", submissionDeadline: "2026-09-01T00:00:00-06:00" }));

    const sweep = await runDeadlineReminderSweep(repo, { now: () => now });
    expect(sweep).toEqual([{ organizationId, scanned: 0, created: 0 }]);
  });

  it("excluye convocatorias en estado terminal (cancelled/lost/won/submitted)", async () => {
    const now = new Date("2026-09-14T12:00:00-06:00");
    const { tender } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-cancelada", submissionDeadline: "2026-09-16T00:00:00-06:00" }));
    await repo.createGoNoGoDecision(organizationId, tender.id, {
      decision: "no_go",
      reasons: ["fuera de alcance"],
      matchScore: 0,
      matchEligibilityStatus: "no_cumple",
      matchInputsHash: "x",
      actorId: randomUUID(),
      actorRole: "owner",
    });
    const cancelled = await repo.findTender(organizationId, tender.id);
    expect(cancelled!.status).toBe("no_go"); // no_go SÍ debe seguir recordándose (no es terminal) -- confirma el fixture antes de la aserción real de abajo.

    const sweep = await runDeadlineReminderSweep(repo, { now: () => now });
    expect(sweep[0]!.created).toBe(1); // no_go no está excluido -- solo cancelled/lost/won/submitted lo están (ver scanUpcomingDeadlineReminders).
  });

  it("reescanear dentro de la MISMA ventana no duplica el recordatorio ya emitido para el mismo (tender, día)", async () => {
    const now = new Date("2026-09-14T12:00:00-06:00");
    await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-1", submissionDeadline: "2026-09-16T18:00:00-06:00" }));

    await runDeadlineReminderSweep(repo, { now: () => now });
    const second = await runDeadlineReminderSweep(repo, { now: () => new Date(now.getTime() + 60_000) });
    expect(second).toEqual([{ organizationId, scanned: 1, created: 0 }]);
    expect(await repo.listTenderDeadlineReminders(organizationId)).toHaveLength(1);
  });

  it("acknowledgeTenderDeadlineReminder marca el recordatorio como reconocido", async () => {
    const now = new Date("2026-09-14T12:00:00-06:00");
    await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-1", submissionDeadline: "2026-09-16T18:00:00-06:00" }));
    await runDeadlineReminderSweep(repo, { now: () => now });
    const [reminder] = await repo.listTenderDeadlineReminders(organizationId);
    const actorId = randomUUID();

    const acknowledged = await repo.acknowledgeTenderDeadlineReminder(organizationId, reminder!.id, actorId);
    expect(acknowledged.acknowledgedAt).not.toBeNull();
    expect(acknowledged.acknowledgedBy).toBe(actorId);
  });

  it("un fallo al escanear UNA organización no detiene el barrido de las demás", async () => {
    const org2 = randomUUID();
    repo.seedOrganization({ id: org2, slug: "org-2", name: "Org 2" });

    // Fake mínimo (duck-typed) que implementa SOLO lo que este job llama --
    // deliberadamente distinto de monkey-parchar un método del repositorio real,
    // que arrastraría el tipo completo de la clase para un solo caso de prueba.
    const brokenRepo = {
      async listActiveOrganizations() {
        return repo.listActiveOrganizations();
      },
      async scanUpcomingDeadlineReminders(orgId: string, input?: Parameters<LicitacionesRepository["scanUpcomingDeadlineReminders"]>[1]) {
        if (orgId === organizationId) throw new Error("fallo simulado");
        return repo.scanUpcomingDeadlineReminders(orgId, input);
      },
    } as unknown as LicitacionesRepository;

    const sweep = await runDeadlineReminderSweep(brokenRepo);
    const failed = sweep.find((r) => r.organizationId === organizationId)!;
    const ok = sweep.find((r) => r.organizationId === org2)!;
    expect(failed.error).toBe("fallo simulado");
    expect(ok.error).toBeUndefined();
  });
});
