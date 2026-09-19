// Fase 10 licitaciones — despacho proactivo real de alertas (gap
// identificado por auditoría). Integración real (InMemoryLicitacionesRepository,
// sin HTTP) de los 3 barridos nuevos: renovación transversal, cobranza
// transversal, y el orquestador combinado que además encola correo real.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import type { LicitacionesRepository, TenderUpsertInput } from "@atiende/domain-licitaciones";
import { runAlertNotificationSweep, runCollectionAlertSweep, runRenewalAlertSweep } from "../src/jobs/licitaciones/alert-notifications.ts";

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

describe("runRenewalAlertSweep", () => {
  it("crea una alerta de renovación transversal para un contrato próximo a su fecha de fin", async () => {
    const { tender } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-1" }));
    const actorId = randomUUID();
    const contract = await repo.createContract(organizationId, tender.id, actorId);
    // 75 días de "hoy" (2026-09-14) -- dentro del umbral de 90 días pero fuera de 60/30,
    // así que `computeRenewalAlertCandidates` cruza UN SOLO umbral (evita el caso "varios
    // umbrales a la vez", documentado en renewal-radar.ts, para mantener la aserción simple).
    await repo.updateContractMetadata(organizationId, tender.id, { endDate: "2026-11-28" });

    const sweep = await runRenewalAlertSweep(repo, { todayIsoDate: "2026-09-14" });
    expect(sweep).toEqual([{ organizationId, evaluatedContracts: 1, alertsCreated: 1 }]);

    const alerts = await repo.listRenewalAlerts(organizationId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.contractId).toBe(contract.id);
    expect(alerts[0]!.leadDays).toBe(90);
  });

  it("reescanear el mismo día no duplica la alerta ya emitida para el mismo umbral", async () => {
    const { tender } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-1" }));
    await repo.createContract(organizationId, tender.id, randomUUID());
    // 75 días de "hoy" (2026-09-14) -- dentro del umbral de 90 días pero fuera de 60/30,
    // así que `computeRenewalAlertCandidates` cruza UN SOLO umbral (evita el caso "varios
    // umbrales a la vez", documentado en renewal-radar.ts, para mantener la aserción simple).
    await repo.updateContractMetadata(organizationId, tender.id, { endDate: "2026-11-28" });

    await runRenewalAlertSweep(repo, { todayIsoDate: "2026-09-14" });
    const second = await runRenewalAlertSweep(repo, { todayIsoDate: "2026-09-15" });
    expect(second[0]!.alertsCreated).toBe(0);
    expect(await repo.listRenewalAlerts(organizationId)).toHaveLength(1);
  });

  it("un fallo al escanear UNA organización no detiene el barrido de las demás", async () => {
    const org2 = randomUUID();
    repo.seedOrganization({ id: org2, slug: "org-2", name: "Org 2" });

    const brokenRepo = {
      async listActiveOrganizations() {
        return repo.listActiveOrganizations();
      },
      async systemScanRenewalAlerts(orgId: string, input?: Parameters<LicitacionesRepository["systemScanRenewalAlerts"]>[1]) {
        if (orgId === organizationId) throw new Error("fallo simulado");
        return repo.systemScanRenewalAlerts(orgId, input ?? {});
      },
    } as unknown as LicitacionesRepository;

    const sweep = await runRenewalAlertSweep(brokenRepo);
    const failed = sweep.find((r) => r.organizationId === organizationId)!;
    const ok = sweep.find((r) => r.organizationId === org2)!;
    expect(failed.error).toBe("fallo simulado");
    expect(ok.error).toBeUndefined();
  });
});

describe("runCollectionAlertSweep", () => {
  it("lista las facturas vencidas de TODOS los contratos de la organización", async () => {
    const { tender } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-1" }));
    await repo.createContract(organizationId, tender.id, randomUUID());
    await repo.createContractInvoice(organizationId, tender.id, { concepto: "Factura 1", amount: "1000.00", invoiceVerifiedOn: "2026-06-01", actorId: randomUUID() });

    const sweep = await runCollectionAlertSweep(repo, { todayIsoDate: "2026-09-14" });
    expect(sweep).toEqual([{ organizationId, overdueInvoices: 1 }]);
  });

  it("una factura pagada NUNCA cuenta como vencida", async () => {
    const { tender } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-1" }));
    await repo.createContract(organizationId, tender.id, randomUUID());
    const invoice = await repo.createContractInvoice(organizationId, tender.id, { concepto: "Factura 1", amount: "1000.00", invoiceVerifiedOn: "2026-06-01", actorId: randomUUID() });
    await repo.markContractInvoicePaid(organizationId, tender.id, invoice.id, randomUUID());

    const sweep = await runCollectionAlertSweep(repo, { todayIsoDate: "2026-09-14" });
    expect(sweep).toEqual([{ organizationId, overdueInvoices: 0 }]);
  });
});

describe("runAlertNotificationSweep", () => {
  it("escanea las 3 fuentes y encola un correo real por cada alerta al responsable de la organización", async () => {
    repo.seedNotificationRecipient(organizationId, { email: "owner@empresa.mx", fullName: "Owner" });

    await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-deadline", submissionDeadline: "2026-09-16T18:00:00-06:00" }));
    const { tender: tenderContract } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-renewal" }));
    await repo.createContract(organizationId, tenderContract.id, randomUUID());
    await repo.updateContractMetadata(organizationId, tenderContract.id, { endDate: "2026-11-28" });
    const { tender: tenderInvoice } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-cobranza" }));
    await repo.createContract(organizationId, tenderInvoice.id, randomUUID());
    await repo.createContractInvoice(organizationId, tenderInvoice.id, { concepto: "Factura vencida", amount: "5000.00", invoiceVerifiedOn: "2026-06-01", actorId: randomUUID() });

    const now = new Date("2026-09-14T12:00:00-06:00");
    const sweep = await runAlertNotificationSweep(repo, { now: () => now, todayIsoDate: "2026-09-14" });
    expect(sweep).toHaveLength(1);
    const orgResult = sweep[0]!;
    expect(orgResult.error).toBeUndefined();
    expect(orgResult.deadlineReminders).toEqual({ scanned: 1, created: 1, emailsEnqueued: 1 });
    expect(orgResult.renewalAlerts).toEqual({ evaluatedContracts: 1, alertsCreated: 1, emailsEnqueued: 1 });
    expect(orgResult.collectionAlerts).toEqual({ overdueInvoices: 1, emailsEnqueued: 1 });

    const outbox = repo.getMessagingOutbox();
    expect(outbox).toHaveLength(3);
    expect(outbox.every((j) => j.channel === "email" && j.status === "pending")).toBe(true);
    expect(outbox.map((j) => j.eventType).sort()).toEqual(["contract.invoice_overdue", "contract.renewal_alert", "tender.deadline_reminder"]);
    for (const job of outbox) {
      expect(job.payload.to).toBe("owner@empresa.mx");
      expect(typeof job.payload.subject).toBe("string");
      expect(typeof job.payload.html).toBe("string");
    }
  });

  it("sin ningún responsable (owner/admin) seteado en la organización, escanea igual pero no encola ningún correo", async () => {
    await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-1", submissionDeadline: "2026-09-16T18:00:00-06:00" }));

    const sweep = await runAlertNotificationSweep(repo, { now: () => new Date("2026-09-14T12:00:00-06:00"), todayIsoDate: "2026-09-14" });
    expect(sweep[0]!.deadlineReminders).toEqual({ scanned: 1, created: 1, emailsEnqueued: 0 });
    expect(repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("reescanear NO duplica el correo ya encolado para la MISMA alerta/factura (dedupe real del outbox)", async () => {
    repo.seedNotificationRecipient(organizationId, { email: "owner@empresa.mx", fullName: "Owner" });
    const { tender } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-cobranza" }));
    await repo.createContract(organizationId, tender.id, randomUUID());
    await repo.createContractInvoice(organizationId, tender.id, { concepto: "Factura vencida", amount: "5000.00", invoiceVerifiedOn: "2026-06-01", actorId: randomUUID() });

    await runAlertNotificationSweep(repo, { now: () => new Date("2026-09-14T12:00:00-06:00"), todayIsoDate: "2026-09-14" });
    // `listOverdueContractInvoices` SIEMPRE re-lista la misma factura mientras siga sin
    // pagarse (a diferencia de scanRenewalAlerts/scanUpcomingDeadlineReminders, no hay
    // tabla de "alerta ya emitida" intermedia) -- el dedupe real vive en el outbox.
    await runAlertNotificationSweep(repo, { now: () => new Date("2026-09-15T12:00:00-06:00"), todayIsoDate: "2026-09-15" });

    expect(repo.getMessagingOutbox()).toHaveLength(1);
  });

  it("un fallo en UNA organización no detiene el barrido de las demás", async () => {
    const org2 = randomUUID();
    repo.seedOrganization({ id: org2, slug: "org-2", name: "Org 2" });
    repo.seedNotificationRecipient(org2, { email: "owner2@empresa.mx", fullName: "Owner 2" });
    await repo.upsertTenderManual(org2, baseInput({ externalId: "EXP-2", submissionDeadline: "2026-09-16T18:00:00-06:00" }));

    const brokenRepo = {
      listActiveOrganizations: () => repo.listActiveOrganizations(),
      scanUpcomingDeadlineReminders: async (orgId: string, input?: Parameters<LicitacionesRepository["scanUpcomingDeadlineReminders"]>[1]) => {
        if (orgId === organizationId) throw new Error("fallo simulado");
        return repo.scanUpcomingDeadlineReminders(orgId, input);
      },
      systemScanRenewalAlerts: repo.systemScanRenewalAlerts.bind(repo),
      listOverdueContractInvoices: repo.listOverdueContractInvoices.bind(repo),
      listOrganizationNotificationRecipients: repo.listOrganizationNotificationRecipients.bind(repo),
      enqueueMessagingOutbox: repo.enqueueMessagingOutbox.bind(repo),
    } as unknown as LicitacionesRepository;

    const sweep = await runAlertNotificationSweep(brokenRepo, { now: () => new Date("2026-09-14T12:00:00-06:00"), todayIsoDate: "2026-09-14" });
    const failed = sweep.find((r) => r.organizationId === organizationId)!;
    const ok = sweep.find((r) => r.organizationId === org2)!;
    expect(failed.error).toBe("fallo simulado");
    expect(ok.error).toBeUndefined();
    expect(ok.deadlineReminders.created).toBe(1);
  });
});
