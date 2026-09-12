// Fixture compartido — seed real (no mockeado) de una property de hotel con su canal
// de WhatsApp configurado, sobre InMemoryHotelesRepository. Mismo criterio que
// domain-restaurantes/tests/fixtures.ts (buildRestaurantFixture).
import { randomUUID } from "node:crypto";
import { InMemoryHotelesRepository } from "../../src/in-memory-repository.ts";

export function buildHotelFixture() {
  const repo = new InMemoryHotelesRepository();
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  repo.seedWhatsAppChannel(propertyId, organizationId, "9876543210");
  return { repo, organizationId, propertyId };
}
