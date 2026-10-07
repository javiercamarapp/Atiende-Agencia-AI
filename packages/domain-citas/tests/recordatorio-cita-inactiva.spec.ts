// QA-citas-R1-automatizacion-02: un recordatorio que se quedo en el outbox NO se entrega si su cita ya se cancelo o cerro.
// Reloj simulado (`now` explicito) sobre el repositorio en memoria; el dispatcher real es el de WhatsApp (puerto del outbox) y el de correo.
import { describe, expect, it } from "vitest";
import { cancelAppointment, createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { dispatchPendingEmailJobs, EMAIL_CITA_INACTIVA_ERROR } from "../src/email-dispatch.ts";
import { runConfirmacionCitaCore } from "../src/reminders.ts";
import { createCitasMessagingOutboxPort, RECORDATORIO_CITA_INACTIVA } from "../src/whatsapp/outbox-adapter.ts";
import { buildCitasFixture, nextWeekdayDateStr } from "./fixtures.ts";

const MERIDA = "America/Merida";

async function conRecordatorioEncolado(extra: { customerEmail?: string } = {}) {
  const f = buildCitasFixture();
  const dia = nextWeekdayDateStr(new Date(), 3); // un miercoles futuro
  const antes = new Date(Date.parse(`${dia}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const cita = await createAppointment(f.repo, {
    organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Carla", customerPhone: "9991230003",
    ...(extra.customerEmail ? { customerEmail: extra.customerEmail } : {}), startsAt: zonedTimeToUtc(dia, "10:00", MERIDA).toISOString(), source: "web",
  });
  await runConfirmacionCitaCore(f.repo, f.organizationId, zonedTimeToUtc(antes, "11:00", MERIDA));
  return { ...f, cita };
}

describe("recordatorio de WhatsApp pendiente y cita cancelada", () => {
  it("el recordatorio se entrega mientras la cita sigue activa (control)", async () => {
    const t = await conRecordatorioEncolado();
    const port = createCitasMessagingOutboxPort(t.repo);
    const items = await port.claimBatch(50, 120);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0]!.payload)).toContain("cita:confirmar:");
  });

  it("tras cancelar, el puerto del dispatcher NO lo devuelve y la fila queda dead con motivo cita_inactiva", async () => {
    const t = await conRecordatorioEncolado();
    await cancelAppointment(t.repo, { organizationId: t.organizationId, appointmentId: t.cita.id });
    const port = createCitasMessagingOutboxPort(t.repo);
    expect(await port.claimBatch(50, 120)).toEqual([]);
    const fila = t.repo.getOutbox().find((o) => o.eventType === "appointment.reminder_24h" && o.channel === "whatsapp")!;
    expect(fila.status).toBe("dead");
    expect(fila.lastErrorClass).toBe(RECORDATORIO_CITA_INACTIVA);
  });

  it("un mensaje que no es recordatorio (sin botones de cita) se sigue entregando aunque haya citas canceladas", async () => {
    const t = await conRecordatorioEncolado();
    await cancelAppointment(t.repo, { organizationId: t.organizationId, appointmentId: t.cita.id });
    await t.repo.enqueueMessagingOutbox(t.organizationId, "whatsapp", "whatsapp.inbound_reply", "inbound-reply:x", { to: "+5219991230003", phone_number_id: "1", body: "Tu cita quedó cancelada." });
    const items = await createCitasMessagingOutboxPort(t.repo).claimBatch(50, 120);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0]!.payload)).toContain("quedó cancelada");
  });

  it("si la lectura de la cita falla, el recordatorio se entrega como siempre (fail-open)", async () => {
    const t = await conRecordatorioEncolado();
    t.repo.findAppointmentForOrganization = async () => {
      throw new Error("lectura caida");
    };
    expect(await createCitasMessagingOutboxPort(t.repo).claimBatch(50, 120)).toHaveLength(1);
  });
});

describe("recordatorio por correo pendiente y cita cancelada", () => {
  const config = { apiKey: "re_test", from: "Citas <citas@example.com>" };
  const fetchOk = (envios: string[]) => (async (_url: unknown, init?: { body?: string }) => {
    envios.push(String(init?.body ?? ""));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  it("tras cancelar, el recordatorio por correo no se envia pero el correo de cancelacion SI", async () => {
    const t = await conRecordatorioEncolado({ customerEmail: "carla@example.com" });
    await cancelAppointment(t.repo, { organizationId: t.organizationId, appointmentId: t.cita.id });
    const { tryEnqueueAppointmentEmail } = await import("../src/appointment-email-notifications.ts");
    await tryEnqueueAppointmentEmail(t.repo, t.organizationId, "appointment.cancelled", t.cita.id);
    const envios: string[] = [];
    const resumen = await dispatchPendingEmailJobs(t.repo, config, { fetchImpl: fetchOk(envios) });
    expect(resumen.omitidosCitaInactiva).toBe(1);
    expect(resumen.sent).toBe(1);
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatch(/cancel/i);
    const recordatorio = t.repo.getOutbox().find((o) => o.eventType === "appointment.reminder_24h" && o.channel === "email")!;
    expect(recordatorio.status).toBe("dead");
    expect(recordatorio.lastError).toBe(EMAIL_CITA_INACTIVA_ERROR);
  });

  it("con la cita activa el recordatorio por correo si sale", async () => {
    const t = await conRecordatorioEncolado({ customerEmail: "carla@example.com" });
    const envios: string[] = [];
    const resumen = await dispatchPendingEmailJobs(t.repo, config, { fetchImpl: fetchOk(envios) });
    expect(resumen.sent).toBe(1);
    expect(resumen.omitidosCitaInactiva).toBeUndefined();
  });
});
