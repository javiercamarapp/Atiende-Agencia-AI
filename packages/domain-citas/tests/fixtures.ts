// Fixture compartido de tests — seed real (no mockeado) de un negocio de citas
// (consultorio dental de un solo proveedor, horario real lunes-viernes 9-17h) sobre
// InMemoryCitasRepository.
import { randomUUID } from "node:crypto";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";

export function buildCitasFixture() {
  const repo = new InMemoryCitasRepository();

  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "clinica-dental-sonrisas", name: "Clínica Dental Sonrisas", defaultTimezone: "America/Merida" });

  const providerId = randomUUID();
  repo.seedProvider({ id: providerId, organizationId, propertyId: null, displayName: "Dra. Fernanda López", roleLabel: "Dentista", isActive: true });

  const serviceId = randomUUID();
  // bufferMinutesAfter=0 a propósito: deja la grilla de slots en múltiplos exactos
  // de 30 min (09:00, 09:30, 10:00, ...) — más fácil de razonar en los tests. El
  // buffer real SÍ se ejercita en el propio suite de availability.spec.ts.
  repo.seedService({ id: serviceId, organizationId, name: "Consulta general", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 50000, isActive: true });
  repo.seedProviderService(providerId, serviceId);

  // Lunes(1) a viernes(5), 9:00-17:00 hora de Mérida.
  for (const dayOfWeek of [1, 2, 3, 4, 5]) {
    repo.seedAvailabilityRule({ id: randomUUID(), providerId, dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true });
  }

  repo.seedWhatsAppConfig(organizationId, "1234567890");

  return { repo, organizationId, providerId, serviceId };
}

/** Próximo lunes real (0=domingo) a partir de `from`, como "YYYY-MM-DD" — para que
 * los tests no dependan de qué día corre la suite. */
export function nextWeekdayDateStr(from: Date, targetWeekday: number): string {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const diff = (targetWeekday - date.getUTCDay() + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}
