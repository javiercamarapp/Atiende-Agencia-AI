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
import { runCobranzaReminderSweep } from "../src/jobs/despachos/cobranza-reminders.ts";

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

    const sweep = await runCobranzaReminderSweep(repo, { todayIsoDate: "2026-09-14" });

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

    const sweep = await runCobranzaReminderSweep(repo, { todayIsoDate: "2026-09-14" });

    expect(sweep[0]!.properties).toEqual([{ propertyId, receivablesScanned: 1, remindersDue: 0, emailsEnqueued: 0 }]);
    expect(repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("una cuenta sin clienteEmail capturado: la etapa cuenta como 'due' pero no encola ningún correo", async () => {
    const invoice = await repo.insertInvoice(invoiceInput());
    await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-09-14" });

    const sweep = await runCobranzaReminderSweep(repo, { todayIsoDate: "2026-09-14" });

    expect(sweep[0]!.properties).toEqual([{ propertyId, receivablesScanned: 1, remindersDue: 1, emailsEnqueued: 0 }]);
    expect(repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("una cuenta ya pagada nunca cuenta como pendiente (queda fuera del barrido)", async () => {
    const invoice = await repo.insertInvoice(invoiceInput());
    const receivable = await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-09-14", clienteEmail: "cliente@example.com" });
    await repo.markReceivablePaid(propertyId, receivable.id, "2026-09-01T00:00:00.000Z", 1160);

    const sweep = await runCobranzaReminderSweep(repo, { todayIsoDate: "2026-09-14" });
    expect(sweep[0]!.properties).toEqual([{ propertyId, receivablesScanned: 0, remindersDue: 0, emailsEnqueued: 0 }]);
  });

  it("reescanear el mismo día no duplica el correo ya encolado para la MISMA etapa (dedupe real del outbox)", async () => {
    const invoice = await repo.insertInvoice(invoiceInput());
    await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-09-14", clienteEmail: "cliente@example.com" });

    await runCobranzaReminderSweep(repo, { todayIsoDate: "2026-09-14" });
    await runCobranzaReminderSweep(repo, { todayIsoDate: "2026-09-14" });

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
      listReceivables: repo.listReceivables.bind(repo),
      findInvoice: repo.findInvoice.bind(repo),
      insertCollectionEvent: repo.insertCollectionEvent.bind(repo),
      enqueueMessagingOutbox: repo.enqueueMessagingOutbox.bind(repo),
    } as unknown as DespachosRepository;

    const sweep = await runCobranzaReminderSweep(brokenRepo, { todayIsoDate: "2026-09-14" });
    const failed = sweep.find((r) => r.organizationId === organizationId)!;
    const ok = sweep.find((r) => r.organizationId === org2)!;
    expect(failed.error).toBe("fallo simulado");
    expect(ok.error).toBeUndefined();
  });
});
