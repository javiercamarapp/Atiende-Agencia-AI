// Primer job real del vertical despachos (hallazgo de auditoría, severidad
// ALTA: "ningún job en apps/worker/src/jobs para despachos"). Integración
// real (InMemoryDespachosRepository, sin HTTP) del barrido transversal de
// recordatorios de cobranza. Mismo patrón EXACTO que
// apps/worker/tests/alert-notifications-job.spec.ts (leído primero como
// plantilla).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import type { DespachosRepository, NewInvoiceInput } from "@atiende/domain-despachos";
import { runCobranzaReminderSweep, sweepProperty } from "../src/jobs/despachos/cobranza-reminders.ts";
import { makeAbortSimulatingRepo, makePerCallTransactionalWithRepo, simulateSingleSharedTransaction } from "./support/fake-transactional-engine.ts";

let repo: InMemoryDespachosRepository;
let organizationId: string;
let propertyId: string;

function invoiceInput(overrides: Partial<NewInvoiceInput> = {}): NewInvoiceInput {
  return {
    organizationId,
    propertyId,
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
    requiresHumanReview: false,
    diot: { proveedoresReportables: [], reportable: false },
    fecha: "2026-08-01",
    ...overrides,
  };
}

beforeEach(() => {
  repo = new InMemoryDespachosRepository();
  organizationId = randomUUID();
  propertyId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "despacho-test", name: "Despacho de Prueba SC" });
  repo.seedDespachosProperty({ id: propertyId, organizationId, name: "Sede principal" });
});

describe("runCobranzaReminderSweep", () => {
  it("una cuenta por cobrar cuya etapa de HOY es 'vencimiento' (con correo capturado) encola el recordatorio real", async () => {
    const invoice = await repo.insertInvoice(invoiceInput());
    await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-09-14", clienteNombre: "Cliente A", clienteEmail: "cliente-a@example.com" });

    const sweep = await runCobranzaReminderSweep((fn) => fn(repo), { todayIsoDate: "2026-09-14" });

    expect(sweep).toHaveLength(1);
    const orgResult = sweep[0]!;
    expect(orgResult.error).toBeUndefined();
    expect(orgResult.properties).toEqual([{ propertyId, receivablesScanned: 1, remindersDue: 1, emailsEnqueued: 1 }]);

    const outbox = repo.getMessagingOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe("cobranza.vencimiento");
    const payload = outbox[0]!.payload as { to: string };
    expect(payload.to).toBe("cliente-a@example.com");
  });

  it("una cuenta cuya fecha no coincide con NINGUNA etapa de hoy no genera ningún recordatorio", async () => {
    const invoice = await repo.insertInvoice(invoiceInput());
    // 3 días antes del vencimiento -- no coincide con ninguna de las 5 etapas
    // reales (-7/0/+7/+30/+60), ver cobranza/engine.ts::etapaRecordatorioCobranzaHoy.
    await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-09-17", clienteEmail: "cliente@example.com" });

    const sweep = await runCobranzaReminderSweep((fn) => fn(repo), { todayIsoDate: "2026-09-14" });

    expect(sweep[0]!.properties).toEqual([{ propertyId, receivablesScanned: 1, remindersDue: 0, emailsEnqueued: 0 }]);
    expect(repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("una cuenta sin clienteEmail capturado: la etapa cuenta como 'due' pero no encola ningún correo", async () => {
    const invoice = await repo.insertInvoice(invoiceInput());
    await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-09-14" });

    const sweep = await runCobranzaReminderSweep((fn) => fn(repo), { todayIsoDate: "2026-09-14" });

    expect(sweep[0]!.properties).toEqual([{ propertyId, receivablesScanned: 1, remindersDue: 1, emailsEnqueued: 0 }]);
    expect(repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("una cuenta ya pagada nunca cuenta como pendiente (queda fuera del barrido)", async () => {
    const invoice = await repo.insertInvoice(invoiceInput());
    const receivable = await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-09-14", clienteEmail: "cliente@example.com" });
    await repo.markReceivablePaid(propertyId, receivable.id, "2026-09-01T00:00:00.000Z", 1160);

    const sweep = await runCobranzaReminderSweep((fn) => fn(repo), { todayIsoDate: "2026-09-14" });
    expect(sweep[0]!.properties).toEqual([{ propertyId, receivablesScanned: 0, remindersDue: 0, emailsEnqueued: 0 }]);
  });

  it("reescanear el mismo día no duplica el correo ya encolado para la MISMA etapa (dedupe real del outbox)", async () => {
    const invoice = await repo.insertInvoice(invoiceInput());
    await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-09-14", clienteEmail: "cliente@example.com" });

    await runCobranzaReminderSweep((fn) => fn(repo), { todayIsoDate: "2026-09-14" });
    await runCobranzaReminderSweep((fn) => fn(repo), { todayIsoDate: "2026-09-14" });

    expect(repo.getMessagingOutbox()).toHaveLength(1);
  });

  it("un fallo al listar properties de UNA organización no detiene el barrido de las demás", async () => {
    const org2 = randomUUID();
    const property2 = randomUUID();
    repo.seedOrganization({ id: org2, slug: "despacho-2", name: "Despacho 2" });
    repo.seedDespachosProperty({ id: property2, organizationId: org2, name: "Sede 2" });

    const brokenRepo = {
      listActiveOrganizations: () => repo.listActiveOrganizations(),
      listPropertiesForOrganization: async (orgId: string) => {
        if (orgId === organizationId) throw new Error("fallo simulado");
        return repo.listPropertiesForOrganization(orgId);
      },
      systemListPendingReceivablesForReminders: repo.systemListPendingReceivablesForReminders.bind(repo),
      systemRecordCollectionEvent: repo.systemRecordCollectionEvent.bind(repo),
      enqueueMessagingOutbox: repo.enqueueMessagingOutbox.bind(repo),
    } as unknown as DespachosRepository;

    const sweep = await runCobranzaReminderSweep((fn) => fn(brokenRepo), { todayIsoDate: "2026-09-14" });
    const failed = sweep.find((r) => r.organizationId === organizationId)!;
    const ok = sweep.find((r) => r.organizationId === org2)!;
    expect(failed.error).toBe("fallo simulado");
    expect(ok.error).toBeUndefined();
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
  let propB: string;
  let propC: string;

  async function seedOrgWithDueReceivable(orgId: string, propId: string, slug: string) {
    repo.seedOrganization({ id: orgId, slug, name: `Despacho ${slug}` });
    repo.seedDespachosProperty({ id: propId, organizationId: orgId, name: `Sede ${slug}` });
    const invoice = await repo.insertInvoice(invoiceInput({ organizationId: orgId, propertyId: propId }));
    await repo.registerReceivable({ organizationId: orgId, propertyId: propId, invoiceId: invoice.id, fechaVencimiento: "2026-09-14", clienteNombre: `Cliente ${slug}`, clienteEmail: `cliente-${slug}@example.com` });
  }

  beforeEach(async () => {
    // organizationId/propertyId (del beforeEach de arriba) = "A", con su propia
    // cuenta por cobrar YA sembrada. B y C son organizaciones HERMANAS -- B falla,
    // y el bug es que su fallo nunca debería contagiar ni a A (anterior) ni a C
    // (posterior).
    const invoiceA = await repo.insertInvoice(invoiceInput());
    await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoiceA.id, fechaVencimiento: "2026-09-14", clienteNombre: "Cliente A", clienteEmail: "cliente-a@example.com" });
    orgB = randomUUID();
    orgC = randomUUID();
    propB = randomUUID();
    propC = randomUUID();
    await seedOrgWithDueReceivable(orgB, propB, "b");
    await seedOrgWithDueReceivable(orgC, propC, "c");
  });

  /** Reproduce LITERALMENTE el bucle que `runCobranzaReminderSweep` tenía ANTES de
   *  este fix: una sola sesión compartida para TODAS las organizaciones. */
  async function legacySweepAllOrgsInOneSession(repoForEverything: DespachosRepository): Promise<{ organizationId: string; ran: boolean; error?: string }[]> {
    const results: { organizationId: string; ran: boolean; error?: string }[] = [];
    for (const org of [{ id: organizationId }, { id: orgB }, { id: orgC }]) {
      try {
        const properties = await repoForEverything.listPropertiesForOrganization(org.id);
        for (const property of properties) {
          await sweepProperty(repoForEverything, property.propertyId, "2026-09-14");
        }
        results.push({ organizationId: org.id, ran: true });
      } catch (err) {
        results.push({ organizationId: org.id, ran: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  it("ANTES del fix (patrón reconstruido): un error SQL real en la organización B revierte en silencio TAMBIÉN el recordatorio YA COMMITEADO de A", async () => {
    const { proxy, isAborted } = makeAbortSimulatingRepo(repo, (method, args) => method === "systemListPendingReceivablesForReminders" && args[0] === propB, "57014: statement timeout (SQL real simulado)");

    const results = await simulateSingleSharedTransaction(repo, isAborted, () => legacySweepAllOrgsInOneSession(proxy));

    // El resultado MIENTE: reporta A como corrida exitosa.
    expect(results.find((r) => r.organizationId === organizationId)!.ran).toBe(true);
    // C falla en cascada -- ve el error de B, no el suyo.
    const resultC = results.find((r) => r.organizationId === orgC)!;
    expect(resultC.ran).toBe(false);
    expect(resultC.error).toMatch(/25P02|aborted/i);

    // Pero el correo real de A, que sí se había encolado, se perdió con el
    // COMMIT->ROLLBACK silencioso.
    expect(repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("DESPUÉS del fix (código real): el mismo error SQL en B se aísla -- A y C SÍ encolan su recordatorio real, solo B se reporta como fallo", async () => {
    const { proxy, reset } = makeAbortSimulatingRepo(repo, (method, args) => method === "systemListPendingReceivablesForReminders" && args[0] === propB, "57014: statement timeout (SQL real simulado)");
    const perCallTxn = makePerCallTransactionalWithRepo(repo);
    const withRepo = async <T>(fn: (r: DespachosRepository) => Promise<T>): Promise<T> => {
      try {
        return await perCallTxn(() => fn(proxy));
      } finally {
        reset();
      }
    };

    const sweep = await runCobranzaReminderSweep(withRepo, { todayIsoDate: "2026-09-14" });

    const resultA = sweep.find((r) => r.organizationId === organizationId)!;
    const resultB = sweep.find((r) => r.organizationId === orgB)!;
    const resultC = sweep.find((r) => r.organizationId === orgC)!;
    expect(resultA.error).toBeUndefined();
    expect(resultB.error).toContain("57014");
    expect(resultC.error).toBeUndefined();
    expect(resultC.properties).toEqual([{ propertyId: propC, receivablesScanned: 1, remindersDue: 1, emailsEnqueued: 1 }]);

    // Los correos de A y C SÍ persisten -- solo B se perdió (y se reporta).
    const outbox = repo.getMessagingOutbox();
    expect(outbox).toHaveLength(2);
    const recipients = outbox.map((j) => (j.payload as { to: string }).to).sort();
    expect(recipients).toEqual(["cliente-a@example.com", "cliente-c@example.com"]);
  });
});
