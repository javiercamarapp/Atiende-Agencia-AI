// QA ronda 1 (citas, lente AUTOMATIZACION) -- reagendar despues de que salio el recordatorio (01). Reloj simulado (`now` explicito) sobre InMemoryCitasRepository
// (replica `citas.enqueue_messaging_outbox`: on conflict solo actualiza filas pending/failed).
import { describe, expect, it } from "vitest";
import { createAppointment, rescheduleAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { runConfirmacionCitaCore } from "../src/reminders.ts";
import { buildCitasFixture } from "./fixtures.ts";

const MERIDA = "America/Merida";

/** Drena el canal de WhatsApp como lo haria el dispatcher con Meta respondiendo 200. */
async function despacharWhatsApp(repo: InMemoryCitasRepository): Promise<{ id: string; payload: unknown }[]> {
  const items = await repo.claimMessagingOutboxBatch(100, 120);
  for (const it of items) await repo.markMessagingOutboxSent(it.id);
  return items.map((i) => ({ id: i.id, payload: i.payload }));
}


describe("QA-citas-R1-automatizacion-01: reagendar DESPUES de que salio el recordatorio", () => {
  it("la cita reagendada recibe un recordatorio nuevo con el horario NUEVO (WhatsApp)", async () => {
    const { repo, organizationId, providerId, serviceId } = buildCitasFixture();
    const cita = await createAppointment(repo, {
      organizationId, providerId, serviceId, customerName: "Ana", customerPhone: "9991230001",
      startsAt: zonedTimeToUtc("2026-10-21", "10:00", MERIDA).toISOString(), source: "web",
    });

    // Martes 11:00 Merida: la cita del miercoles 10:00 entra a la ventana y el recordatorio sale y se entrega.
    await runConfirmacionCitaCore(repo, organizationId, zonedTimeToUtc("2026-10-20", "11:00", MERIDA));
    const primero = await despacharWhatsApp(repo);
    expect(primero).toHaveLength(1);

    // El cliente reagenda al jueves 11:00 (el RPC real pone reminder_24h_sent_at = null).
    await rescheduleAppointment(repo, { organizationId, appointmentId: cita.id, newStartsAt: zonedTimeToUtc("2026-10-22", "11:00", MERIDA).toISOString(), actorChannel: "whatsapp" });

    // Miercoles 12:00 Merida: la cita del jueves 11:00 vuelve a estar en la ventana.
    const resumen = await runConfirmacionCitaCore(repo, organizationId, zonedTimeToUtc("2026-10-21", "12:00", MERIDA));
    const segundo = await despacharWhatsApp(repo);

    // El resumen dice que se "envio" uno...
    expect(resumen.sent).toBe(1);
    // ...asi que el dispatcher debe tener algo que entregar con la hora NUEVA.
    expect(segundo).toHaveLength(1);
    expect(JSON.stringify(segundo[0]?.payload)).toContain("11:00");
  });

  it("la cita reagendada recibe un recordatorio nuevo por CORREO", async () => {
    const { repo, organizationId, providerId, serviceId } = buildCitasFixture();
    const cita = await createAppointment(repo, {
      organizationId, providerId, serviceId, customerName: "Beto", customerPhone: "9991230002", customerEmail: "beto@example.com",
      startsAt: zonedTimeToUtc("2026-10-21", "10:00", MERIDA).toISOString(), source: "web",
    });
    await runConfirmacionCitaCore(repo, organizationId, zonedTimeToUtc("2026-10-20", "11:00", MERIDA));
    const correos1 = await repo.claimEmailOutboxBatch(50);
    const esRecordatorio = (id: string) => repo.getOutbox().find((o) => o.id === id)?.eventType === "appointment.reminder_24h";
    const recordatorio1 = correos1.filter((j) => esRecordatorio(j.id));
    expect(recordatorio1).toHaveLength(1);
    for (const j of correos1) await repo.completeEmailOutboxJob(j.id, "sent", null);

    await rescheduleAppointment(repo, { organizationId, appointmentId: cita.id, newStartsAt: zonedTimeToUtc("2026-10-22", "11:00", MERIDA).toISOString(), actorChannel: "web" });
    const resumen = await runConfirmacionCitaCore(repo, organizationId, zonedTimeToUtc("2026-10-21", "12:00", MERIDA));
    expect(resumen.sentEmail).toBe(1);
    const correos2 = await repo.claimEmailOutboxBatch(50);
    expect(correos2.filter((j) => esRecordatorio(j.id))).toHaveLength(1);
  });
});
