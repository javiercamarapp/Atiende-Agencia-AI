// C-04 -- el recordatorio y los avisos de confirmacion/cancelacion/reagendado usan la configuracion editable.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { runConfirmacionCitaCore } from "../src/reminders.ts";
import { MENSAJES_CONFIG_POR_OMISION } from "../src/whatsapp/message-config.ts";
import type { WhatsappMessageConfig } from "../src/whatsapp/message-config.ts";
import { enqueueAppointmentWhatsappCore, tryEnqueueAppointmentWhatsapp } from "../src/whatsapp/message-send.ts";
import { buildCitasFixture } from "./fixtures.ts";

// El guard "ese horario ya paso" usa el reloj real: las fechas fijas de este archivo (septiembre de 2026 / 2027) se evaluan con un reloj fijo anterior a ellas.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const NOW = new Date("2026-09-13T16:00:00.000Z"); // domingo 10:00 hora de Merida

async function conCita(startsAtIso: string, config?: Partial<WhatsappMessageConfig>) {
  const fixture = buildCitasFixture();
  if (config) await fixture.repo.saveWhatsappMessageConfig(fixture.organizationId, 0, "actualizado", { ...MENSAJES_CONFIG_POR_OMISION, ...config });
  const appointment = await createAppointment(fixture.repo, {
    organizationId: fixture.organizationId,
    providerId: fixture.providerId,
    serviceId: fixture.serviceId,
    customerName: "María López",
    customerPhone: "9998887766",
    startsAt: startsAtIso,
    source: "web",
  });
  return { ...fixture, appointment };
}

// El ICU de cada Node escribe "a. m." o "a.m.": se normaliza para que el test no dependa de la version de ICU.
const norm = (s: string) =>
  s
    .replace(/a\.\s?m\./g, "AM")
    .replace(/p\.\s?m\./g, "PM")
    .replace(/(lunes|martes|miércoles|jueves|viernes|sábado|domingo),/g, "$1");
const bodies = (repo: ReturnType<typeof buildCitasFixture>["repo"]) => repo.getOutbox().map((o) => norm((o.payload as { body: string }).body));

describe("runConfirmacionCitaCore con configuracion editable", () => {
  it("sin configuracion guardada el cuerpo es EXACTAMENTE el de antes de C-04", async () => {
    const f = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString());
    await runConfirmacionCitaCore(f.repo, f.organizationId, NOW);
    expect(bodies(f.repo)).toEqual(["Hola María López, le recordamos su cita mañana a las 10:00 AM. ¿Puede confirmar?"]);
  });

  it("usa el texto propio con las variables, en la zona horaria del negocio", async () => {
    const f = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), {
      reminderText: "{{nombre}}: {{servicio}} con {{profesional}} en {{negocio}}, {{fecha_hora}}",
    });
    const summary = await runConfirmacionCitaCore(f.repo, f.organizationId, NOW);
    expect(summary.sent).toBe(1);
    expect(bodies(f.repo)).toEqual(["María López: Consulta general con Dra. Fernanda López en Clínica Dental Sonrisas, lunes 14 de septiembre, 10:00 AM"]);
  });

  it("anticipacion de 12 h: la cita de 24 h ya no entra y la de 12 h si", async () => {
    const lejos = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), { reminderLeadHours: 12 });
    expect((await runConfirmacionCitaCore(lejos.repo, lejos.organizationId, NOW)).processed).toBe(0);

    const cerca = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), { reminderLeadHours: 12 });
    const domingo22 = new Date("2026-09-14T04:00:00.000Z"); // domingo 22:00 hora de Merida: faltan 12 h
    const s = await runConfirmacionCitaCore(cerca.repo, cerca.organizationId, domingo22);
    expect(s.sent).toBe(1);
    expect(bodies(cerca.repo)[0]).not.toContain("{{");
    expect(bodies(cerca.repo)[0]).not.toContain("mañana"); // con 12 h ya no se dice "manana"
    expect(bodies(cerca.repo)[0]).toContain("lunes 14 de septiembre");
  });

  it("fuera del horario de envio la cita se deja pendiente (sin marcar) y la siguiente corrida dentro del horario la envia", async () => {
    const f = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), { reminderLeadHours: 12, sendWindowStart: 9, sendWindowEnd: 20 });
    const cerrado = new Date("2026-09-14T04:00:00.000Z"); // domingo 22:00 locales: fuera de 9-20
    const s1 = await runConfirmacionCitaCore(f.repo, f.organizationId, cerrado);
    expect(s1.skippedOutsideSendWindow).toBe(1);
    expect(s1.sent).toBe(0);
    expect(f.repo.getOutbox()).toHaveLength(0);

    const abierto = new Date("2026-09-14T15:00:00.000Z"); // lunes 09:00 locales: abierto, la cita es a las 10:00
    const s2 = await runConfirmacionCitaCore(f.repo, f.organizationId, abierto);
    expect(s2.sent).toBe(1);
    expect(s2.skippedOutsideSendWindow).toBe(0);
    expect(f.repo.getOutbox()).toHaveLength(1);
  });

  it("recordatorio apagado: no sale WhatsApp y no se marca como enviado por ese canal", async () => {
    const f = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), { reminderEnabled: false });
    const s = await runConfirmacionCitaCore(f.repo, f.organizationId, NOW);
    expect(s.processed).toBe(1);
    expect(s.sent).toBe(0);
    expect(f.repo.getOutbox().filter((o) => o.channel === "whatsapp")).toHaveLength(0);
  });

  it("un nombre de cliente hostil con llaves no inyecta variables en el mensaje", async () => {
    const fixture = buildCitasFixture();
    await fixture.repo.saveWhatsappMessageConfig(fixture.organizationId, 0, "actualizado", { ...MENSAJES_CONFIG_POR_OMISION, reminderText: "Hola {{nombre}}, {{hora}}" });
    await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "{{negocio}}\u0007X", customerPhone: "9990001111", startsAt: zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), source: "web" });
    await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, NOW);
    expect(bodies(fixture.repo)).toEqual(["Hola negocio X, 10:00 AM"]);
  });
});

describe("avisos de confirmacion / cancelacion / reagendado", () => {
  it("nacen apagados: sin configuracion no se encola nada", async () => {
    const f = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString());
    expect(await enqueueAppointmentWhatsappCore(f.repo, f.organizationId, "appointment.confirmed", f.appointment.id)).toEqual({ enqueued: false, reason: "disabled" });
    expect(f.repo.getOutbox()).toHaveLength(0);
  });

  it("encendido encola el texto de fabrica con los datos de la cita, y no duplica por el mismo evento", async () => {
    const f = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), { confirmationEnabled: true });
    const r1 = await enqueueAppointmentWhatsappCore(f.repo, f.organizationId, "appointment.confirmed", f.appointment.id);
    const r2 = await enqueueAppointmentWhatsappCore(f.repo, f.organizationId, "appointment.confirmed", f.appointment.id);
    expect(r1.enqueued).toBe(true);
    expect(r2.enqueued).toBe(true);
    const wa = f.repo.getOutbox().filter((o) => o.eventType === "appointment.confirmed");
    expect(wa).toHaveLength(1); // mismo dedupe_key
    expect(bodies(f.repo).some((b) => b.includes("Consulta general") && b.includes("Dra. Fernanda López") && b.includes("lunes 14 de septiembre, 10:00 AM"))).toBe(true);
    expect((wa[0]!.payload as { to: string; phone_number_id: string }).to).toBe("9998887766");
    expect((wa[0]!.payload as { phone_number_id: string }).phone_number_id).toBe("1234567890");
  });

  it("cancelacion y reagendado: cada uno con su texto; reagendado incluye la fecha anterior y avisa de nuevo si el horario cambia otra vez", async () => {
    const f = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), {
      cancellationEnabled: true,
      cancellationText: "Cita cancelada: {{fecha_hora}}",
      rescheduleEnabled: true,
      rescheduleText: "Antes {{fecha_anterior}}, ahora {{fecha_hora}}",
    });
    const previous = zonedTimeToUtc("2026-09-14", "09:00", "America/Merida").toISOString();
    await enqueueAppointmentWhatsappCore(f.repo, f.organizationId, "appointment.cancelled", f.appointment.id);
    await enqueueAppointmentWhatsappCore(f.repo, f.organizationId, "appointment.rescheduled", f.appointment.id, { previousStartsAt: previous });
    expect(bodies(f.repo)).toContain("Cita cancelada: lunes 14 de septiembre, 10:00 AM");
    expect(bodies(f.repo)).toContain("Antes lunes 14 de septiembre, 9:00 AM, ahora lunes 14 de septiembre, 10:00 AM");
  });

  it("sin telefono o sin WhatsApp configurado no encola y no lanza", async () => {
    const f = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), { cancellationEnabled: true });
    f.repo.seedWhatsAppConfig(f.organizationId, "");
    // sin phone_number_id valido (cadena vacia) el doble en memoria devuelve "" -> falsy
    const r = await tryEnqueueAppointmentWhatsapp(f.repo, f.organizationId, "appointment.cancelled", f.appointment.id);
    expect(r?.enqueued).toBe(false);
    expect(await tryEnqueueAppointmentWhatsapp(f.repo, f.organizationId, "appointment.cancelled", "00000000-0000-0000-0000-00000000dead")).toEqual({ enqueued: false, reason: "appointment_not_found" });
  });

  it("un error del repositorio nunca se propaga: devuelve null", async () => {
    const f = await conCita(zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(), { cancellationEnabled: true });
    f.repo.enqueueMessagingOutbox = async () => {
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    };
    const spy = console.error;
    console.error = () => undefined;
    try {
      expect(await tryEnqueueAppointmentWhatsapp(f.repo, f.organizationId, "appointment.cancelled", f.appointment.id)).toBeNull();
    } finally {
      console.error = spy;
    }
  });
});
