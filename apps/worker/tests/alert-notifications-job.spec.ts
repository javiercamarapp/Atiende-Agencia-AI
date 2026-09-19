// Fase 10 licitaciones — despacho proactivo real de alertas (gap
// identificado por auditoría). Integración real (InMemoryLicitacionesRepository,
// sin HTTP) de los 3 barridos nuevos: renovación transversal, cobranza
// transversal, y el orquestador combinado que además encola correo real.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository, tryEnqueueDeadlineReminderEmails, tryEnqueueOverdueInvoiceEmails, tryEnqueueRenewalAlertEmails } from "@atiende/domain-licitaciones";
import type { LicitacionesRepository, TenderUpsertInput } from "@atiende/domain-licitaciones";
import { runAlertNotificationSweep, runCollectionAlertSweep, runRenewalAlertSweep } from "../src/jobs/licitaciones/alert-notifications.ts";
import { makeAbortSimulatingRepo, makePerCallTransactionalWithRepo, simulateSingleSharedTransaction } from "./support/fake-transactional-engine.ts";

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
    const sweep = await runAlertNotificationSweep((fn) => fn(repo), { now: () => now, todayIsoDate: "2026-09-14" });
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

    const sweep = await runAlertNotificationSweep((fn) => fn(repo), { now: () => new Date("2026-09-14T12:00:00-06:00"), todayIsoDate: "2026-09-14" });
    expect(sweep[0]!.deadlineReminders).toEqual({ scanned: 1, created: 1, emailsEnqueued: 0 });
    expect(repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("reescanear NO duplica el correo ya encolado para la MISMA alerta/factura (dedupe real del outbox)", async () => {
    repo.seedNotificationRecipient(organizationId, { email: "owner@empresa.mx", fullName: "Owner" });
    const { tender } = await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-cobranza" }));
    await repo.createContract(organizationId, tender.id, randomUUID());
    await repo.createContractInvoice(organizationId, tender.id, { concepto: "Factura vencida", amount: "5000.00", invoiceVerifiedOn: "2026-06-01", actorId: randomUUID() });

    await runAlertNotificationSweep((fn) => fn(repo), { now: () => new Date("2026-09-14T12:00:00-06:00"), todayIsoDate: "2026-09-14" });
    // `listOverdueContractInvoices` SIEMPRE re-lista la misma factura mientras siga sin
    // pagarse (a diferencia de scanRenewalAlerts/scanUpcomingDeadlineReminders, no hay
    // tabla de "alerta ya emitida" intermedia) -- el dedupe real vive en el outbox.
    await runAlertNotificationSweep((fn) => fn(repo), { now: () => new Date("2026-09-15T12:00:00-06:00"), todayIsoDate: "2026-09-15" });

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

    const sweep = await runAlertNotificationSweep((fn) => fn(brokenRepo), { now: () => new Date("2026-09-14T12:00:00-06:00"), todayIsoDate: "2026-09-14" });
    const failed = sweep.find((r) => r.organizationId === organizationId)!;
    const ok = sweep.find((r) => r.organizationId === org2)!;
    expect(failed.error).toBe("fallo simulado");
    expect(ok.error).toBeUndefined();
    expect(ok.deadlineReminders.created).toBe(1);
  });
});

// r4-fix-crons-transaccion-por-unidad (auditoría a1b #2, MEDIA) -- reproduce el bug
// real (transacción compartida para TODO el barrido) que ningún test anterior podía
// ver, y prueba que el fix (transacción POR organización) lo cierra. Mismo mecanismo
// que apps/worker/tests/night-audit-job.spec.ts -- ver
// apps/worker/tests/support/fake-transactional-engine.ts.
describe("r4-fix-crons-transaccion-por-unidad -- transacción por organización (reproduce el bug + prueba el fix)", () => {
  let orgB: string;
  let orgC: string;
  const now = () => new Date("2026-09-14T12:00:00-06:00");

  async function seedOrgWithDueDeadlineReminder(orgId: string, slug: string) {
    repo.seedOrganization({ id: orgId, slug, name: `Org ${slug}` });
    repo.seedNotificationRecipient(orgId, { email: `owner-${slug}@empresa.mx`, fullName: `Owner ${slug}` });
    await repo.upsertTenderManual(orgId, baseInput({ externalId: `EXP-${slug}`, submissionDeadline: "2026-09-16T18:00:00-06:00" }));
  }

  beforeEach(async () => {
    // organizationId (del beforeEach de arriba) = "A". B y C son organizaciones
    // HERMANAS -- B falla, y el bug es que su fallo nunca debería contagiar ni a
    // A (anterior) ni a C (posterior).
    repo.seedNotificationRecipient(organizationId, { email: "owner-a@empresa.mx", fullName: "Owner A" });
    await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-a", submissionDeadline: "2026-09-16T18:00:00-06:00" }));
    orgB = randomUUID();
    orgC = randomUUID();
    await seedOrgWithDueDeadlineReminder(orgB, "b");
    await seedOrgWithDueDeadlineReminder(orgC, "c");
  });

  /** Reproduce LITERALMENTE el bucle que `runAlertNotificationSweep` tenía ANTES
   *  de este fix: una sola sesión compartida para TODAS las organizaciones (las 3
   *  sub-operaciones de una organización ya compartían try/catch, eso NO cambió). */
  async function legacySweepAllOrgsInOneSession(repoForEverything: LicitacionesRepository): Promise<{ organizationId: string; ran: boolean; error?: string }[]> {
    const results: { organizationId: string; ran: boolean; error?: string }[] = [];
    for (const org of [{ id: organizationId }, { id: orgB }, { id: orgC }]) {
      try {
        const deadlineScan = await repoForEverything.scanUpcomingDeadlineReminders(org.id, { nowIso: now().toISOString() });
        await tryEnqueueDeadlineReminderEmails(repoForEverything, org.id, deadlineScan.reminders);
        const renewalScan = await repoForEverything.systemScanRenewalAlerts(org.id, {});
        await tryEnqueueRenewalAlertEmails(repoForEverything, org.id, renewalScan.alerts);
        const overdueInvoices = await repoForEverything.listOverdueContractInvoices(org.id, "2026-09-14");
        await tryEnqueueOverdueInvoiceEmails(repoForEverything, org.id, overdueInvoices);
        results.push({ organizationId: org.id, ran: true });
      } catch (err) {
        results.push({ organizationId: org.id, ran: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  it("ANTES del fix (patrón reconstruido): un error SQL real en la organización B revierte en silencio TAMBIÉN el recordatorio YA COMMITEADO de A", async () => {
    const { proxy, isAborted } = makeAbortSimulatingRepo(repo, (method, args) => method === "scanUpcomingDeadlineReminders" && args[0] === orgB, "40P01: deadlock detected (SQL real simulado)");

    const results = await simulateSingleSharedTransaction(repo, isAborted, () => legacySweepAllOrgsInOneSession(proxy));

    expect(results.find((r) => r.organizationId === organizationId)!.ran).toBe(true);
    const resultC = results.find((r) => r.organizationId === orgC)!;
    expect(resultC.ran).toBe(false);
    expect(resultC.error).toMatch(/25P02|aborted/i);

    // El correo real de A, ya encolado, se perdió con el COMMIT->ROLLBACK silencioso.
    expect(repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("DESPUÉS del fix (código real): el mismo error SQL en B se aísla -- A y C SÍ encolan su recordatorio real, solo B se reporta como fallo", async () => {
    const { proxy, reset } = makeAbortSimulatingRepo(repo, (method, args) => method === "scanUpcomingDeadlineReminders" && args[0] === orgB, "40P01: deadlock detected (SQL real simulado)");
    const perCallTxn = makePerCallTransactionalWithRepo(repo);
    const withRepo = async <T>(fn: (r: LicitacionesRepository) => Promise<T>): Promise<T> => {
      try {
        return await perCallTxn(() => fn(proxy));
      } finally {
        reset();
      }
    };

    const sweep = await runAlertNotificationSweep(withRepo, { now, todayIsoDate: "2026-09-14" });

    const resultA = sweep.find((r) => r.organizationId === organizationId)!;
    const resultB = sweep.find((r) => r.organizationId === orgB)!;
    const resultC = sweep.find((r) => r.organizationId === orgC)!;
    expect(resultA.error).toBeUndefined();
    expect(resultA.deadlineReminders.emailsEnqueued).toBe(1);
    expect(resultB.error).toContain("40P01");
    expect(resultC.error).toBeUndefined();
    expect(resultC.deadlineReminders.emailsEnqueued).toBe(1);

    // Los correos de A y C SÍ persisten -- solo B se perdió (y se reporta).
    const outbox = repo.getMessagingOutbox();
    const recipients = outbox.map((j) => (j.payload as { to: string }).to).sort();
    expect(recipients).toEqual(["owner-a@empresa.mx", "owner-c@empresa.mx"]);
  });
});

// r4-fix-crons-transaccion-por-unidad (corrección de PR #163, bloqueante #3) --
// reproduce el hallazgo "PEOR de lo reportado" que este archivo SÍ corrigió en
// despachos/cobranza-reminders.ts pero no aquí: dentro de la transacción por
// organización que YA introdujo el fix de arriba, los pasos 1/2/3 seguían usando las
// variantes `tryEnqueue*` (best-effort, tragan CUALQUIER error SQL real) en vez de las
// `*Core` -- un error SQL real en el ÚLTIMO paso (encolar la alerta de factura
// vencida) quedaba invisible: no aparecía en `failures[]`, la organización se
// reportaba `ok` con sus 3 conteos > 0, y el COMMIT final -- sobre una transacción
// abortada -- revertía en silencio TODOS los pasos de esa organización (incluidos los
// recordatorios de plazo/renovación que sí habían corrido bien).
describe("r4-fix-crons-transaccion-por-unidad -- swap a *Core (reproduce el hallazgo + prueba el fix)", () => {
  const now = () => new Date("2026-09-14T12:00:00-06:00");

  it("un error SQL real al encolar la alerta de factura vencida (paso 3) se reporta en error[] y revierte SOLO los 3 pasos de esa organización -- las demás organizaciones no se ven afectadas", async () => {
    const orgB = randomUUID();
    repo.seedOrganization({ id: orgB, slug: "org-b", name: "Org B" });
    repo.seedNotificationRecipient(organizationId, { email: "owner-a@empresa.mx", fullName: "Owner A" });
    repo.seedNotificationRecipient(orgB, { email: "owner-b@empresa.mx", fullName: "Owner B" });

    // Org A: recordatorio de plazo (paso 1) -- para probar que un fallo del paso 3 de
    // B NUNCA la toca (transacciones ya aisladas por organización).
    await repo.upsertTenderManual(organizationId, baseInput({ externalId: "EXP-a", submissionDeadline: "2026-09-16T18:00:00-06:00" }));

    // Org B: recordatorio de plazo (paso 1, SÍ corre bien) + factura vencida (paso 3,
    // donde se simula el error SQL real al encolar).
    await repo.upsertTenderManual(orgB, baseInput({ externalId: "EXP-b-deadline", submissionDeadline: "2026-09-16T18:00:00-06:00" }));
    const { tender: tenderInvoiceB } = await repo.upsertTenderManual(orgB, baseInput({ externalId: "EXP-b-cobranza" }));
    await repo.createContract(orgB, tenderInvoiceB.id, randomUUID());
    await repo.createContractInvoice(orgB, tenderInvoiceB.id, { concepto: "Factura vencida", amount: "5000.00", invoiceVerifiedOn: "2026-06-01", actorId: randomUUID() });

    const { proxy, reset } = makeAbortSimulatingRepo(
      repo,
      (method, args) => method === "enqueueMessagingOutbox" && args[0] === orgB && args[2] === "contract.invoice_overdue",
      "23505: duplicate key value violates unique constraint (SQL real simulado)",
    );
    const perCallTxn = makePerCallTransactionalWithRepo(repo);
    const withRepo = async <T>(fn: (r: LicitacionesRepository) => Promise<T>): Promise<T> => {
      try {
        return await perCallTxn(() => fn(proxy));
      } finally {
        reset();
      }
    };

    const sweep = await runAlertNotificationSweep(withRepo, { now, todayIsoDate: "2026-09-14" });

    const resultA = sweep.find((r) => r.organizationId === organizationId)!;
    const resultB = sweep.find((r) => r.organizationId === orgB)!;
    expect(resultA.error).toBeUndefined();
    expect(resultA.deadlineReminders.emailsEnqueued).toBe(1);

    // (a) el fallo SÍ se reporta -- antes (tryEnqueue*), `resultB.error` quedaba
    //     `undefined` y `collectionAlerts.emailsEnqueued` reportaba 1 aunque el
    //     INSERT real nunca sobrevivió al COMMIT.
    expect(resultB.error).toContain("23505");

    // (b) la transacción de B (los 3 pasos comparten UNA sola, ver comentario de
    //     cabecera de `runAlertNotificationSweep`) se revirtió COMPLETA -- ni
    //     siquiera el recordatorio de plazo del paso 1, que sí había corrido bien,
    //     sobrevive. Antes de este fix, el paso 1 de B SÍ quedaba commiteado en
    //     silencio en la corrida real de Postgres (el fake `makePerCallTransactionalWithRepo`
    //     solo revierte si `fn` lanza -- que es justo lo que el swap a `*Core` logra:
    //     antes `tryEnqueue*` tragaba el error y `fn` resolvía normal, así que ni
    //     siquiera este fake habría detectado la reversión real de Postgres).
    const outbox = repo.getMessagingOutbox();
    const recipients = outbox.map((j) => (j.payload as { to: string }).to).sort();
    expect(recipients).toEqual(["owner-a@empresa.mx"]);
  });
});
