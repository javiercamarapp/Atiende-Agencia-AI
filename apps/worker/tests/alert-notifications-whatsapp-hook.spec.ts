// L-05 -- el barrido de alertas pasa los recordatorios de plazo recien creados a un gancho opcional
// (avisos de WhatsApp) DENTRO de la transaccion de la organizacion, sin cambiar el resultado de los
// ambientes que no lo cablean.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository, InMemoryWhatsAppRepository, enqueueDeadlineReminderWhatsApp } from "@atiende/domain-licitaciones";
import { runAlertNotificationSweep } from "../src/jobs/licitaciones/alert-notifications.ts";

async function seed() {
  const repo = new InMemoryLicitacionesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "org-wa", name: "Org WhatsApp" });
  await repo.upsertTenderManual(organizationId, {
    title: "Convocatoria con plazo cercano",
    submissionDeadline: "2026-09-16T18:00:00-06:00",
    externalId: "EXP-wa",
    contractingBody: null,
    cpvCodes: [],
    budgetAmount: null,
    currency: "MXN",
    state: null,
    procedureTypeRaw: null,
    actorId: randomUUID(),
  });
  const wa = new InMemoryWhatsAppRepository();
  await wa.upsertContact(organizationId, "u1", { phoneE164: "+525500000001", notifyPlazos: true, notifyConvocatorias: true, notifyFallos: true, notifyDecisiones: true });
  wa.actorUserId = "u1";
  await wa.requestConsent(organizationId);
  await wa.confirmOptIn("+525500000001");
  wa.actorUserId = null;
  return { repo, organizationId, wa };
}

const NOW = new Date("2026-09-14T12:00:00-06:00");

describe("runAlertNotificationSweep + gancho de WhatsApp", () => {
  it("encola un aviso por recordatorio nuevo y lo reporta; una segunda corrida no duplica", async () => {
    const { repo, organizationId, wa } = await seed();
    const hook = async ({ organizationId: org, reminders }: { organizationId: string; reminders: Parameters<typeof enqueueDeadlineReminderWhatsApp>[2] }) => enqueueDeadlineReminderWhatsApp(wa, org, reminders);
    const first = await runAlertNotificationSweep((fn) => fn(repo), { now: () => NOW, todayIsoDate: "2026-09-14", onDeadlineReminders: hook });
    expect(first[0]!.deadlineReminders).toMatchObject({ created: 1, whatsappEnqueued: 1 });
    const notices = wa.outbox.filter((r) => r.eventType === "notice_plazo");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({ to: "+525500000001" });
    expect(organizationId).toBeTruthy();

    const second = await runAlertNotificationSweep((fn) => fn(repo), { now: () => NOW, todayIsoDate: "2026-09-14", onDeadlineReminders: hook });
    expect(second[0]!.deadlineReminders.whatsappEnqueued).toBe(0);
    expect(wa.outbox.filter((r) => r.eventType === "notice_plazo")).toHaveLength(1);
  });

  it("sin gancho el resultado no cambia (no aparece whatsappEnqueued)", async () => {
    const { repo } = await seed();
    const sweep = await runAlertNotificationSweep((fn) => fn(repo), { now: () => NOW, todayIsoDate: "2026-09-14" });
    expect(sweep[0]!.deadlineReminders).not.toHaveProperty("whatsappEnqueued");
  });
});
