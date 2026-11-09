// QA ronda 1 (citas, lente AUTOMATIZACION) -- texto del recordatorio de siempre (03, 12). Reloj simulado (`now` explicito) sobre InMemoryCitasRepository
// (replica `citas.enqueue_messaging_outbox`: on conflict solo actualiza filas pending/failed).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { runConfirmacionCitaCore } from "../src/reminders.ts";
import { buildCitasFixture } from "./fixtures.ts";

const MERIDA = "America/Merida";

function payloadDe(repo: InMemoryCitasRepository, dedupeKey: string, channel = "whatsapp") {
  return repo.getOutbox().find((o) => (o.dedupeKey === dedupeKey || o.dedupeKey.startsWith(`${dedupeKey}:`)) && o.channel === channel);
}

describe("QA-citas-R1-automatizacion-03: texto del recordatorio cuando la cita es HOY", () => {
  it("una cita de hoy a las 15:00 no se anuncia como 'manana'", async () => {
    const { repo, organizationId, providerId, serviceId } = buildCitasFixture();
    const cita = await createAppointment(repo, {
      organizationId, providerId, serviceId, customerName: "Dani", customerPhone: "9991230004",
      startsAt: zonedTimeToUtc("2026-10-21", "15:00", MERIDA).toISOString(), source: "whatsapp",
    });
    // Reservada a las 06:00 del mismo dia (hace mas de 1 h al correr el cron de las 08:00).
    repo.seedAppointment({ ...cita, createdAt: zonedTimeToUtc("2026-10-21", "06:00", MERIDA).toISOString() });
    await runConfirmacionCitaCore(repo, organizationId, zonedTimeToUtc("2026-10-21", "08:00", MERIDA));
    const body = (payloadDe(repo, `reminder-24h:${cita.id}`)?.payload as { body: string }).body;
    expect(body).toContain("3:00");
    expect(body).not.toMatch(/mañana/u);
  });

  it("QA-citas-R1-automatizacion-12: el texto de siempre no deja doble punto tras 'p.m.'", async () => {
    const { repo, organizationId, providerId, serviceId } = buildCitasFixture();
    const cita = await createAppointment(repo, {
      organizationId, providerId, serviceId, customerName: "Lalo", customerPhone: "9991230012",
      startsAt: zonedTimeToUtc("2026-10-21", "15:00", MERIDA).toISOString(), source: "web",
    });
    await runConfirmacionCitaCore(repo, organizationId, zonedTimeToUtc("2026-10-20", "16:00", MERIDA));
    const body = (payloadDe(repo, `reminder-24h:${cita.id}`)?.payload as { body: string }).body;
    expect(body).not.toMatch(/\.\./u);
  });

  it("cobertura: cita de manana (cruce de anio, Cancun) dice 'manana' con la hora local correcta", async () => {
    const repo = new InMemoryCitasRepository();
    const { organizationId, serviceId } = buildCitasFixture(repo);
    const propertyId = randomUUID();
    const providerId = randomUUID();
    repo.seedPropertyTimezone(propertyId, "America/Cancun");
    repo.seedProvider({ id: providerId, organizationId, propertyId, displayName: "Dr. Caribe", roleLabel: "Dentista", isActive: true });
    repo.seedProviderService(providerId, serviceId);
    for (const d of [1, 2, 3, 4, 5]) repo.seedAvailabilityRule({ id: randomUUID(), providerId, dayOfWeek: d, startTime: "08:00", endTime: "18:00", isActive: true });
    const cita = await createAppointment(repo, {
      organizationId, providerId, serviceId, customerName: "Eva", customerPhone: "9981230005",
      startsAt: zonedTimeToUtc("2027-01-01", "10:00", "America/Cancun").toISOString(), source: "web",
    });
    await runConfirmacionCitaCore(repo, organizationId, zonedTimeToUtc("2026-12-31", "11:00", "America/Cancun"));
    const body = (payloadDe(repo, `reminder-24h:${cita.id}`)?.payload as { body: string }).body;
    expect(body).toMatch(/mañana a las 10:00/u);
  });

  it("cobertura: horario de verano de Tijuana (fin de DST 2026-11-01) -- la hora del recordatorio es la local", async () => {
    const repo = new InMemoryCitasRepository();
    const { organizationId, serviceId } = buildCitasFixture(repo);
    const propertyId = randomUUID();
    const providerId = randomUUID();
    repo.seedPropertyTimezone(propertyId, "America/Tijuana");
    repo.seedProvider({ id: providerId, organizationId, propertyId, displayName: "Dra. Frontera", roleLabel: "Dentista", isActive: true });
    repo.seedProviderService(providerId, serviceId);
    for (const d of [0, 1, 2, 3, 4, 5, 6]) repo.seedAvailabilityRule({ id: randomUUID(), providerId, dayOfWeek: d, startTime: "08:00", endTime: "18:00", isActive: true });
    // Lunes 2 de noviembre 09:00 PST (UTC-8) => 17:00Z; el domingo 1 a las 01:59 PDT termina el horario de verano.
    expect(zonedTimeToUtc("2026-11-02", "09:00", "America/Tijuana").toISOString()).toBe("2026-11-02T17:00:00.000Z");
    expect(zonedTimeToUtc("2026-10-31", "09:00", "America/Tijuana").toISOString()).toBe("2026-10-31T16:00:00.000Z");
    const cita = await createAppointment(repo, {
      organizationId, providerId, serviceId, customerName: "Gil", customerPhone: "6641230006",
      startsAt: zonedTimeToUtc("2026-11-02", "09:00", "America/Tijuana").toISOString(), source: "web",
    });
    await runConfirmacionCitaCore(repo, organizationId, zonedTimeToUtc("2026-11-01", "10:00", "America/Tijuana"));
    const body = (payloadDe(repo, `reminder-24h:${cita.id}`)?.payload as { body: string }).body;
    expect(body).toMatch(/mañana a las 9:00/u);
  });

  it("cobertura: dos corridas solapadas del cron en el mismo instante no duplican el recordatorio", async () => {
    const { repo, organizationId, providerId, serviceId } = buildCitasFixture();
    const cita = await createAppointment(repo, {
      organizationId, providerId, serviceId, customerName: "Hugo", customerPhone: "9991230007",
      startsAt: zonedTimeToUtc("2026-10-21", "10:00", MERIDA).toISOString(), source: "web",
    });
    const now = zonedTimeToUtc("2026-10-20", "11:00", MERIDA);
    await Promise.all([runConfirmacionCitaCore(repo, organizationId, now), runConfirmacionCitaCore(repo, organizationId, now)]);
    expect(repo.getOutbox().filter((o) => o.dedupeKey.startsWith(`reminder-24h:${cita.id}:`))).toHaveLength(1);
  });
});
