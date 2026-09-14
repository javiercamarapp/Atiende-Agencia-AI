// Pruebas del correo real de recordatorio de cobranza — cierra el gap de
// auditoría (severidad ALTA): "construirRecordatorioCobranza genera el
// contenido... pero no hay integración con un canal de envío real".
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { enqueueCollectionReminderEmailCore, tryEnqueueCollectionReminderEmail } from "../src/cobranza/email-notifications.ts";
import type { ReceivableRecord } from "../src/types.ts";

function buildReceivable(overrides: Partial<ReceivableRecord> = {}): ReceivableRecord {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    propertyId: randomUUID(),
    invoiceId: randomUUID(),
    fechaVencimiento: "2026-06-01",
    montoPagado: null,
    pagadoEn: null,
    clienteNombre: "Cliente de Prueba SA de CV",
    clienteEmail: "cliente@example.com",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("enqueueCollectionReminderEmailCore", () => {
  it("con clienteEmail capturado: encola el correo real Y deja el evento de auditoría", async () => {
    const repo = new InMemoryDespachosRepository();
    const receivable = buildReceivable();

    const result = await enqueueCollectionReminderEmailCore(repo, receivable, { facturaId: "11111111-2222-3333-4444-555555555555", monto: 1160 }, "vencimiento", 0);

    expect(result).toEqual({ enqueued: true });
    const outbox = repo.getMessagingOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.organizationId).toBe(receivable.organizationId);
    const payload = outbox[0]!.payload as { to: string; subject: string; html: string };
    expect(payload.to).toBe("cliente@example.com");
    expect(payload.subject).toContain("11111111-2222-3333-4444-555555555555");
    expect(payload.html).toContain("Cliente de Prueba SA de CV");

    const eventos = await repo.listCollectionEvents(receivable.propertyId, receivable.id);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.etapa).toBe("vencimiento");
    expect(eventos[0]!.canal).toBe("email");
  });

  it("sin clienteEmail (cuenta sin contacto capturado): NO encola correo, pero SIGUE dejando el evento de auditoría", async () => {
    const repo = new InMemoryDespachosRepository();
    const receivable = buildReceivable({ clienteEmail: null });

    const result = await enqueueCollectionReminderEmailCore(repo, receivable, { facturaId: "F-1", monto: 500 }, "pre_vencimiento", -7);

    expect(result).toEqual({ enqueued: false, reason: "no_email" });
    expect(repo.getMessagingOutbox()).toHaveLength(0);
    const eventos = await repo.listCollectionEvents(receivable.propertyId, receivable.id);
    expect(eventos).toHaveLength(1); // auditoría real, aunque no haya canal de envío.
  });

  it("dedupe_key incluye la etapa -- las 5 etapas de una misma cuenta mandan cada una su propio correo", async () => {
    const repo = new InMemoryDespachosRepository();
    const receivable = buildReceivable();

    await enqueueCollectionReminderEmailCore(repo, receivable, { facturaId: "F-2", monto: 2000 }, "pre_vencimiento", -7);
    await enqueueCollectionReminderEmailCore(repo, receivable, { facturaId: "F-2", monto: 2000 }, "vencimiento", 0);
    await enqueueCollectionReminderEmailCore(repo, receivable, { facturaId: "F-2", monto: 2000 }, "recordatorio_formal", 7);

    expect(repo.getMessagingOutbox()).toHaveLength(3);

    // Reintento de la MISMA etapa no duplica.
    await enqueueCollectionReminderEmailCore(repo, receivable, { facturaId: "F-2", monto: 2000 }, "vencimiento", 0);
    expect(repo.getMessagingOutbox()).toHaveLength(3);
  });
});

describe("tryEnqueueCollectionReminderEmail", () => {
  it("best-effort: un repo que lanza nunca se propaga", async () => {
    const repo = new InMemoryDespachosRepository();
    const receivable = buildReceivable();
    repo.insertCollectionEvent = async () => {
      throw new Error("DB caída");
    };

    const result = await tryEnqueueCollectionReminderEmail(repo, receivable, { facturaId: "F-3", monto: 100 }, "escalamiento", 60);

    expect(result).toBeNull();
  });
});
