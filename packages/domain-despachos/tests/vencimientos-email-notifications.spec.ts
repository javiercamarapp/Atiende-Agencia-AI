// Pruebas del correo real de escalamiento de vencimientos fiscales — cierra
// el gap de auditoría (severidad ALTA): "escalar un vencimiento solo insertaba
// el escalamiento en BD, nunca notificaba a nadie".
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { decidirEscalamiento } from "../src/vencimientos/engine.ts";
import { enqueueEscalationEmailCore, tryEnqueueEscalationEmail } from "../src/vencimientos/email-notifications.ts";
import type { FiscalDeadlineRecord } from "../src/types.ts";

function buildDeadline(overrides: Partial<FiscalDeadlineRecord> = {}): FiscalDeadlineRecord {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    propertyId: randomUUID(),
    tipo: "ISR",
    periodo: "2026-06",
    fechaLimite: "2026-07-17",
    prioridad: "critica",
    estado: "pendiente",
    fechaPresentacion: null,
    comprobanteUrl: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("enqueueEscalationEmailCore", () => {
  it("sin ningún staff owner/admin en la organización, no encola nada (nunca un error)", async () => {
    const repo = new InMemoryDespachosRepository();
    const deadline = buildDeadline();
    const decision = decidirEscalamiento(deadline.tipo, deadline.fechaLimite, -5);

    const result = await enqueueEscalationEmailCore(repo, deadline, decision, "Despacho de Prueba SC", -5);

    expect(result).toEqual({ recipients: 0, enqueued: 0 });
    expect(repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("encola un correo real por cada destinatario owner/admin de la organización", async () => {
    const repo = new InMemoryDespachosRepository();
    const deadline = buildDeadline();
    repo.seedNotificationRecipient(deadline.organizationId, { email: "owner@despacho.mx", fullName: "Owner" });
    repo.seedNotificationRecipient(deadline.organizationId, { email: "admin@despacho.mx", fullName: "Admin" });
    const decision = decidirEscalamiento(deadline.tipo, deadline.fechaLimite, -5);

    const result = await enqueueEscalationEmailCore(repo, deadline, decision, "Despacho de Prueba SC", -5);

    expect(result).toEqual({ recipients: 2, enqueued: 2 });
    const outbox = repo.getMessagingOutbox();
    expect(outbox).toHaveLength(2);
    expect(outbox.every((o) => o.organizationId === deadline.organizationId && o.channel === "email")).toBe(true);
    const payload = outbox[0]!.payload as { to: string; subject: string; html: string; text: string };
    expect(payload.to).toBe("owner@despacho.mx");
    expect(payload.subject).toContain("ISR");
    expect(payload.html).toContain("Despacho de Prueba SC");
    expect(payload.html).toContain("atiende"); // wordmark de marca, ver emails/layout.ts
  });

  it("dedupe_key incluye el nivel de escalamiento -- reencolar el MISMO nivel nunca duplica, un nivel NUEVO sí manda su propio correo", async () => {
    const repo = new InMemoryDespachosRepository();
    const deadline = buildDeadline();
    repo.seedNotificationRecipient(deadline.organizationId, { email: "owner@despacho.mx", fullName: "Owner" });

    const decisionNivel2 = decidirEscalamiento(deadline.tipo, deadline.fechaLimite, 1);
    await enqueueEscalationEmailCore(repo, deadline, decisionNivel2, "Despacho de Prueba SC", 1);
    expect(repo.getMessagingOutbox()).toHaveLength(1);

    // Reintento del MISMO nivel -- no duplica.
    await enqueueEscalationEmailCore(repo, deadline, decisionNivel2, "Despacho de Prueba SC", 1);
    expect(repo.getMessagingOutbox()).toHaveLength(1);

    // Escalamiento real a un nivel NUEVO (nivel_4, ya vencido) -- manda su propio correo.
    const decisionNivel4 = decidirEscalamiento(deadline.tipo, deadline.fechaLimite, -3);
    await enqueueEscalationEmailCore(repo, deadline, decisionNivel4, "Despacho de Prueba SC", -3);
    expect(repo.getMessagingOutbox()).toHaveLength(2);
  });
});

describe("tryEnqueueEscalationEmail", () => {
  it("best-effort: un repo que lanza nunca se propaga (el escalamiento ya se registró con éxito)", async () => {
    const repo = new InMemoryDespachosRepository();
    const deadline = buildDeadline();
    repo.seedNotificationRecipient(deadline.organizationId, { email: "owner@despacho.mx", fullName: "Owner" });
    const original = repo.enqueueMessagingOutbox;
    repo.enqueueMessagingOutbox = async () => {
      throw new Error("Resend caído");
    };
    const decision = decidirEscalamiento(deadline.tipo, deadline.fechaLimite, -5);

    const result = await tryEnqueueEscalationEmail(repo, deadline, decision, "Despacho de Prueba SC", -5);

    // A diferencia de `tryEnqueueCollectionReminderEmail` (que devuelve `null` en el
    // catch), esta envoltura devuelve el mismo shape "sin destinatarios" que el caso
    // honesto de organización sin staff -- nunca lanza, que es lo que de verdad
    // importa aquí (el escalamiento en BD ya quedó registrado con éxito).
    expect(result).toEqual({ recipients: 0, enqueued: 0 });
    repo.enqueueMessagingOutbox = original;
  });
});
